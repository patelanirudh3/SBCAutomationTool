package engine

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/rtp"
)

// uasSIPTimeout is the signalling timeout for UAS operations (Timer H — ACK
// wait).  Matches UAC sipTimeout and stays below Kamailio fr_timer (30 s).
const uasSIPTimeout = 20 * time.Second

// ---------------------------------------------------------------------------
// UasAutoAnswer — UAS-side auto-answer engine
// ---------------------------------------------------------------------------

// UasAutoAnswer runs auto-answer loops for every UAS extension agent.
// On each inbound INVITE it drives the full UAS SIP+RTP sequence:
//
//	INVITE → 100+180 → wait PRACK → 200 PRACK → 200 OK
//	→ wait ACK → RTP (until BYE) → 200 BYE
type UasAutoAnswer struct {
	agents     map[string]*agent.ExtensionAgent
	config     *config.VMConfig
	onComplete func(CallResult)
	metrics    MetricsRecorder
	StopEvent  chan struct{}
	wg         sync.WaitGroup
}

// UasOption configures optional UasAutoAnswer parameters.
type UasOption func(*UasAutoAnswer)

// WithUasOnComplete sets the callback invoked when a UAS call finishes.
func WithUasOnComplete(fn func(CallResult)) UasOption {
	return func(u *UasAutoAnswer) { u.onComplete = fn }
}

// WithUasMetrics attaches a MetricsRecorder.
func WithUasMetrics(m MetricsRecorder) UasOption {
	return func(u *UasAutoAnswer) { u.metrics = m }
}

// NewUasAutoAnswer creates a UAS auto-answer engine.
func NewUasAutoAnswer(agents map[string]*agent.ExtensionAgent, cfg *config.VMConfig, opts ...UasOption) *UasAutoAnswer {
	u := &UasAutoAnswer{
		agents:    agents,
		config:    cfg,
		StopEvent: make(chan struct{}),
	}
	for _, o := range opts {
		o(u)
	}
	return u
}

// Start launches an auto-answer goroutine for every UAS agent.
func (u *UasAutoAnswer) Start(ctx context.Context) error {
	for _, ag := range u.agents {
		u.wg.Add(1)
		go func(a *agent.ExtensionAgent) {
			defer u.wg.Done()
			u.uasLoop(ctx, a)
		}(ag)
	}
	slog.Info("UAS auto-answer started", "extensions", len(u.agents))
	return nil
}

// Stop signals all UAS loops to exit and waits for them to finish.
func (u *UasAutoAnswer) Stop() error {
	select {
	case <-u.StopEvent:
	default:
		close(u.StopEvent)
	}
	u.wg.Wait()
	return nil
}

func (u *UasAutoAnswer) stopped() bool {
	select {
	case <-u.StopEvent:
		return true
	default:
		return false
	}
}

// uasLoop listens for INVITE events on the agent's wildcard queue and spawns
// a handleCall goroutine for each one. It checks AutoAnswerEnabled() before
// spawning to avoid answering calls when the agent has been selected as a caller.
func (u *UasAutoAnswer) uasLoop(ctx context.Context, ag *agent.ExtensionAgent) {
	u.uasLoopWithStop(ctx, ag, nil, nil)
}

// uasLoopWithStop is the internal loop; stopCh (if non-nil) allows stopping
// a single agent's loop independently from the global StopEvent.
func (u *UasAutoAnswer) uasLoopWithStop(ctx context.Context, ag *agent.ExtensionAgent, stopCh <-chan struct{}, ready chan<- struct{}) {
	wq := ag.RegisterWildcardListener()
	if ready != nil {
		close(ready)
	}
	defer ag.DeregisterWildcardListener(wq)

	for {
		if u.stopped() {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-u.StopEvent:
			return
		default:
		}
		if stopCh != nil {
			select {
			case <-stopCh:
				return
			default:
			}
		}

		code, rawMsg, err := ag.WaitWildcard(ctx, wq, 1*time.Second)
		if err != nil {
			continue
		}
		// Double-check: only answer if this agent is still in auto-answer mode.
		// This guards against the narrow window between NextPair() returning and
		// the flag being set to false (which should not occur since the flag is
		// set inside the NextPair lock, but provides defence in depth).
		if code == "INVITE" && ag.AutoAnswerEnabled() {
			u.wg.Add(1)
			go func(raw string) {
				defer u.wg.Done()
				u.handleCall(ctx, ag, raw)
			}(rawMsg)
		}
	}
}

