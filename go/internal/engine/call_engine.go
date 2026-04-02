package engine

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/rtp"
	"github.com/cci/traffic-engine/internal/sip"
)

const sipTimeout = 20 * time.Second

// sipByeBuffer is the constant BYE RTT + SBC dialog cleanup allowance
// used in the pool wrap delay formula.  Internal, not user-configurable.
const sipByeBuffer = 2.0

// callFailed is a sentinel error used inside executeCall to signal a cleanly
// rejected call (4xx/5xx/6xx final response).
type callFailed struct{ reason string }

func (e *callFailed) Error() string { return e.reason }

// ---------------------------------------------------------------------------
// CallEngine — UAC-side CPS-controlled call orchestrator
// ---------------------------------------------------------------------------

// CallEngine fires INVITEs at a configured CPS rate, manages concurrent call
// limits, pool-wrap delays, linear ramp-up, and drives each call through the
// full SIP+RTP sequence.
type CallEngine struct {
	agents     map[string]*agent.ExtensionAgent
	config     *config.VMConfig
	onComplete func(CallResult)
	onAttempt  func()
	maxCalls   int
	index      int

	StopEvent chan struct{}

	activeCalls   sync.Map // set of call_id → struct{}
	activeCount   atomic.Int32
	callsAttempted atomic.Int32
	callsCompleted atomic.Int32
	callsFailed    atomic.Int32
	peakActiveCalls int32

	currentWrapStartTime atomic.Int64 // nanosecond monotonic timestamp

	metrics MetricsRecorder
}

// CallEngineOption configures optional CallEngine parameters.
type CallEngineOption func(*CallEngine)

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

