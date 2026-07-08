package engine

import (
	"encoding/json"
	"log/slog"
	"math"
	"strings"
	"time"

	"github.com/cci/traffic-engine/internal/rtp"
)

// SipMilestones records monotonic-clock offsets (ms from call start) for every
// significant SIP signalling event.  Fields are split into UAC-side and
// UAS-side groups; only the relevant side is populated for a given call.
type SipMilestones struct {
	// UAC side
	InviteSentMs    float64 `json:"invite_sent_ms"`
	Trying100Ms     float64 `json:"trying_100_ms"`
	Ringing180Ms    float64 `json:"ringing_180_ms"`
	PrackSentMs     float64 `json:"prack_sent_ms"`
	Prack200Ms      float64 `json:"prack_200_ms"`
	Ok200Ms         float64 `json:"ok_200_ms"`
	AckSentMs       float64 `json:"ack_sent_ms"`
	RTPStartMs      float64 `json:"rtp_start_ms"`
	RTPEndMs        float64 `json:"rtp_end_ms"`
	ByeSentMs       float64 `json:"bye_sent_ms"`
	Bye200Ms        float64 `json:"bye_200_ms"`
	MediaVerifiedMs float64 `json:"media_verified_ms"`
	InviteTsUTC     string  `json:"invite_ts_utc"`

	// UAS side
	InviteReceivedMs float64 `json:"invite_received_ms"`
	Trying100SentMs  float64 `json:"trying_100_sent_ms"`
	Ringing180SentMs float64 `json:"ringing_180_sent_ms"`
	PrackReceivedMs  float64 `json:"prack_received_ms"`
	Prack200SentMs   float64 `json:"prack_200_sent_ms"`
	Ok200SentMs      float64 `json:"ok_200_sent_ms"`
	AckReceivedMs    float64 `json:"ack_received_ms"`
	ByeReceivedMs    float64 `json:"bye_received_ms"`
	Bye200SentMs     float64 `json:"bye_200_sent_ms"`
	UASInviteTsUTC   string  `json:"uas_invite_ts_utc"`
}