// StartAutoAnswerForAgent starts an independent auto-answer loop for a single
// agent. Called for every agent that successfully completes Reg+Sub during
// pre-phase. Returns a stop function that terminates only this agent's loop.
func (u *UasAutoAnswer) StartAutoAnswerForAgent(ctx context.Context, ag *agent.ExtensionAgent) func() {
	stop, _ := u.StartAutoAnswerForAgentReady(ctx, ag)
	return stop
}

// StartAutoAnswerForAgentReady starts a per-agent UAS loop and returns a ready
// channel that is closed after the wildcard listener is registered. Callers use
// this to ensure a UAS agent is not added to the callee pool before inbound
// INVITEs can be observed.
func (u *UasAutoAnswer) StartAutoAnswerForAgentReady(ctx context.Context, ag *agent.ExtensionAgent) (func(), <-chan struct{}) {
	stopCh := make(chan struct{})
	ready := make(chan struct{})
	u.wg.Add(1)
	go func() {
		defer u.wg.Done()
		u.uasLoopWithStop(ctx, ag, stopCh, ready)
	}()
	stop := func() {
		select {
		case <-stopCh:
		default:
			close(stopCh)
		}
	}
	return stop, ready
}

// handleCall runs the full UAS SIP+RTP sequence for one inbound call.
func (u *UasAutoAnswer) handleCall(ctx context.Context, ag *agent.ExtensionAgent, rawInvite string) {
	ag.ClearEarlyResponses()

	callStart := time.Now()
	callID := "pending"
	timeout := uasSIPTimeout
	var rtpEP *rtp.RtpEndpoint
	var rtpCancel context.CancelFunc
	milestones := SipMilestones{}
	uasInviteTsUTC := ""
	callerExt := ""
	cfg := u.config

	defer func() {
		if rtpEP != nil {
			if rtpCancel != nil {
				rtpCancel()
			}
			rtpEP.Close()
		}
	}()

	emit := func(event string, sipCode int, ms float64, extra map[string]any) {
		emitCallEvent(u.metrics, callID, ag.Ext, event, "uas", callerExt, sipCode, ms, extra)
	}

	// ── Allocate RTP endpoint ──────────────────────────────────────
	if cfg.MediaEnabled {
		var err error
		rtpEP, err = rtp.NewRtpEndpointFull(
			ag.LocalHost(),
			cfg.RTPPtime,
			cfg.IsQoSEnabled(),
			cfg.IsRTCPSREnabled(),
			time.Duration(cfg.RTCPSRIntervalSeconds)*time.Second,
		)
		if err != nil {
			slog.Warn("RTP endpoint alloc failed — using port 9",
				"ext", ag.Ext, "err", err)
		}
	}
	rtpPort := 9
	if rtpEP != nil {
		rtpPort = rtpEP.LocalPort()
	}

	if cfg.RTPPcap && rtpEP != nil {
		rtpEP.EnablePcap(fmt.Sprintf("logs/rtp_uas_%s_%d.pcap", ag.Ext, rtpEP.LocalPort()))
	}

	// ── Handle INVITE: sends 100 + 180 ─────────────────────────────
	dialog, err := ag.HandleIncomingInvite(rawInvite)
	if err != nil {
		slog.Error("UAS handle invite failed", "ext", ag.Ext, "err", err)
		return
	}
	callID = dialog.CallID

	// Extract caller extension from From header
	for _, line := range strings.Split(rawInvite, "\r\n") {
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "from:") && strings.Contains(line, "sip:") {
			idx := strings.Index(line, "sip:") + 4
			callerExt = strings.SplitN(line[idx:], "@", 2)[0]
			break
		}
	}

	uasInviteTsUTC = time.Now().UTC().Format(time.RFC3339Nano)
	milestones.InviteReceivedMs = 0.0
	milestones.UASInviteTsUTC = uasInviteTsUTC
	offset := msSince(callStart)
	milestones.Trying100SentMs = offset
	milestones.Ringing180SentMs = offset
	if u.metrics != nil {
		u.metrics.IncrementSIPCounter("invites_received")
	}
	emit("UAS_INVITE_RECEIVED", 0, 0.0, nil)
	emit("UAS_TRYING_100_SENT", 100, milestones.Trying100SentMs, nil)
	emit("UAS_RINGING_180_SENT", 180, milestones.Ringing180SentMs, nil)

	if rtpEP != nil && dialog.RTPRemoteIP != "" {
		rtpEP.SetRemoteRTPAddr(dialog.RTPRemoteIP, dialog.RTPRemotePort)
	}

	// ── Wait for PRACK (only when UAS advertised 100rel in its 180) ──
	if dialog.IsReliable {
		rawPrack, err := ag.WaitForSIPEvent(ctx, timeout, "PRACK")
		if err != nil {
			u.handleTimeout(ag, dialog, callStart, callID, callerExt, rtpEP, milestones, uasInviteTsUTC)
			return
		}
		milestones.PrackReceivedMs = msSince(callStart)
		emit("UAS_PRACK_RECEIVED", 0, milestones.PrackReceivedMs, nil)

		if err := ag.HandlePrack(rawPrack, dialog); err != nil {
			slog.Error("UAS handle PRACK failed", "ext", ag.Ext, "err", err)
			return
		}
		milestones.Prack200SentMs = msSince(callStart)
		emit("UAS_200_PRACK_SENT", 200, milestones.Prack200SentMs, nil)
	}

	// ── 200 OK to INVITE ───────────────────────────────────────────
	if err := ag.Send200Invite(dialog, rtpPort); err != nil {
		slog.Error("UAS send 200 OK failed", "ext", ag.Ext, "err", err)
		return
	}
	milestones.Ok200SentMs = msSince(callStart)
	emit("UAS_200_OK_SENT", 200, milestones.Ok200SentMs, nil)

	// ── Wait for ACK ───────────────────────────────────────────────
	if _, err := ag.WaitForSIPEvent(ctx, timeout, "ACK"); err != nil {
		u.handleTimeout(ag, dialog, callStart, callID, callerExt, rtpEP, milestones, uasInviteTsUTC)
		return
	}
	dialog.State = "ESTABLISHED"
	milestones.AckReceivedMs = msSince(callStart)
	if u.metrics != nil {
		u.metrics.IncrementSIPCounter("acks_received")
	}
	emit("UAS_ACK_RECEIVED", 0, milestones.AckReceivedMs, nil)

	if err := configureSRTPForDialog(rtpEP, dialog); err != nil {
		slog.Error("UAS SRTP config failed", "ext", ag.Ext, "call_id", callID, "err", err)
		u.handleTimeout(ag, dialog, callStart, callID, callerExt, rtpEP, milestones, uasInviteTsUTC)
		return
	}

	// ── Start RTP (safety cap = 2× hold_time; real stop via rtpCancel on BYE) ──
	var rtpDone chan struct{}
	if rtpEP != nil {
		rtpDone = make(chan struct{})
		var rtpCtx context.Context
		rtpCtx, rtpCancel = context.WithCancel(ctx)
		safetyCap := float64(cfg.HoldTimeSeconds) * 2
		go func() {
			defer close(rtpDone)
			if cfg.RTPMode == "3phase_coverage" {
				rtpEP.RunCoverageUntilCancelled(
					rtpCtx,
					dialog.RTPRemoteIP,
					dialog.RTPRemotePort,
					float64(cfg.HoldTimeSeconds),
					cfg.RTPBurstPPS,
					rtp.CoverageOptions{
						MediaCoveragePct:   cfg.RTPMediaCoveragePct,
						StartBurstSharePct: cfg.RTPStartBurstSharePct,
						EndBurstSharePct:   cfg.RTPEndBurstSharePct,
						MidBurstSeconds:    cfg.RTPMidBurstSeconds,
						KeepaliveEnabled:   cfg.IsRTPCoverageKeepaliveEnabled(),
						KeepalivePPS:       cfg.RTPCoverageKeepalivePPS,
					},
				)
			} else {
				rtpEP.Run(
					rtpCtx,
					dialog.RTPRemoteIP,
					dialog.RTPRemotePort,
					safetyCap,
					float64(cfg.RTPBurstSeconds),
					cfg.RTPBurstPPS,
					float64(cfg.RTPKeepaliveInterval),
					cfg.RTPMode == "continuous",
				)
			}
		}()
	}

	// ── Wait for BYE ───────────────────────────────────────────────
	holdTimeout := time.Duration(cfg.HoldTimeSeconds)*time.Second + uasSIPTimeout + 5*time.Second
	rawBye, err := ag.WaitForSIPEvent(ctx, holdTimeout, "BYE")
	if err != nil {
		// Cancel RTP before handling timeout
		if rtpCancel != nil {
			rtpCancel()
		}
		if rtpDone != nil {
			<-rtpDone
		}
		u.handleTimeout(ag, dialog, callStart, callID, callerExt, rtpEP, milestones, uasInviteTsUTC)
		return
	}
	milestones.ByeReceivedMs = msSince(callStart)
	if u.metrics != nil {
		u.metrics.IncrementSIPCounter("byes_received")
	}
	emit("UAS_BYE_RECEIVED", 0, milestones.ByeReceivedMs, nil)

	if err := ag.HandleBye(rawBye, dialog); err != nil {
		slog.Error("UAS handle BYE failed", "ext", ag.Ext, "err", err)
	}
	// Register the completed dialog as a zombie for 60s so that any late
	// duplicate INVITE with this Call-ID is rejected (defence in depth for
	// TCP/TLS; stale retransmits are theoretically impossible on reliable
	// transports but this costs nothing).
	ag.RegisterZombie(dialog, 60*time.Second)
	milestones.Bye200SentMs = msSince(callStart)
	if u.metrics != nil {
		u.metrics.IncrementSIPCounter("bye_200_sent")
	}
	emit("UAS_200_BYE_SENT", 200, milestones.Bye200SentMs, nil)

	// ── Cancel RTP and collect stats ────────────────────────────────
	if rtpCancel != nil {
		rtpCancel()
	}
	if rtpDone != nil {
		<-rtpDone
	}

	var (
		rtpTx, rtpRx          int
		rtpRxFromSBC, rtpRxOt int
		rtcpRx                int
		markersSent           int
		markersRecv           int
		rtpExpected           int
		rtpSSRCCount          int
		mediaOK               bool

		jitterMs            float64
		packetLoss          float64
		lostPkts            int
		oooPkts             int
		remoteJitter        float64
		remoteLoss          float64
		mosScore            float64
		rttMs               float64
		srtpDecryptFailures int
		srtpAuthFailures    int
		srtpReplayFailures  int
	)
	if rtpEP != nil {
		st := rtpEP.Stats()
		rtpTx = rtpEP.TxPkts()
		rtpRx = st.RTPRxPkts
		rtpRxFromSBC = st.RTPRxFromSBC
		rtpRxOt = st.RTPRxOther
		rtcpRx = st.RTCPRxPkts
		markersSent = rtpEP.MarkersSent()
		markersRecv = st.MarkersReceived
		rtpExpected = st.ExpectedPackets
		rtpSSRCCount = st.SSRCCount
		mediaOK = rtpRx > 0

		jitterMs = math.Round(st.JitterMs*100) / 100
		packetLoss = math.Round(st.PacketLossPct*100) / 100
		lostPkts = st.LostPackets
		oooPkts = st.OOOPackets
		remoteJitter = math.Round(st.RemoteJitterMs*100) / 100
		remoteLoss = math.Round(st.RemoteLossPct*100) / 100
		rttMs = math.Round(st.RTTMs*100) / 100
		srtpDecryptFailures = st.SRTPDecryptFailures
		srtpAuthFailures = st.SRTPAuthFailures
		srtpReplayFailures = st.SRTPReplayFailures
		if cfg.IsQoSMOSEnabled() && mediaOK {
			mosScore = ComputeMOS(st.PacketLossPct/100.0, st.JitterMs)
		}

		mediaEvent := ClassifyMedia(st, float64(cfg.HoldTimeSeconds))
		emitCallEvent(u.metrics, callID, ag.Ext, mediaEvent, "uas", callerExt, 0, 0, map[string]any{
			"rtp_tx_pkts":           rtpTx,
			"rtp_rx_pkts":           rtpRx,
			"rtp_rx_from_sbc_pkts":  rtpRxFromSBC,
			"rtp_rx_other_pkts":     rtpRxOt,
			"rtcp_rx_pkts":          rtcpRx,
			"markers_sent":          markersSent,
			"markers_received":      markersRecv,
			"rtp_expected_pkts":     rtpExpected,
			"rtp_ssrc_count":        rtpSSRCCount,
			"jitter_ms":             jitterMs,
			"packet_loss_pct":       packetLoss,
			"mos_score":             mosScore,
			"media_security":        cfg.MediaSecurity,
			"srtp_crypto_suite":     selectedSRTPCryptoSuite(dialog),
			"srtp_decrypt_failures": st.SRTPDecryptFailures,
			"srtp_auth_failures":    st.SRTPAuthFailures,
			"srtp_replay_failures":  st.SRTPReplayFailures,
		})
	}

	if !cfg.MediaEnabled {
		emit("MEDIA_DISABLED", 0, 0, nil)
	}

	mediaQuality := ClassifyMediaQuality(jitterMs, packetLoss, mosScore, mediaOK)
	callSetupMs, prackRTTMs, sipTxnRTTMs, byeCompletionMs := DeriveSipTimings(milestones)

	totalMs := msSince(callStart)
	result := CallResult{
		CallID:              callID,
		Caller:              callerOrRemote(callerExt),
		Callee:              ag.Ext,
		Success:             true,
		TotalMs:             totalMs,
		RTPTxPkts:           rtpTx,
		RTPRxPkts:           rtpRx,
		SIPLocalIP:          ag.LocalHost(),
		SIPLocalPort:        ag.LocalPort(),
		MediaVerified:       mediaOK,
		RTPLocalPort:        rtpLocalPort(rtpEP),
		MediaSecurity:       u.config.MediaSecurity,
		SRTPCryptoSuite:     selectedSRTPCryptoSuite(dialog),
		SRTPDecryptFailures: srtpDecryptFailures,
		SRTPAuthFailures:    srtpAuthFailures,
		SRTPReplayFailures:  srtpReplayFailures,
		PeerExt:             callerExt,
		TsUTC:               uasInviteTsUTC,
		Direction:           "uas",
		SBCRTPRelayIP:       dialog.RTPRemoteIP,
		SBCRTPRelayPort:     dialog.RTPRemotePort,
		SipMilestones:       milestones,
		RTPRxFromSBCPkts:    rtpRxFromSBC,
		RTPRxOtherPkts:      rtpRxOt,
		RTCPRxPkts:          rtcpRx,
		RTPAsymmetryFlag:    ComputeRTPAsymmetryFlag(rtpTx, rtpRxFromSBC, rtpRx),
		MarkersSent:         markersSent,
		MarkersReceived:     markersRecv,
		RTPExpectedPkts:     rtpExpected,
		RTPSSRCCount:        rtpSSRCCount,

		JitterMs:            jitterMs,
		PacketLossPct:       packetLoss,
		LostPackets:         lostPkts,
		OOOPackets:          oooPkts,
		RTTMs:               rttMs,
		RemoteJitterMs:      remoteJitter,
		RemoteLossPct:       remoteLoss,
		MOSScore:            mosScore,
		MediaQualityFlag:    mediaQuality,
		CallSetupMs:         callSetupMs,
		PrackRTTMs:          prackRTTMs,
		SipTransactionRTTMs: sipTxnRTTMs,
		ByeCompletionMs:     byeCompletionMs,
	}
	emit("UAS_CALL_COMPLETE", 0, 0, map[string]any{
		"total_ms": math.Round(totalMs*100) / 100,
	})
	u.complete(result)
}