// NewCallEngine creates a UAC call engine.
func NewCallEngine(agents map[string]*agent.ExtensionAgent, cfg *config.VMConfig, opts ...CallEngineOption) *CallEngine {
	e := &CallEngine{
		agents:    agents,
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

// Run is the main UAC loop.  It fires calls at the configured CPS with
// linear ramp-up, respects the max concurrent ceiling, and applies pool wrap
// delays.  It blocks until the engine is stopped or the context is cancelled.
func (e *CallEngine) Run(ctx context.Context) error {
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
		case <-ctx.Done():
			wg.Wait()
			return ctx.Err()
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
					slog.Warn("max_calls drain timed out",
						"active", e.activeCount.Load(),
					)
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

	// Pool wrap delay
	poolCount := cfg.PoolWrapCount()
	if poolCount > 0 && attempted > 0 && attempted%poolCount == 0 {
		wrapTime := float64(poolCount) / math.Max(float64(cfg.CPS), 0.001)
			holdTime := float64(cfg.HoldTimeSeconds)
			extraMargin := float64(cfg.PoolWrapDelaySeconds)

			wrapStartNano := e.currentWrapStartTime.Load()
			elapsed := float64(time.Since(time.Unix(0, wrapStartNano)).Nanoseconds()) / 1e9
			sleepFor := math.Max(0, holdTime+sipByeBuffer+extraMargin-elapsed)

			natural := wrapTime >= holdTime+sipByeBuffer

			if sleepFor > 0 {
				slog.Info("Pool wrap delay: sleeping",
					"sleep_s", sleepFor,
					"wrap", attempted/poolCount+1,
					"wrap_time_s", wrapTime,
					"hold_s", holdTime,
					"natural", natural,
				)
				time.Sleep(time.Duration(sleepFor * float64(time.Second)))
			} else if !natural {
				slog.Debug("Pool wrap boundary: no sleep needed",
					"wrap", attempted/poolCount+1,
					"elapsed_s", elapsed,
					"hold_s", holdTime,
					"buffer_s", sipByeBuffer,
				)
			}
			e.currentWrapStartTime.Store(time.Now().UnixNano())
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

		caller, callee := e.nextPair()
		ag, ok := e.agents[fmt.Sprintf("%d", caller)]
		if !ok {
			slog.Error("No agent for extension", "ext", caller)
			time.Sleep(interval)
			continue
		}

		if attempted == 0 {
			e.currentWrapStartTime.Store(time.Now().UnixNano())
		}
		e.callsAttempted.Add(1)
		if e.onAttempt != nil {
			e.onAttempt()
		}

		wrapIdx := 0
		if poolCount := cfg.PoolWrapCount(); poolCount > 0 {
			wrapIdx = (int(e.callsAttempted.Load()) - 1) / poolCount
		}

		wg.Add(1)
		go func(ag *agent.ExtensionAgent, callee string, wrapIdx int) {
			defer wg.Done()
			e.executeCall(ctx, ag, callee, wrapIdx)
		}(ag, fmt.Sprintf("%d", callee), wrapIdx)

		time.Sleep(interval)
	}
}

// nextPair returns the next (caller_ext, callee_ext) pair.  UAC and UAS pools
// cycle independently — no 1:1 binding.
func (e *CallEngine) nextPair() (caller, callee int) {
	cfg := e.config
	caller = cfg.UACExtStart + (e.index % cfg.UACExtCount())
	callee = cfg.UASExtStart + (e.index % cfg.UASExtCount())
	e.index++
	return
}

// executeCall runs a single UAC call through the full SIP+RTP sequence:
//
//	INVITE → 100 → 180 → PRACK → 200 PRACK → 200 INVITE → ACK
//	→ RTP (hold_time) → BYE → 200 BYE
//
// It handles 407 re-INVITE with auth, final failure codes (4xx/5xx/6xx → ACK + fail),
// timeouts (→ CANCEL), and RTP allocation failures (degrade to port 9).
func (e *CallEngine) executeCall(ctx context.Context, ag *agent.ExtensionAgent, callee string, poolWrapIndex int) {
	callStart := time.Now()
	callID := "pending"
	var rtpEP *rtp.RtpEndpoint
	milestones := SipMilestones{}
	inviteTsUTC := ""
	cfg := e.config

	defer func() {
		if rtpEP != nil {
			rtpEP.Close()
		}
		e.activeCalls.Delete(callID)
		e.activeCount.Add(-1)
		ag.RemoveDialog(callID)
	}()

	emit := func(event string, sipCode int, ms float64, extra map[string]any) {
		emitCallEvent(e.metrics, callID, ag.Ext, event, "uac", callee, sipCode, ms, extra)
	}

	fail := func(reason string) CallResult {
		e.callsFailed.Add(1)
		emit("CALL_FAILED", 0, 0, map[string]any{"reason": reason})
		return CallResult{
			CallID: callID, Caller: ag.Ext, Callee: callee,
			Success: false, FailureReason: reason,
			TotalMs:       msSince(callStart),
			RTPLocalPort:  rtpLocalPort(rtpEP),
			PoolWrapIndex: poolWrapIndex,
			PeerExt: callee, TsUTC: inviteTsUTC, Direction: "uac",
			SipMilestones: milestones,
		}
	}

	// ── Allocate RTP endpoint ──────────────────────────────────────
	if cfg.MediaEnabled {
		var err error
		rtpEP, err = rtp.NewRtpEndpoint(ag.LocalHost(), cfg.RTPPtime)
		if err != nil {
			slog.Warn("RTP socket alloc failed — using port 9",
				"ext", ag.Ext, "err", err)
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

	// ── Wait for provisional / 407 / final fail ────────────────────
	got180 := false
	for !got180 {
		raw, err := ag.WaitForSIPEvent(ctx, sipTimeout, "100", "180", "183", "407")
		if err != nil {
			e.callsFailed.Add(1)
			emit("CALL_TIMEOUT", 0, 0, nil)
			if dialog.State == "INVITE_SENT" || dialog.State == "RINGING" || dialog.State == "PROVRESP_RCVD" {
				go ag.SendCancel(dialog)
			}
			result := CallResult{
				CallID: callID, Caller: ag.Ext, Callee: callee,
				Success: false, FailureReason: "timeout",
				TotalMs:       msSince(callStart),
				RTPLocalPort:  rtpLocalPort(rtpEP),
				PoolWrapIndex: poolWrapIndex,
				PeerExt: callee, TsUTC: inviteTsUTC, Direction: "uac",
				SipMilestones: milestones,
			}
			e.complete(result)
			return
		}

		code, _ := sip.ClassifyMessage(raw)

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

		case code == "407":
			emit("AUTH_407", 407, 0, nil)
			if err := ag.Handle407Invite(dialog, raw); err != nil {
				result := fail(fmt.Sprintf("407 handling: %v", err))
				e.complete(result)
				return
			}

		default:
			if isFinalFailure(code) {
				ag.SendAckForFailure(dialog, raw)
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

		if _, err := ag.WaitForSIPEvent(ctx, sipTimeout, "200_PRACK"); err != nil {
			result := fail("prack_200 timeout")
			e.complete(result)
			return
		}
		milestones.Prack200Ms = msSince(callStart)
		emit("PRACK_200", 200, milestones.Prack200Ms, nil)
	}

	// ── 200 OK to INVITE ───────────────────────────────────────────
	raw200, err := ag.WaitForSIPEvent(ctx, sipTimeout, "200_INVITE")
	if err != nil {
		result := fail("200_invite timeout")
		e.complete(result)
		return
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

	// ── RTP ────────────────────────────────────────────────────────
	isContinuous := cfg.RTPMode == "continuous"
	if rtpEP != nil {
		milestones.RTPStartMs = msSince(callStart)
		startEvent := "RTP_BURST_START"
		if isContinuous {
			startEvent = "RTP_CONTINUOUS_START"
		}
		emit(startEvent, 0, milestones.RTPStartMs, nil)

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

		milestones.RTPEndMs = msSince(callStart)
		endEvent := "RTP_BURST_END"
		if isContinuous {
			endEvent = "RTP_CONTINUOUS_END"
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

	if _, err := ag.WaitForSIPEvent(ctx, sipTimeout, "200_BYE"); err != nil {
		result := fail("bye_200 timeout")
		e.complete(result)
		return
	}
	milestones.Bye200Ms = msSince(callStart)
	if e.metrics != nil {
		e.metrics.IncrementSIPCounter("bye_200_received")
	}
	emit("BYE_200", 200, milestones.Bye200Ms, nil)

	// ── Talk-path verification ─────────────────────────────────────
	var (
		rtpTx, rtpRx          int
		rtpRxFromSBC, rtpRxOt int
		rtcpRx                int
		markersSent           int
		markersRecv           int
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
		mediaOK = rtpRx > 0
		mediaEvent := ClassifyMedia(st, float64(cfg.HoldTimeSeconds))
		milestones.MediaVerifiedMs = msSince(callStart)
		emitCallEvent(e.metrics, callID, ag.Ext, mediaEvent, "uac", callee, 0, milestones.MediaVerifiedMs, map[string]any{
			"rtp_tx_pkts":          rtpTx,
			"rtp_rx_pkts":          rtpRx,
			"rtp_rx_from_sbc_pkts": rtpRxFromSBC,
			"rtp_rx_other_pkts":    rtpRxOt,
			"rtcp_rx_pkts":         rtcpRx,
			"markers_sent":         markersSent,
			"markers_received":     markersRecv,
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

	result := CallResult{
		CallID:           callID,
		Caller:           ag.Ext,
		Callee:           callee,
		Success:          true,
		PDDMs:            pddMs,
		HoldMs:           holdMs,
		TotalMs:          totalMs,
		RTPTxPkts:        rtpTx,
		RTPRxPkts:        rtpRx,
		MediaVerified:    mediaOK,
		RTPLocalPort:     rtpLocalPort(rtpEP),
		PoolWrapIndex:    poolWrapIndex,
		PeerExt:          callee,
		TsUTC:            inviteTsUTC,
		Direction:        "uac",
		SBCRTPRelayIP:    dialog.RTPRemoteIP,
		SBCRTPRelayPort:  dialog.RTPRemotePort,
		SipMilestones:    milestones,
		RTPRxFromSBCPkts: rtpRxFromSBC,
		RTPRxOtherPkts:   rtpRxOt,
		RTCPRxPkts:       rtcpRx,
		RTPAsymmetryFlag: ComputeRTPAsymmetryFlag(rtpTx, rtpRxFromSBC, rtpRx),
		MarkersSent:      markersSent,
		MarkersReceived:  markersRecv,
	}
	e.complete(result)
}

// DrainActiveCalls sends BYE to every currently established dialog across all
// agents.  Called during SIGTERM / graceful shutdown.
func (e *CallEngine) DrainActiveCalls(ctx context.Context, timeout time.Duration) error {
	var wg sync.WaitGroup
	for _, ag := range e.agents {
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
