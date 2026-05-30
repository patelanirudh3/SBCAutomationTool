package engine

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/rtp"
	"github.com/cci/traffic-engine/internal/sip"
)

const sipTimeout = 20 * time.Second

// startTimerA implements RFC 3261 §17.1.1.2 INVITE-client retransmission.
// On UDP, it spawns a goroutine that fires the retransmit callback at T1,
// doubling the interval each subsequent fire (no cap for INVITE), until
// either:
//   - the returned stop function is called (response received), or
//   - the parent context is cancelled, or
//   - the Timer B deadline passes (transaction will be timed out by the
//     concurrent WaitForSIPEvent call).
//
// On TCP/TLS the helper is a no-op — RFC 3261 §17.1.1.2 specifies that
// reliable transports rely on the transport's own retransmission and Timer A
// is not started.
//
// The returned stop function is safe to call multiple times.
func startTimerA(ctx context.Context, transport string, t1 time.Duration,
	timerBDeadline time.Time, retransmit func() error) func() {
	if !strings.EqualFold(transport, "UDP") {
		return func() {}
	}
	stop := make(chan struct{})
	var once sync.Once
	go func() {
		interval := t1
		for {
			select {
			case <-stop:
				return
			case <-ctx.Done():
				return
			case <-time.After(interval):
				if time.Now().After(timerBDeadline) {
					return
				}
				if err := retransmit(); err != nil {
					slog.Debug("Timer A retransmit failed", "err", err)
					return
				}
				interval *= 2
			}
		}
	}()
	return func() { once.Do(func() { close(stop) }) }
}

// callFailed is a sentinel error used inside executeCall to signal a cleanly
// rejected call (4xx/5xx/6xx final response).
type callFailed struct{ reason string }

func (e *callFailed) Error() string { return e.reason }

// ---------------------------------------------------------------------------
// CallEngine — single-pool CPS-controlled call orchestrator
// ---------------------------------------------------------------------------

// CallEngine fires INVITEs at a configured CPS rate, manages concurrent call
// limits, and drives each call through the full SIP+RTP sequence. Caller/callee
// pairs are drawn from a PoolEngine; users are returned to the pool after
// each call so they can be reused without re-registering.
type CallEngine struct {
	pool       *PoolEngine
	config     *config.VMConfig
	onComplete func(CallResult)
	onAttempt  func()
	maxCalls   int

	StopEvent chan struct{}

	activeCalls     sync.Map // call_id → struct{}
	activeCount     atomic.Int32
	callsAttempted  atomic.Int32
	callsCompleted  atomic.Int32
	callsFailed     atomic.Int32
	peakActiveCalls int32

	metrics MetricsRecorder
}

// CallEngineOption configures optional CallEngine parameters.
type CallEngineOption func(*CallEngine)

// WithPool attaches the PoolEngine for idle/non-idle pair management.
func WithPool(p *PoolEngine) CallEngineOption {
	return func(e *CallEngine) { e.pool = p }
}

// WithOnComplete sets the callback invoked when a call finishes.
func WithOnComplete(fn func(CallResult)) CallEngineOption {
	return func(e *CallEngine) { e.onComplete = fn }
}

// WithOnAttempt sets the callback invoked at each call launch (for CPS metering).
func WithOnAttempt(fn func()) CallEngineOption {
	return func(e *CallEngine) { e.onAttempt = fn }
}

// WithMaxCalls limits total call attempts (0 = unlimited).
func WithMaxCalls(n int) CallEngineOption {
	return func(e *CallEngine) { e.maxCalls = n }
}

// WithMetrics attaches a MetricsRecorder for SIP counter and raw event recording.
func WithMetrics(m MetricsRecorder) CallEngineOption {
	return func(e *CallEngine) { e.metrics = m }
}

// NewCallEngine creates a single-pool call engine.
func NewCallEngine(pool *PoolEngine, cfg *config.VMConfig, opts ...CallEngineOption) *CallEngine {
	e := &CallEngine{
		pool:      pool,
		config:    cfg,
		StopEvent: make(chan struct{}),
	}
	for _, o := range opts {
		o(e)
	}
	return e
}

// ActiveCallCount returns the number of currently in-flight calls.
func (e *CallEngine) ActiveCallCount() int { return int(e.activeCount.Load()) }

// PeakActiveCalls returns the high-water mark of concurrent active calls.
func (e *CallEngine) PeakActiveCalls() int { return int(e.peakActiveCalls) }

// CallsAttempted returns the total number of calls launched so far.
func (e *CallEngine) CallsAttempted() int { return int(e.callsAttempted.Load()) }

// CallsCompleted returns the number of successfully completed calls.
func (e *CallEngine) CallsCompleted() int { return int(e.callsCompleted.Load()) }

// CallsFailed returns the number of failed calls.
func (e *CallEngine) CallsFailed() int { return int(e.callsFailed.Load()) }