// handleTimeout registers a zombie dialog and produces a failed CallResult
// when a UAS signalling step times out.
func (u *UasAutoAnswer) handleTimeout(
	ag *agent.ExtensionAgent,
	dialog *agent.DialogState,
	callStart time.Time,
	callID, callerExt string,
	rtpEP *rtp.RtpEndpoint,
	milestones SipMilestones,
	uasInviteTsUTC string,
) {
	emitCallEvent(u.metrics, callID, ag.Ext, "UAS_CALL_TIMEOUT", "uas", callerExt, 0, 0, nil)

	if dialog != nil {
		ag.RemoveDialog(dialog.CallID)
		ag.RegisterZombie(dialog, 120*time.Second)
	}

	var (
		rtpTx, rtpRx          int
		rtpRxFromSBC, rtpRxOt int
		rtcpRx                int
		markersSent           int
		markersRecv           int
		rtpExpected           int
		rtpSSRCCount          int
		mediaOK               bool

		jitterMs            float64
		packetLoss          float64
		lostPkts            int
		oooPkts             int
		remoteJitter        float64
		remoteLoss          float64
		mosScore            float64
		rttMs               float64
		srtpDecryptFailures int
		srtpAuthFailures    int
		srtpReplayFailures  int
	)
	if rtpEP != nil {
		st := rtpEP.Stats()
		rtpTx = rtpEP.TxPkts()
		rtpRx = st.RTPRxPkts
		rtpRxFromSBC = st.RTPRxFromSBC
		rtpRxOt = st.RTPRxOther
		rtcpRx = st.RTCPRxPkts
		markersSent = rtpEP.MarkersSent()
		markersRecv = st.MarkersReceived
		rtpExpected = st.ExpectedPackets
		rtpSSRCCount = st.SSRCCount
		mediaOK = rtpRx > 0
		jitterMs = math.Round(st.JitterMs*100) / 100
		packetLoss = math.Round(st.PacketLossPct*100) / 100
		lostPkts = st.LostPackets
		oooPkts = st.OOOPackets
		remoteJitter = math.Round(st.RemoteJitterMs*100) / 100
		remoteLoss = math.Round(st.RemoteLossPct*100) / 100
		rttMs = math.Round(st.RTTMs*100) / 100
		srtpDecryptFailures = st.SRTPDecryptFailures
		srtpAuthFailures = st.SRTPAuthFailures
		srtpReplayFailures = st.SRTPReplayFailures
		if u.config.IsQoSMOSEnabled() && mediaOK {
			mosScore = ComputeMOS(st.PacketLossPct/100.0, st.JitterMs)
		}
	}
	sbcRelayIP, sbcRelayPort := "", 0
	if dialog != nil {
		sbcRelayIP = dialog.RTPRemoteIP
		sbcRelayPort = dialog.RTPRemotePort
	}
	mediaQuality := ClassifyMediaQuality(jitterMs, packetLoss, mosScore, mediaOK)
	callSetupMs, prackRTTMs, sipTxnRTTMs, byeCompletionMs := DeriveSipTimings(milestones)

	result := CallResult{
		CallID:              callID,
		Caller:              callerOrRemote(callerExt),
		Callee:              ag.Ext,
		Success:             false,
		FailureReason:       "timeout",
		TotalMs:             msSince(callStart),
		RTPLocalPort:        rtpLocalPort(rtpEP),
		RTPTxPkts:           rtpTx,
		RTPRxPkts:           rtpRx,
		SIPLocalIP:          ag.LocalHost(),
		SIPLocalPort:        ag.LocalPort(),
		MediaVerified:       mediaOK,
		RTPRxFromSBCPkts:    rtpRxFromSBC,
		RTPRxOtherPkts:      rtpRxOt,
		RTCPRxPkts:          rtcpRx,
		MarkersSent:         markersSent,
		MarkersReceived:     markersRecv,
		RTPExpectedPkts:     rtpExpected,
		RTPSSRCCount:        rtpSSRCCount,
		MediaSecurity:       u.config.MediaSecurity,
		SRTPCryptoSuite:     selectedSRTPCryptoSuite(dialog),
		SRTPDecryptFailures: srtpDecryptFailures,
		SRTPAuthFailures:    srtpAuthFailures,
		SRTPReplayFailures:  srtpReplayFailures,
		SBCRTPRelayIP:       sbcRelayIP,
		SBCRTPRelayPort:     sbcRelayPort,
		RTPAsymmetryFlag:    ComputeRTPAsymmetryFlag(rtpTx, rtpRxFromSBC, rtpRx),
		PeerExt:             callerExt,
		TsUTC:               uasInviteTsUTC,
		Direction:           "uas",
		SipMilestones:       milestones,

		JitterMs:            jitterMs,
		PacketLossPct:       packetLoss,
		LostPackets:         lostPkts,
		OOOPackets:          oooPkts,
		RTTMs:               rttMs,
		RemoteJitterMs:      remoteJitter,
		RemoteLossPct:       remoteLoss,
		MOSScore:            mosScore,
		MediaQualityFlag:    mediaQuality,
		CallSetupMs:         callSetupMs,
		PrackRTTMs:          prackRTTMs,
		SipTransactionRTTMs: sipTxnRTTMs,
		ByeCompletionMs:     byeCompletionMs,
	}
	u.complete(result)
}

// complete invokes the on-complete callback if set.
func (u *UasAutoAnswer) complete(r CallResult) {
	if u.onComplete != nil {
		u.onComplete(r)
	}
}

func callerOrRemote(ext string) string {
	if ext != "" {
		return ext
	}
	return "remote"
}
