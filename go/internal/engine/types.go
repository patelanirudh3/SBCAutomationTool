package engine

import (
	"encoding/json"
	"log/slog"
	"math"
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
	InviteReceivedMs  float64 `json:"invite_received_ms"`
	Trying100SentMs   float64 `json:"trying_100_sent_ms"`
	Ringing180SentMs  float64 `json:"ringing_180_sent_ms"`
	PrackReceivedMs   float64 `json:"prack_received_ms"`
	Prack200SentMs    float64 `json:"prack_200_sent_ms"`
	Ok200SentMs       float64 `json:"ok_200_sent_ms"`
	AckReceivedMs     float64 `json:"ack_received_ms"`
	ByeReceivedMs     float64 `json:"bye_received_ms"`
	Bye200SentMs      float64 `json:"bye_200_sent_ms"`
	UASInviteTsUTC    string  `json:"uas_invite_ts_utc"`
}

// CallResult carries the outcome of a single call (UAC or UAS) and is fed
// into the metrics pipeline.
type CallResult struct {
	CallID          string        `json:"call_id"`
	Caller          string        `json:"caller"`
	Callee          string        `json:"callee"`
	Success         bool          `json:"success"`
	FailureReason   string        `json:"failure_reason"`
	PDDMs           float64       `json:"pdd_ms"`
	HoldMs          float64       `json:"hold_ms"`
	TotalMs         float64       `json:"total_ms"`
	RTPTxPkts       int           `json:"rtp_tx_pkts"`
	RTPRxPkts       int           `json:"rtp_rx_pkts"`
	MediaVerified   bool          `json:"media_verified"`
	RTPLocalPort    int           `json:"rtp_local_port"`
	PoolWrapIndex   int           `json:"pool_wrap_index"`
	PeerExt         string        `json:"peer_ext"`
	TsUTC           string        `json:"ts_utc"`
	Direction       string        `json:"direction"`
	SBCRTPRelayIP   string        `json:"sbc_rtp_relay_ip"`
	SBCRTPRelayPort int           `json:"sbc_rtp_relay_port"`
	SipMilestones   SipMilestones `json:"sip_milestones"`

	RTPRxFromSBCPkts int    `json:"rtp_rx_from_sbc_pkts"`
	RTPRxOtherPkts   int    `json:"rtp_rx_other_pkts"`
	RTCPRxPkts       int    `json:"rtcp_rx_pkts"`
	RTPAsymmetryFlag string `json:"rtp_asymmetry_flag"`
	MarkersSent      int    `json:"markers_sent"`
	MarkersReceived  int    `json:"markers_received"`
	Scenario         string `json:"scenario"`
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
func ComputeRTPAsymmetryFlag(txPkts, rxFromSBC, rxTotal int) string {
	if txPkts == 0 {
		return "OK"
	}
	effectiveRx := rxFromSBC
	if rxFromSBC == 0 && rxTotal > 0 {
		effectiveRx = rxTotal
	}
	deltaPct := math.Abs(float64(txPkts-effectiveRx)) / float64(txPkts) * 100
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