// CallResult carries the outcome of a single call (UAC or UAS) and is fed
// into the metrics pipeline.
type CallResult struct {
	CallID              string        `json:"call_id"`
	Caller              string        `json:"caller"`
	Callee              string        `json:"callee"`
	Success             bool          `json:"success"`
	FailureReason       string        `json:"failure_reason"`
	PDDMs               float64       `json:"pdd_ms"`
	HoldMs              float64       `json:"hold_ms"`
	TotalMs             float64       `json:"total_ms"`
	RTPTxPkts           int           `json:"rtp_tx_pkts"`
	RTPRxPkts           int           `json:"rtp_rx_pkts"`
	SIPLocalIP          string        `json:"sip_local_ip"`
	SIPLocalPort        int           `json:"sip_local_port"`
	SIPRemoteIP         string        `json:"sip_remote_ip"`
	SIPRemotePort       int           `json:"sip_remote_port"`
	SIPCode             int           `json:"sip_code,omitempty"`
	SIPServerHeader     string        `json:"sip_server_header,omitempty"`
	SIPUserAgentHeader  string        `json:"sip_user_agent_header,omitempty"`
	MediaVerified       bool          `json:"media_verified"`
	RTPLocalPort        int           `json:"rtp_local_port"`
	MediaSecurity       string        `json:"media_security"`
	RTPCodec            string        `json:"rtp_codec"`
	RTPPayloadType      int           `json:"rtp_payload_type"`
	RTPPayloadMarkers   bool          `json:"rtp_payload_markers"`
	MOSCodec            string        `json:"mos_codec"`
	SRTPCryptoSuite     string        `json:"srtp_crypto_suite,omitempty"`
	SRTPDecryptFailures int           `json:"srtp_decrypt_failures,omitempty"`
	SRTPAuthFailures    int           `json:"srtp_auth_failures,omitempty"`
	SRTPReplayFailures  int           `json:"srtp_replay_failures,omitempty"`
	PoolWrapIndex       int           `json:"pool_wrap_index"`
	PeerExt             string        `json:"peer_ext"`
	TsUTC               string        `json:"ts_utc"`
	Direction           string        `json:"direction"`
	SBCRTPRelayIP       string        `json:"sbc_rtp_relay_ip"`
	SBCRTPRelayPort     int           `json:"sbc_rtp_relay_port"`
	SipMilestones       SipMilestones `json:"sip_milestones"`

	RTPRxFromSBCPkts int    `json:"rtp_rx_from_sbc_pkts"`
	RTPRxOtherPkts   int    `json:"rtp_rx_other_pkts"`
	RTCPRxPkts       int    `json:"rtcp_rx_pkts"`
	RTPAsymmetryFlag string `json:"rtp_asymmetry_flag"`
	MarkersSent      int    `json:"markers_sent"`
	MarkersReceived  int    `json:"markers_received"`
	RTPExpectedPkts  int    `json:"rtp_expected_pkts"`
	RTPSSRCCount     int    `json:"rtp_ssrc_count"`
	Scenario         string `json:"scenario"`
	ActiveController string `json:"active_controller,omitempty"`
	AgentGroupID     string `json:"agent_group_id,omitempty"`

	// QoS / Media metrics (Phase 1 — read-only).
	// Populated by call_engine / uas_auto_answer from rtp.RtpStats and the
	// engine's MOS estimator. Zero values mean the metric was not produced
	// (e.g. QoS disabled, no RTP received, or RTCP not seen).
	JitterMs         float64 `json:"jitter_ms"`
	PacketLossPct    float64 `json:"packet_loss_pct"`
	LostPackets      int     `json:"lost_packets"`
	OOOPackets       int     `json:"ooo_packets"`
	RTTMs            float64 `json:"rtt_ms"`             // from RTCP RR (LSR/DLSR), 0 if not available
	RemoteJitterMs   float64 `json:"remote_jitter_ms"`   // from RTCP RR
	RemoteLossPct    float64 `json:"remote_loss_pct"`    // from RTCP RR fraction-lost
	MOSScore         float64 `json:"mos_score"`          // 0 if MOS estimation disabled
	MediaQualityFlag string  `json:"media_quality_flag"` // OK / WARNING / CRITICAL / UNKNOWN

	// SIP-derived shortcuts computed from SipMilestones for direct GUI consumption.
	CallSetupMs         float64 `json:"call_setup_ms"`     // Ok200Ms - InviteSentMs
	PrackRTTMs          float64 `json:"prack_rtt_ms"`      // Prack200Ms - PrackSentMs
	SipTransactionRTTMs float64 `json:"sip_txn_rtt_ms"`    // Trying100Ms - InviteSentMs (UAC path latency)
	ByeCompletionMs     float64 `json:"bye_completion_ms"` // Bye200Ms - ByeSentMs
}

// ClassifyMedia determines talk-path verification result from RTP receive
// statistics:
//
//	MEDIA_FAILED   — rtp_rx_pkts == 0
//	MEDIA_PARTIAL  — rx > 0 but receive duration < 50% of hold_time
//	MEDIA_VERIFIED — otherwise
func ClassifyMedia(stats rtp.RtpStats, holdSeconds float64) string {
	if stats.RTPRxPkts == 0 {
		return "MEDIA_FAILED"
	}
	if stats.LastRxMs != nil && stats.FirstRxMs != nil && *stats.LastRxMs > 0 && *stats.FirstRxMs > 0 {
		rxDurationS := (*stats.LastRxMs - *stats.FirstRxMs) / 1000.0
		if rxDurationS < holdSeconds*0.5 {
			return "MEDIA_PARTIAL"
		}
	}
	return "MEDIA_VERIFIED"
}