// Stop signals the run loop to stop firing new calls.
func (e *CallEngine) Stop() {
	select {
	case <-e.StopEvent:
	default:
		close(e.StopEvent)
	}
}

func (e *CallEngine) stopped() bool {
	select {
	case <-e.StopEvent:
		return true
	default:
		return false
	}
}

// Run is the main call loop. It fires calls at the configured CPS with
// linear ramp-up, respects the max concurrent ceiling, and draws pairs
// from the PoolEngine. It blocks until the engine is stopped or the
// context is cancelled.
func (e *CallEngine) Run(ctx context.Context) error {
	return e.RunWithCallContext(ctx, ctx)
}

// RunWithCallContext separates the launch-loop context from the per-call
// lifecycle context. Timed traffic uses this so duration expiry stops new
// INVITEs but does not cancel already-established calls while they are waiting
// for hold/RTP/BYE/200 completion.
func (e *CallEngine) RunWithCallContext(launchCtx, callCtx context.Context) error {
	cfg := e.config
	fullInterval := time.Duration(float64(time.Second) / float64(cfg.CPS))
	rampSteps := int(math.Max(float64(cfg.RampUpSeconds*cfg.CPS), 1))
	step := 0

	slog.Info("CallEngine starting",
		"cps", cfg.CPS,
		"ramp_up_seconds", cfg.RampUpSeconds,
		"hold_time_seconds", cfg.HoldTimeSeconds,
		"max_concurrent", cfg.EffectiveMaxConcurrent(),
		"max_calls", e.maxCalls,
	)

	var wg sync.WaitGroup

	for {
		select {
		case <-launchCtx.Done():
			slog.Info("call launch context done — draining in-flight calls",
				"active", e.activeCount.Load(),
			)
			drainTimeout := time.Duration(cfg.HoldTimeSeconds+cfg.RegisterTimeout*2+5) * time.Second
			deadline := time.After(drainTimeout)
		drainOnContextDone:
			for e.activeCount.Load() > 0 {
				select {
				case <-deadline:
					slog.Warn("timed-mode drain timed out", "active", e.activeCount.Load())
					break drainOnContextDone
				case <-time.After(200 * time.Millisecond):
				}
			}
			e.Stop()
			wg.Wait()
			return nil
		case <-e.StopEvent:
			wg.Wait()
			return nil
		default:
		}

		attempted := int(e.callsAttempted.Load())

		// Hard call limit
		if e.maxCalls > 0 && attempted >= e.maxCalls {
			slog.Info("max_calls reached — waiting for in-flight calls",
				"max_calls", e.maxCalls,
				"active", e.activeCount.Load(),
			)
			drainTimeout := time.Duration(cfg.HoldTimeSeconds+cfg.RegisterTimeout*2+5) * time.Second
			deadline := time.After(drainTimeout)
		drain:
			for e.activeCount.Load() > 0 {
				select {
				case <-deadline:
					slog.Warn("max_calls drain timed out", "active", e.activeCount.Load())
					break drain
				case <-time.After(200 * time.Millisecond):
				}
			}
			slog.Info("max_calls reached — stopping engine", "max_calls", e.maxCalls)
			e.Stop()
			wg.Wait()
			return nil
		}

		// Max concurrent ceiling
		maxCC := cfg.EffectiveMaxConcurrent()
		if maxCC > 0 && int(e.activeCount.Load()) >= maxCC {
			time.Sleep(50 * time.Millisecond)
			continue
		}

		// Linear ramp-up: interval decreases from fullInterval×10 → fullInterval
		var interval time.Duration
		if step < rampSteps {
			rampFactor := 1.0 + 9.0*(1.0-float64(step)/float64(rampSteps))
			interval = time.Duration(float64(fullInterval) * rampFactor)
			step++
		} else {
			interval = fullInterval
		}

		// Pick a pair from the pool
		caller, callee, ok, stalled := e.pool.NextPair()
		if stalled {
			slog.Warn("PoolEngine permanently stalled — stopping traffic engine")
			e.Stop()
			wg.Wait()
			return nil
		}
		if !ok {
			// Back-pressure: fewer than 2 idle users; wait for returning pairs
			time.Sleep(50 * time.Millisecond)
			continue
		}

		e.callsAttempted.Add(1)
		if e.onAttempt != nil {
			e.onAttempt()
		}

		wg.Add(1)
		go func(ag *agent.ExtensionAgent, calleeAg *agent.ExtensionAgent) {
			defer wg.Done()
			e.executeCall(callCtx, ag, calleeAg)
		}(caller, callee)

		time.Sleep(interval)
	}
}

// executeCall runs a single call through the full SIP+RTP sequence:
//
//	INVITE → 100 → 180 → PRACK → 200 PRACK → 200 INVITE → ACK
//	→ RTP (hold_time) → BYE → 200 BYE
//
// On completion (success or failure) the pair is returned to the PoolEngine.
func (e *CallEngine) executeCall(ctx context.Context, ag *agent.ExtensionAgent, calleeAg *agent.ExtensionAgent) {
	ag.ClearEarlyResponses()

	callStart := time.Now()
	callID := "pending"
	callee := calleeAg.Ext
	var rtpEP *rtp.RtpEndpoint
	milestones := SipMilestones{}
	inviteTsUTC := ""
	cfg := e.config
	added := false

	defer func() {
		if rtpEP != nil {
			rtpEP.Close()
		}
		if added {
			e.activeCalls.Delete(callID)
			e.activeCount.Add(-1)
		}
		ag.RemoveDialog(callID)
		// Return the pair to the pool so both users can be reused.
		e.pool.ReturnPair(ag, calleeAg)
	}()

	emit := func(event string, sipCode int, ms float64, extra map[string]any) {
		emitCallEvent(e.metrics, callID, ag.Ext, event, "uac", callee, sipCode, ms, extra)
	}

	var dialog *agent.DialogState

	// sendCleanupOnTimeout sends the correct cleanup signal when an INVITE
	// transaction times out without a final response.
	//   - If a To-tag is present (180/183 received → early dialog established)
	//     RFC 3261 says the dialog must be torn down with BYE.
	//   - Otherwise (no provisional, or only 100) CANCEL is correct.
	// CANCEL must NEVER be sent in response to a final failure (4xx/5xx/6xx)
	// — those are handled by the dedicated final-failure paths via ACK.
	sendCleanupOnTimeout := func() {
		if dialog == nil {
			return
		}
		if dialog.RemoteTag != "" && dialog.State != "INVITE_SENT" {
			if err := ag.SendBye(dialog); err != nil {
				slog.Warn("BYE send failed", "ext", ag.Ext, "call_id", callID, "err", err)
			} else if e.metrics != nil {
				e.metrics.IncrementSIPCounter("byes_sent")
			}
			return
		}
		if dialog.State == "INVITE_SENT" || dialog.State == "RINGING" || dialog.State == "PROVRESP_RCVD" {
			if err := ag.SendCancel(dialog); err != nil {
				slog.Warn("CANCEL send failed", "ext", ag.Ext, "call_id", callID, "err", err)
			} else if e.metrics != nil {
				e.metrics.IncrementSIPCounter("cancels_sent")
			}
		}
	}

	// tryHandleFinalFailure ACKs a final-failure response (4xx/5xx/6xx)
	// per RFC 3261 §17.1.1.3 and returns true when the response was a
	// non-401/407 final failure. The caller is then expected to fail the
	// call cleanly without sending CANCEL.
	tryHandleFinalFailure := func(raw string) (string, bool) {
		code, _ := sip.ClassifyMessage(raw)
		if !sip.IsFinalFailureCode(code) {
			return code, false
		}
		if err := ag.SendAckForFailure(dialog, raw); err != nil {
			emit("ACK_FINAL_FAILED", atoi(code), 0, map[string]any{"error": err.Error()})
		} else {
			emit("ACK_FINAL_SENT", atoi(code), 0, nil)
		}
		emit("CALL_FAILED", atoi(code), 0, map[string]any{"reason": "final failure"})
		return code, true
	}

	fail := func(reason string) CallResult {
		e.callsFailed.Add(1)
		emit("CALL_FAILED", 0, 0, map[string]any{"reason": reason})

		var rtpTx, rtpRx, rtpRxFromSBC, rtpRxOt, rtcpRx, markersSent, markersRecv, rtpExpected, rtpSSRCCount int
		var srtpDecryptFailures, srtpAuthFailures, srtpReplayFailures int
		var lostPkts, oooPkts int
		var jitterMs, packetLossPct, remoteJitter, remoteLoss, mosScore, rttMs float64
		var mediaOK bool
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
			srtpDecryptFailures = st.SRTPDecryptFailures
			srtpAuthFailures = st.SRTPAuthFailures
			srtpReplayFailures = st.SRTPReplayFailures
			mediaOK = rtpRx > 0
			jitterMs = math.Round(st.JitterMs*100) / 100
			packetLossPct = math.Round(st.PacketLossPct*100) / 100
			lostPkts = st.LostPackets
			oooPkts = st.OOOPackets
			remoteJitter = math.Round(st.RemoteJitterMs*100) / 100
			remoteLoss = math.Round(st.RemoteLossPct*100) / 100
			rttMs = math.Round(st.RTTMs*100) / 100
			if cfg.IsQoSMOSEnabled() && mediaOK {
				mosScore = ComputeMOS(st.PacketLossPct/100.0, st.JitterMs)
			}
		}
		mediaQuality := ClassifyMediaQuality(jitterMs, packetLossPct, mosScore, mediaOK)
		callSetupMs, prackRTTMs, sipTxnRTTMs, byeCompletionMs := DeriveSipTimings(milestones)
		sbcRelayIP, sbcRelayPort := "", 0
		if dialog != nil {
			sbcRelayIP = dialog.RTPRemoteIP
			sbcRelayPort = dialog.RTPRemotePort
		}

		return CallResult{
			CallID:              callID,
			Caller:              ag.Ext,
			Callee:              callee,
			Success:             false,
			FailureReason:       reason,
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
			SBCRTPRelayIP:       sbcRelayIP,
			SBCRTPRelayPort:     sbcRelayPort,
			RTPAsymmetryFlag:    ComputeRTPAsymmetryFlag(rtpTx, rtpRxFromSBC, rtpRx),
			MediaSecurity:       cfg.MediaSecurity,
			SRTPCryptoSuite:     selectedSRTPCryptoSuite(dialog),
			SRTPDecryptFailures: srtpDecryptFailures,
			SRTPAuthFailures:    srtpAuthFailures,
			SRTPReplayFailures:  srtpReplayFailures,
			PeerExt:             callee,
			TsUTC:               inviteTsUTC,
			Direction:           "uac",
			SipMilestones:       milestones,

			JitterMs:            jitterMs,
			PacketLossPct:       packetLossPct,
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
			slog.Warn("RTP socket alloc failed — using port 9", "ext", ag.Ext, "err", err)
		}
	}
	rtpPort := 9
	if rtpEP != nil {
		rtpPort = rtpEP.LocalPort()
	}

	if cfg.RTPPcap && rtpEP != nil {
		rtpEP.EnablePcap(fmt.Sprintf("logs/rtp_uac_%s_%d.pcap", ag.Ext, rtpEP.LocalPort()))
	}

	// ── INVITE ─────────────────────────────────────────────────────
	dialog, err := ag.SendInvite(callee, rtpPort)
	if err != nil {
		result := fail(fmt.Sprintf("send_invite: %v", err))
		e.complete(result)
		return
	}
	callID = dialog.CallID
	e.activeCalls.Store(callID, struct{}{})
	e.activeCount.Add(1)
	added = true
	if peak := e.activeCount.Load(); peak > e.peakActiveCalls {
		e.peakActiveCalls = peak
	}
	inviteTsUTC = time.Now().UTC().Format(time.RFC3339Nano)
	milestones.InviteSentMs = 0.0
	milestones.InviteTsUTC = inviteTsUTC
	if e.metrics != nil {
		e.metrics.IncrementSIPCounter("invites_sent")
	}
	emit("INVITE_SENT", 0, 0.0, map[string]any{"callee": callee})

	// ── RFC 3261 §17.1.1 INVITE client transaction timers ──────────
	// Timer B: overall transaction timeout (default 64*T1 = 32s) covering
	// every wait until the transaction terminates (ACK sent for 2xx, or
	// ACK sent for 3xx/4xx/5xx/6xx). PRACK / BYE waits remain on the
	// existing flat sipTimeout (out of scope per minimal RFC enablement).
	t1 := time.Duration(cfg.T1Ms) * time.Millisecond
	timerB := time.Duration(cfg.TimerBSeconds) * time.Second
	timerBDeadline := time.Now().Add(timerB)
	remainingTimerB := func() time.Duration {
		if rem := time.Until(timerBDeadline); rem > 0 {
			return rem
		}
		return 0
	}
	// Timer A: UDP-only INVITE retransmit. No-op on TCP/TLS.
	stopTimerA := startTimerA(ctx, cfg.SIPTransport, t1, timerBDeadline, func() error {
		if e.metrics != nil {
			e.metrics.IncrementSIPCounter("invite_retransmits")
		}
		return ag.RetransmitInvite(dialog)
	})
	defer stopTimerA()

	// ── Wait for provisional / 407 / final fail ────────────────────
	var raw200 string
	got180 := false
	for !got180 {
		ev, err := ag.WaitForDialogEvent(ctx, callID, remainingTimerB(), "100", "180", "183", "401_INVITE", "407_INVITE", "200_INVITE", "_FINAL_FAIL")
		if err != nil {
			e.callsFailed.Add(1)
			emit("CALL_TIMEOUT", 0, 0, nil)
			sendCleanupOnTimeout()
			result := CallResult{
				CallID: callID, Caller: ag.Ext, Callee: callee,
				Success: false, FailureReason: "timeout",
				TotalMs:         msSince(callStart),
				RTPLocalPort:    rtpLocalPort(rtpEP),
				SIPLocalIP:      ag.LocalHost(),
				SIPLocalPort:    ag.LocalPort(),
				MediaSecurity:   cfg.MediaSecurity,
				SRTPCryptoSuite: selectedSRTPCryptoSuite(dialog),
				PeerExt:         callee, TsUTC: inviteTsUTC, Direction: "uac",
				SipMilestones: milestones,
			}
			e.complete(result)
			return
		}

		// RFC 3261 §17.1.1.2: stop Timer A on first response (1xx or final).
		stopTimerA()

		raw := ev.Raw
		code := ev.Code

		switch {
		case code == "100":
			milestones.Trying100Ms = msSince(callStart)
			emit("TRYING_100", 100, milestones.Trying100Ms, nil)

		case code == "180" || code == "183":
			ag.ParseProvResponse(raw, dialog)
			pdd := dialog.RingingRecvMs - dialog.InviteSentMs
			milestones.Ringing180Ms = msSince(callStart)
			emit("RINGING_180", atoi(code), milestones.Ringing180Ms, map[string]any{"pdd_ms": pdd})
			got180 = true

		case code == "200_INVITE":
			milestones.Ringing180Ms = msSince(callStart)
			emit("RINGING_180", 200, milestones.Ringing180Ms, map[string]any{"pdd_ms": 0})
			raw200 = raw
			got180 = true

		case code == "401_INVITE":
			emit("AUTH_401", 401, 0, nil)
			if err := ag.Handle401Invite(dialog, raw, rtpPort); err != nil {
				result := fail(fmt.Sprintf("401 handling: %v", err))
				e.complete(result)
				return
			}

		case code == "407_INVITE":
			emit("AUTH_407", 407, 0, nil)
			if err := ag.Handle407Invite(dialog, raw, rtpPort); err != nil {
				result := fail(fmt.Sprintf("407 handling: %v", err))
				e.complete(result)
				return
			}

		default:
			if isFinalFailure(code) {
				if err := ag.SendAckForFailure(dialog, raw); err != nil {
					emit("ACK_FINAL_FAILED", atoi(code), 0, map[string]any{"error": err.Error()})
				} else {
					emit("ACK_FINAL_SENT", atoi(code), 0, nil)
				}
				emit("CALL_FAILED", atoi(code), 0, map[string]any{"reason": "final failure"})
				result := fail(fmt.Sprintf("Rejected with %s", code))
				e.complete(result)
				return
			}
		}
	}

	// ── PRACK ──────────────────────────────────────────────────────
	if dialog.IsReliable && dialog.RSeq != 0 {
		if err := ag.SendPrack(dialog); err != nil {
			result := fail(fmt.Sprintf("send_prack: %v", err))
			e.complete(result)
			return
		}
		milestones.PrackSentMs = msSince(callStart)
		emit("PRACK_SENT", 0, milestones.PrackSentMs, nil)

		prackEv, err := ag.WaitForDialogEvent(ctx, callID, sipTimeout, "200_PRACK", "401_PRACK", "407_PRACK", "_FINAL_FAIL")
		if err != nil {
			sendCleanupOnTimeout()
			result := fail("prack_200 timeout")
			e.complete(result)
			return
		}
		rawPrackResp := prackEv.Raw

		prackCode := prackEv.Code
		if sip.IsFinalFailureCode(prackCode) {
			if strings.EqualFold(prackEv.CSeqMethod, "INVITE") {
				if err := ag.SendAckForFailure(dialog, rawPrackResp); err != nil {
					emit("ACK_FINAL_FAILED", atoi(prackCode), 0, map[string]any{"error": err.Error()})
				} else {
					emit("ACK_FINAL_SENT", atoi(prackCode), 0, nil)
				}
				emit("CALL_FAILED", atoi(prackCode), 0, map[string]any{"reason": "final failure"})
				result := fail(fmt.Sprintf("Rejected with %s while awaiting PRACK", prackCode))
				e.complete(result)
				return
			}
			sendCleanupOnTimeout()
			result := fail(fmt.Sprintf("PRACK rejected with %s", prackCode))
			e.complete(result)
			return
		}
		if prackCode == "401_PRACK" {
			emit("PRACK_AUTH_401", 401, 0, nil)
			if err := ag.Handle401Prack(dialog, rawPrackResp); err != nil {
				result := fail(fmt.Sprintf("prack_401_handling: %v", err))
				e.complete(result)
				return
			}
			prackAuthEv, err := ag.WaitForDialogEvent(ctx, callID, sipTimeout, "200_PRACK", "_FINAL_FAIL")
			if err != nil {
				sendCleanupOnTimeout()
				result := fail("prack_200 timeout after auth")
				e.complete(result)
				return
			}
			rawPrackAuth := prackAuthEv.Raw
			if sip.IsFinalFailureCode(prackAuthEv.Code) {
				if strings.EqualFold(prackAuthEv.CSeqMethod, "INVITE") {
					if code, handled := tryHandleFinalFailure(rawPrackAuth); handled {
						result := fail(fmt.Sprintf("Rejected with %s during PRACK auth wait", code))
						e.complete(result)
						return
					}
				}
				sendCleanupOnTimeout()
				result := fail(fmt.Sprintf("PRACK rejected with %s after auth", prackAuthEv.Code))
				e.complete(result)
				return
			}
		}
		if prackCode == "407_PRACK" {
			emit("PRACK_AUTH_407", 407, 0, nil)
			if err := ag.Handle407Prack(dialog, rawPrackResp); err != nil {
				result := fail(fmt.Sprintf("prack_407_handling: %v", err))
				e.complete(result)
				return
			}
			prackAuthEv, err := ag.WaitForDialogEvent(ctx, callID, sipTimeout, "200_PRACK", "_FINAL_FAIL")
			if err != nil {
				sendCleanupOnTimeout()
				result := fail("prack_200 timeout after auth")
				e.complete(result)
				return
			}
			rawPrackAuth := prackAuthEv.Raw
			if sip.IsFinalFailureCode(prackAuthEv.Code) {
				if strings.EqualFold(prackAuthEv.CSeqMethod, "INVITE") {
					if code, handled := tryHandleFinalFailure(rawPrackAuth); handled {
						result := fail(fmt.Sprintf("Rejected with %s during PRACK (after auth)", code))
						e.complete(result)
						return
					}
				}
				sendCleanupOnTimeout()
				result := fail(fmt.Sprintf("PRACK rejected with %s after auth", prackAuthEv.Code))
				e.complete(result)
				return
			}
		}

		milestones.Prack200Ms = msSince(callStart)
		emit("PRACK_200", 200, milestones.Prack200Ms, nil)
	}

	// ── 200 OK to INVITE ───────────────────────────────────────────
	for raw200 == "" {
		okEv, waitErr := ag.WaitForDialogEvent(ctx, callID, remainingTimerB(), "200_INVITE", "401_INVITE", "407_INVITE", "_FINAL_FAIL")
		if waitErr != nil {
			sendCleanupOnTimeout()
			result := fail("200_invite timeout")
			e.complete(result)
			return
		}
		raw200 = okEv.Raw
		if okEv.Code == "401_INVITE" {
			emit("AUTH_401", 401, 0, nil)
			if err := ag.Handle401Invite(dialog, raw200, rtpPort); err != nil {
				result := fail(fmt.Sprintf("401 handling while awaiting 200 INVITE: %v", err))
				e.complete(result)
				return
			}
			raw200 = ""
			continue
		}
		if okEv.Code == "407_INVITE" {
			emit("AUTH_407", 407, 0, nil)
			if err := ag.Handle407Invite(dialog, raw200, rtpPort); err != nil {
				result := fail(fmt.Sprintf("407 handling while awaiting 200 INVITE: %v", err))
				e.complete(result)
				return
			}
			raw200 = ""
			continue
		}
		if code, handled := tryHandleFinalFailure(raw200); handled {
			result := fail(fmt.Sprintf("Rejected with %s while awaiting 200 INVITE", code))
			e.complete(result)
			return
		}
	}
	ag.Parse200Invite(raw200, dialog)
	milestones.Ok200Ms = msSince(callStart)
	emit("OK_200_INVITE", 200, milestones.Ok200Ms, nil)

	if rtpEP != nil && dialog.RTPRemoteIP != "" {
		rtpEP.SetRemoteRTPAddr(dialog.RTPRemoteIP, dialog.RTPRemotePort)
	}

	// ── ACK ────────────────────────────────────────────────────────
	if err := ag.SendAck(dialog); err != nil {
		result := fail(fmt.Sprintf("send_ack: %v", err))
		e.complete(result)
		return
	}
	milestones.AckSentMs = msSince(callStart)
	if e.metrics != nil {
		e.metrics.IncrementSIPCounter("acks_sent")
	}
	emit("ACK_SENT", 0, milestones.AckSentMs, nil)

	if err := configureSRTPForDialog(rtpEP, dialog); err != nil {
		result := fail(fmt.Sprintf("srtp_config: %v", err))
		e.complete(result)
		return
	}

	// ── RTP ────────────────────────────────────────────────────────
	isContinuous := cfg.RTPMode == "continuous"
	isCoverage := cfg.RTPMode == "3phase_coverage"
	if rtpEP != nil {
		milestones.RTPStartMs = msSince(callStart)
		startEvent := "RTP_BURST_START"
		if isContinuous {
			startEvent = "RTP_CONTINUOUS_START"
		} else if isCoverage {
			startEvent = "RTP_COVERAGE_START"
		}
		emit(startEvent, 0, milestones.RTPStartMs, nil)

		if isCoverage {
			rtpEP.RunCoverage(
				ctx,
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
				ctx,
				dialog.RTPRemoteIP,
				dialog.RTPRemotePort,
				float64(cfg.HoldTimeSeconds),
				float64(cfg.RTPBurstSeconds),
				cfg.RTPBurstPPS,
				float64(cfg.RTPKeepaliveInterval),
				isContinuous,
			)
		}

		milestones.RTPEndMs = msSince(callStart)
		endEvent := "RTP_BURST_END"
		if isContinuous {
			endEvent = "RTP_CONTINUOUS_END"
		} else if isCoverage {
			endEvent = "RTP_COVERAGE_END"
		}
		emit(endEvent, 0, milestones.RTPEndMs, nil)
	} else {
		time.Sleep(time.Duration(cfg.HoldTimeSeconds) * time.Second)
	}
	holdMs := msSince(callStart) - milestones.AckSentMs

	// ── BYE ────────────────────────────────────────────────────────
	if err := ag.SendBye(dialog); err != nil {
		result := fail(fmt.Sprintf("send_bye: %v", err))
		e.complete(result)
		return
	}
	milestones.ByeSentMs = msSince(callStart)
	if e.metrics != nil {
		e.metrics.IncrementSIPCounter("byes_sent")
	}
	emit("BYE_SENT", 0, milestones.ByeSentMs, nil)

	byeEv, err := ag.WaitForDialogEvent(ctx, callID, sipTimeout, "200_BYE", "407_BYE")
	if err != nil {
		result := fail("bye_200 timeout")
		e.complete(result)
		return
	}
	byeResp := byeEv.Raw
	if byeCode := byeEv.Code; byeCode == "407_BYE" {
		emit("BYE_AUTH_407", 407, 0, nil)
		if err := ag.Handle407Bye(dialog, byeResp); err != nil {
			result := fail(fmt.Sprintf("bye_407_handling: %v", err))
			e.complete(result)
			return
		}
		if _, err := ag.WaitForDialogEvent(ctx, callID, sipTimeout, "200_BYE"); err != nil {
			result := fail("bye_200 timeout after auth")
			e.complete(result)
			return
		}
	}
	milestones.Bye200Ms = msSince(callStart)
	if e.metrics != nil {
		e.metrics.IncrementSIPCounter("bye_200_received")
	}
	emit("BYE_200", 200, milestones.Bye200Ms, nil)

	if rtpEP != nil {
		time.Sleep(200 * time.Millisecond)
	}

	// ── Talk-path verification ─────────────────────────────────────
	var (
		rtpTx, rtpRx          int
		rtpRxFromSBC, rtpRxOt int
		rtcpRx                int
		markersSent           int
		markersRecv           int
		rtpExpected           int
		rtpSSRCCount          int
		mediaOK               bool
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
		mediaEvent := ClassifyMedia(st, float64(cfg.HoldTimeSeconds))
		milestones.MediaVerifiedMs = msSince(callStart)
		emitCallEvent(e.metrics, callID, ag.Ext, mediaEvent, "uac", callee, 0, milestones.MediaVerifiedMs, map[string]any{
			"rtp_tx_pkts":           rtpTx,
			"rtp_rx_pkts":           rtpRx,
			"rtp_rx_from_sbc_pkts":  rtpRxFromSBC,
			"rtp_rx_other_pkts":     rtpRxOt,
			"rtcp_rx_pkts":          rtcpRx,
			"markers_sent":          markersSent,
			"markers_received":      markersRecv,
			"rtp_expected_pkts":     rtpExpected,
			"rtp_ssrc_count":        rtpSSRCCount,
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

	// ── Call complete ──────────────────────────────────────────────
	totalMs := msSince(callStart)
	pddMs := dialog.RingingRecvMs - dialog.InviteSentMs
	e.callsCompleted.Add(1)

	emit("CALL_COMPLETE", 0, 0, map[string]any{
		"pdd_ms":   math.Round(pddMs*100) / 100,
		"hold_ms":  math.Round(holdMs*100) / 100,
		"total_ms": math.Round(totalMs*100) / 100,
	})

	// ── QoS / Media metrics (Phase 1+2) ────────────────────────────
	var (
		jitterMs            float64
		packetLossPct       float64
		lostPackets         int
		oooPackets          int
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
		jitterMs = math.Round(st.JitterMs*100) / 100
		packetLossPct = math.Round(st.PacketLossPct*100) / 100
		lostPackets = st.LostPackets
		oooPackets = st.OOOPackets
		remoteJitter = math.Round(st.RemoteJitterMs*100) / 100
		remoteLoss = math.Round(st.RemoteLossPct*100) / 100
		rttMs = math.Round(st.RTTMs*100) / 100
		srtpDecryptFailures = st.SRTPDecryptFailures
		srtpAuthFailures = st.SRTPAuthFailures
		srtpReplayFailures = st.SRTPReplayFailures
		if cfg.IsQoSMOSEnabled() && mediaOK {
			mosScore = ComputeMOS(st.PacketLossPct/100.0, st.JitterMs)
		}
	}
	mediaQuality := ClassifyMediaQuality(jitterMs, packetLossPct, mosScore, mediaOK)
	callSetupMs, prackRTTMs, sipTxnRTTMs, byeCompletionMs := DeriveSipTimings(milestones)

	result := CallResult{
		CallID:              callID,
		Caller:              ag.Ext,
		Callee:              callee,
		Success:             true,
		PDDMs:               pddMs,
		HoldMs:              holdMs,
		TotalMs:             totalMs,
		RTPTxPkts:           rtpTx,
		RTPRxPkts:           rtpRx,
		SIPLocalIP:          ag.LocalHost(),
		SIPLocalPort:        ag.LocalPort(),
		MediaVerified:       mediaOK,
		RTPLocalPort:        rtpLocalPort(rtpEP),
		MediaSecurity:       cfg.MediaSecurity,
		SRTPCryptoSuite:     selectedSRTPCryptoSuite(dialog),
		SRTPDecryptFailures: srtpDecryptFailures,
		SRTPAuthFailures:    srtpAuthFailures,
		SRTPReplayFailures:  srtpReplayFailures,
		PeerExt:             callee,
		TsUTC:               inviteTsUTC,
		Direction:           "uac",
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

		JitterMs:         jitterMs,
		PacketLossPct:    packetLossPct,
		LostPackets:      lostPackets,
		OOOPackets:       oooPackets,
		RTTMs:            rttMs,
		RemoteJitterMs:   remoteJitter,
		RemoteLossPct:    remoteLoss,
		MOSScore:         mosScore,
		MediaQualityFlag: mediaQuality,

		CallSetupMs:         callSetupMs,
		PrackRTTMs:          prackRTTMs,
		SipTransactionRTTMs: sipTxnRTTMs,
		ByeCompletionMs:     byeCompletionMs,
	}
	e.complete(result)
}

// DrainActiveCalls sends BYE to every currently established dialog across all
// agents in the pool. Called during graceful/interrupted shutdown.
func (e *CallEngine) DrainActiveCalls(ctx context.Context, timeout time.Duration, allAgents map[string]*agent.ExtensionAgent) error {
	var wg sync.WaitGroup
	for _, ag := range allAgents {
		for _, d := range ag.ActiveDialogsSnapshot() {
			if d.State == "ESTABLISHED" {
				wg.Add(1)
				go func(a *agent.ExtensionAgent, dlg *agent.DialogState) {
					defer wg.Done()
					a.SendBye(dlg)
				}(ag, d)
			}
		}
	}

	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()

	slog.Info("Draining active calls (BYE)", "count", e.activeCount.Load())
	select {
	case <-done:
		return nil
	case <-time.After(timeout):
		slog.Warn("Some BYEs timed out during drain")
		return fmt.Errorf("drain timed out after %v", timeout)
	case <-ctx.Done():
		return ctx.Err()
	}
}

// complete invokes the on-complete callback if set.
func (e *CallEngine) complete(r CallResult) {
	if e.onComplete != nil {
		e.onComplete(r)
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

func rtpLocalPort(ep *rtp.RtpEndpoint) int {
	if ep != nil {
		return ep.LocalPort()
	}
	return 0
}

func selectedSRTPCryptoSuite(dialog *agent.DialogState) string {
	if dialog == nil || len(dialog.SRTPRemoteCrypto.CryptoLines) == 0 {
		return ""
	}
	return dialog.SRTPRemoteCrypto.CryptoLines[0].Suite
}

func configureSRTPForDialog(ep *rtp.RtpEndpoint, dialog *agent.DialogState) error {
	if ep == nil || dialog == nil || dialog.MediaSecurity != "srtp_sdes" {
		return nil
	}
	if len(dialog.SRTPCryptoOffers) == 0 {
		return fmt.Errorf("no local SRTP crypto offer")
	}
	if len(dialog.SRTPRemoteCrypto.CryptoLines) == 0 {
		return fmt.Errorf("no remote SRTP crypto answer")
	}
	remote := dialog.SRTPRemoteCrypto.CryptoLines[0]
	local := dialog.SRTPCryptoOffers[0]
	for _, offer := range dialog.SRTPCryptoOffers {
		if offer.Suite == remote.Suite {
			local = offer
			break
		}
	}
	remoteKeySalt, err := decodeSDESInlineKeySalt(remote.KeyParams)
	if err != nil {
		return err
	}
	return ep.ConfigureSRTP(rtp.SRTPSessionConfig{
		Enabled:         true,
		CryptoSuite:     local.Suite,
		OutboundKeySalt: local.KeySalt,
		InboundKeySalt:  remoteKeySalt,
	})
}

func decodeSDESInlineKeySalt(params string) ([]byte, error) {
	if !strings.HasPrefix(params, "inline:") {
		return nil, fmt.Errorf("unsupported SRTP key params %q", params)
	}
	raw := strings.TrimPrefix(params, "inline:")
	if idx := strings.IndexByte(raw, '|'); idx >= 0 {
		raw = raw[:idx]
	}
	keySalt, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("decode SRTP inline key: %w", err)
	}
	return keySalt, nil
}

func atoi(s string) int {
	n := 0
	for _, c := range s {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		}
	}
	return n
}

func isFinalFailure(code string) bool {
	if len(code) != 3 {
		return false
	}
	switch code[0] {
	case '4', '5', '6':
		return true
	}
	return false
}