// ComputeRTPAsymmetryFlag computes asymmetry using filtered (SBC-only) rx
// count.  Falls back to total rx if expected_src was never set
// (rxFromSBC == 0 but rxTotal > 0).
//
// The denominator is max(tx, effectiveRx) so that the percentage stays
// sensible when RX slightly exceeds TX (e.g. reporting nuances).
func ComputeRTPAsymmetryFlag(txPkts, rxFromSBC, rxTotal int) string {
	if txPkts == 0 && rxFromSBC == 0 && rxTotal == 0 {
		return "OK"
	}
	effectiveRx := rxFromSBC
	if rxFromSBC == 0 && rxTotal > 0 {
		effectiveRx = rxTotal
	}
	base := txPkts
	if effectiveRx > base {
		base = effectiveRx
	}
	if base == 0 {
		return "OK"
	}
	deltaPct := math.Abs(float64(txPkts-effectiveRx)) / float64(base) * 100
	if deltaPct <= 5 {
		return "OK"
	}
	if deltaPct <= 15 {
		return "WARNING"
	}
	return "CRITICAL"
}

// msSince returns milliseconds elapsed since t using the monotonic clock.
func msSince(t time.Time) float64 {
	return float64(time.Since(t).Nanoseconds()) / 1e6
}

// ---------------------------------------------------------------------------
// Media-quality thresholds (hardcoded for Phase 1; promote to config later)
// ---------------------------------------------------------------------------

const (
	// JitterWarnMs / JitterCriticalMs match common ITU-T G.114 jitter buffer
	// guidance for narrowband voice (G.711). Calls above the warn threshold
	// are user-perceptible; above critical the call is unintelligible.
	JitterWarnMs     = 30.0
	JitterCriticalMs = 100.0

	// PacketLoss thresholds expressed as percentages (0..100).
	// G.711 with no PLC tolerates ~1%; sustained >5% is unacceptable.
	PacketLossWarnPct     = 1.0
	PacketLossCriticalPct = 5.0

	// MOS thresholds — based on G.107 R-factor mapping. MOS is on a 1..5
	// scale; <3.5 starts to be noticeably degraded, <2.5 is poor.
	MOSWarnBelow     = 3.5
	MOSCriticalBelow = 2.5
)

// ComputeMOS returns an estimated Mean Opinion Score using the simplified
// ITU-T G.107 E-Model. It preserves the historical G.711 estimate.
func ComputeMOS(packetLossFraction, jitterMs float64) float64 {
	return ComputeMOSForCodec("G711_ULAW", packetLossFraction, jitterMs)
}

// ComputeMOSForCodec returns an estimated Mean Opinion Score using a simplified
// ITU-T G.107 E-Model with codec-specific baseline/impairment parameters.
// Inputs:
//
//	packetLossFraction — 0.0 to 1.0 (NOT percentage)
//	jitterMs           — interarrival jitter in milliseconds (RFC 3550)
//
// Returns a MOS value clamped to [1.0, 4.5].
//
// This is an approximation; for production-grade reporting use a dedicated
// E-Model library. It is intentionally conservative for traffic-test use
// (slightly under-predicts vs. real subjective scoring).
func ComputeMOSForCodec(codec string, packetLossFraction, jitterMs float64) float64 {
	if packetLossFraction < 0 {
		packetLossFraction = 0
	}
	if jitterMs < 0 {
		jitterMs = 0
	}
	R := 93.2
	lossFactor := 17.0
	switch strings.ToUpper(strings.TrimSpace(codec)) {
	case "G729":
		// G.729 narrowband has a lower clean-channel ceiling than G.711 and
		// degrades faster with loss because this tool does not model PLC.
		R = 83.0
		lossFactor = 24.0
	case "G711_ALAW", "G711_ULAW", "":
		R = 93.2
		lossFactor = 17.0
	}
	// Effective one-way latency: assume 50ms baseline + jitter buffer
	// (~2.5x jitter is a typical playout-buffer rule of thumb).
	effectiveLatency := 50.0 + jitterMs*2.5
	if effectiveLatency > 177.3 {
		R -= (effectiveLatency - 177.3) * 0.1
	}
	// Packet-loss impairment (logarithmic; codec-specific approximation).
	R -= lossFactor * math.Log(1+100*packetLossFraction)

	if R < 0 {
		R = 0
	}
	if R > 100 {
		R = 100
	}
	mos := 1.0 + 0.035*R + 7e-6*R*(R-60)*(100-R)
	if mos < 1.0 {
		mos = 1.0
	}
	if mos > 4.5 {
		mos = 4.5
	}
	return math.Round(mos*100) / 100
}

// ClassifyMediaQuality returns "OK", "WARNING", "CRITICAL", or "UNKNOWN"
// based on jitter, packet-loss, and (optionally) MOS thresholds. MOS is only
// considered when mosScore > 0 (i.e. MOS estimation was enabled and the call
// produced media). UNKNOWN is returned when there is no media data at all.
func ClassifyMediaQuality(jitterMs, packetLossPct, mosScore float64, hadRTP bool) string {
	if !hadRTP {
		return "UNKNOWN"
	}
	if jitterMs >= JitterCriticalMs ||
		packetLossPct >= PacketLossCriticalPct ||
		(mosScore > 0 && mosScore < MOSCriticalBelow) {
		return "CRITICAL"
	}
	if jitterMs >= JitterWarnMs ||
		packetLossPct >= PacketLossWarnPct ||
		(mosScore > 0 && mosScore < MOSWarnBelow) {
		return "WARNING"
	}
	return "OK"
}

// DeriveSipTimings extracts the four SIP-derived helper metrics from a
// SipMilestones block. Returns zeros for any leg whose milestone wasn't
// recorded (e.g. UAS-side calls don't populate UAC-side fields and vice
// versa). All return values are in milliseconds.
func DeriveSipTimings(m SipMilestones) (callSetupMs, prackRTTMs, sipTxnRTTMs, byeCompletionMs float64) {
	if m.Ok200Ms > m.InviteSentMs {
		callSetupMs = math.Round((m.Ok200Ms-m.InviteSentMs)*100) / 100
	}
	if m.Prack200Ms > m.PrackSentMs {
		prackRTTMs = math.Round((m.Prack200Ms-m.PrackSentMs)*100) / 100
	}
	if m.Trying100Ms > m.InviteSentMs {
		sipTxnRTTMs = math.Round((m.Trying100Ms-m.InviteSentMs)*100) / 100
	}
	if m.Bye200Ms > m.ByeSentMs {
		byeCompletionMs = math.Round((m.Bye200Ms-m.ByeSentMs)*100) / 100
	}
	return
}

// callEvent is the JSON payload emitted for every significant call event.
type callEvent struct {
	CallID      string  `json:"call_id"`
	Ext         string  `json:"ext"`
	PeerExt     string  `json:"peer_ext,omitempty"`
	Event       string  `json:"event"`
	Direction   string  `json:"direction"`
	TsUTC       string  `json:"ts_utc"`
	TsMonoMs    float64 `json:"ts_mono_ms"`
	MilestoneMs float64 `json:"milestone_ms"`
	SipCode     int     `json:"sip_code,omitempty"`
}

// MetricsRecorder is the subset of the metrics collector used by the engines.
type MetricsRecorder interface {
	IncrementSIPCounter(name string)
	RecordRawEvent(payload map[string]any)
}

// emitCallEvent logs a structured JSON call event and optionally records it
// in the metrics collector.
func emitCallEvent(metrics MetricsRecorder, callID, ext, event, direction, peerExt string, sipCode int, milestoneMs float64, extra map[string]any) {
	now := time.Now().UTC()
	payload := map[string]any{
		"call_id":      callID,
		"ext":          ext,
		"peer_ext":     peerExt,
		"event":        event,
		"direction":    direction,
		"ts_utc":       now.Format(time.RFC3339Nano),
		"ts_mono_ms":   float64(time.Now().UnixNano()) / 1e6,
		"milestone_ms": math.Round(milestoneMs*1000) / 1000,
	}
	if sipCode != 0 {
		payload["sip_code"] = sipCode
	}
	for k, v := range extra {
		payload[k] = v
	}
	raw, _ := json.Marshal(payload)
	slog.Info("CALL_EVENT", "payload", string(raw))
	if metrics != nil {
		metrics.RecordRawEvent(payload)
	}
}
