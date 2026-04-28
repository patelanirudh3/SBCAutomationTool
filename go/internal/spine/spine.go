package spine

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Spine record types — field order here controls JSON output order.
// ---------------------------------------------------------------------------

// RTPStats is the nested RTP block for each spine leg, replacing flat top-level fields.
// JitterMs is null until jitter measurement is wired into rtp/session.go.
type RTPStats struct {
	TX              int      `json:"tx"`
	RX              int      `json:"rx"`
	RXOther         int      `json:"rx_other"`
	RTCPRx          int      `json:"rtcp_rx"`
	MarkersSent     int      `json:"markers_sent"`
	MarkersReceived int      `json:"markers_received"`
	LossPct         float64  `json:"loss_pct"`
	JitterMs        *float64 `json:"jitter_ms,omitempty"`
}

// SpineLeg is a structured leg record with nested rtp block.
// Field declaration order controls JSON key order.
type SpineLeg struct {
	CallID          string          `json:"call_id"`
	Caller          string          `json:"caller"`
	Callee          string          `json:"callee"`
	Direction       string          `json:"direction"`
	Success         bool            `json:"success"`
	FailureReason   string          `json:"failure_reason"`
	PDDMs           float64         `json:"pdd_ms"`
	HoldMs          float64         `json:"hold_ms"`
	TotalMs         float64         `json:"total_ms"`
	MediaVerified   bool            `json:"media_verified"`
	RTP             RTPStats        `json:"rtp"`
	RTPLocalPort    int             `json:"rtp_local_port"`
	SBCRTPRelayIP   string          `json:"sbc_rtp_relay_ip"`
	SBCRTPRelayPort int             `json:"sbc_rtp_relay_port"`
	SipMilestones   json.RawMessage `json:"sip_milestones,omitempty"`
	PeerExt         string          `json:"peer_ext"`
	TsUTC           string          `json:"ts_utc"`
	PoolWrapIndex   int             `json:"pool_wrap_index"`
	Scenario        string          `json:"scenario,omitempty"`
}

type spineCallIDs struct {
	LegA          string `json:"leg_a"`
	LegB          any    `json:"leg_b"`
	B2BUABoundary string `json:"b2bua_boundary"`
	Note          string `json:"note"`
}

// spineMediaIntegrityDir: UAC→UAS direction.
// Cross-leg marker check: uac_markers_sent vs uas_markers_received.
// The *_markers_received suffix makes the cross-leg origin explicit.
type spineMediaIntegrityDir struct {
	UACTX              int     `json:"uac_tx"`
	UASRX              int     `json:"uas_rx"`
	DeltaPct           float64 `json:"delta_pct"`
	UACMarkersSent     int     `json:"uac_markers_sent"`
	UASMarkersReceived int     `json:"uas_markers_received"`
	MarkersOK          bool    `json:"markers_ok"`
	Status             string  `json:"status"`
}

// spineMediaIntegrityDirRev: UAS→UAC direction.
// Cross-leg marker check: uas_markers_sent vs uac_markers_received.
type spineMediaIntegrityDirRev struct {
	UASTX              int     `json:"uas_tx"`
	UACRX              int     `json:"uac_rx"`
	DeltaPct           float64 `json:"delta_pct"`
	UASMarkersSent     int     `json:"uas_markers_sent"`
	UACMarkersReceived int     `json:"uac_markers_received"`
	MarkersOK          bool    `json:"markers_ok"`
	Status             string  `json:"status"`
}

// spineMediaIntegrity merges what were previously two separate blocks
// (media_cross_check + payload_integrity) into one concise structure.
// When jitter is implemented, it slots into each directional sub-block.
type spineMediaIntegrity struct {
	UACtoUAS     spineMediaIntegrityDir    `json:"uac_to_uas"`
	UAStoUAC     spineMediaIntegrityDirRev `json:"uas_to_uac"`
	Verdict      string                   `json:"verdict"`
	IntegrityPct float64                  `json:"integrity_pct"`
}

// SpineRecord is the top-level correlated call record.
// Field declaration order controls JSON key order.
type SpineRecord struct {
	SpineID           string              `json:"spine_id"`
	CorrelationMethod string              `json:"correlation_method"`
	CallIDs           spineCallIDs        `json:"call_ids"`
	UACLeg            json.RawMessage     `json:"uac_leg"`
	UASLeg            json.RawMessage     `json:"uas_leg"`
	MediaIntegrity    spineMediaIntegrity `json:"media_integrity"`
	KamTrace          any                 `json:"kam_trace"`
}

// mapToSpineLeg converts a flat call-result map into a SpineLeg with nested rtp block.
func mapToSpineLeg(m map[string]any) SpineLeg {
	if m == nil {
		return SpineLeg{}
	}

	tx := getIntField(m, "rtp_tx_pkts")
	rxFromSBC := getIntField(m, "rtp_rx_from_sbc_pkts")
	rxTotal := getIntField(m, "rtp_rx_pkts")
	effectiveRx := rxFromSBC
	if rxFromSBC == 0 && rxTotal > 0 {
		effectiveRx = rxTotal
	}

	lossPct := 0.0
	if tx > 0 {
		lossPct = round1(math.Abs(float64(tx-effectiveRx)) / float64(tx) * 100)
	}

	// Preserve sip_milestones raw JSON so field order is maintained in output.
	var milestones json.RawMessage
	switch v := m["sip_milestones"].(type) {
	case json.RawMessage:
		milestones = v
	case map[string]any:
		if b, err := json.Marshal(v); err == nil {
			milestones = b
		}
	}

	return SpineLeg{
		CallID:          getStrField(m, "call_id"),
		Caller:          getStrField(m, "caller"),
		Callee:          getStrField(m, "callee"),
		Direction:       getStrField(m, "direction"),
		Success:         getBoolField(m, "success"),
		FailureReason:   getStrField(m, "failure_reason"),
		PDDMs:           getFloat64Field(m, "pdd_ms"),
		HoldMs:          getFloat64Field(m, "hold_ms"),
		TotalMs:         getFloat64Field(m, "total_ms"),
		MediaVerified:   getBoolField(m, "media_verified"),
		RTP: RTPStats{
			TX:              tx,
			RX:              effectiveRx,
			RXOther:         getIntField(m, "rtp_rx_other_pkts"),
			RTCPRx:          getIntField(m, "rtcp_rx_pkts"),
			MarkersSent:     getIntField(m, "markers_sent"),
			MarkersReceived: getIntField(m, "markers_received"),
			LossPct:         lossPct,
		},
		RTPLocalPort:    getIntField(m, "rtp_local_port"),
		SBCRTPRelayIP:   getStrField(m, "sbc_rtp_relay_ip"),
		SBCRTPRelayPort: getIntField(m, "sbc_rtp_relay_port"),
		SipMilestones:   milestones,
		PeerExt:         getStrField(m, "peer_ext"),
		TsUTC:           getStrField(m, "ts_utc", "timestamp"),
		PoolWrapIndex:   getIntField(m, "pool_wrap_index"),
		Scenario:        getStrField(m, "scenario"),
	}
}

// BuildCallSpines correlates UAC and UAS call results into spine records.
// Each UAC call is matched to at most one UAS call using the strategy chain
// (GSID exact match first, then ext+time window). Unmatched UAC calls still
// produce a spine with a nil UAS leg.
// Returns []json.RawMessage so each spine preserves exact key ordering.
func BuildCallSpines(uacCalls, uasCalls []map[string]any) []json.RawMessage {
	spines := make([]json.RawMessage, 0, len(uacCalls))
	usedUAS := make([]bool, len(uasCalls))

	for _, uac := range uacCalls {
		var available []map[string]any
		var availableIdx []int
		for i, c := range uasCalls {
			if !usedUAS[i] {
				available = append(available, c)
				availableIdx = append(availableIdx, i)
			}
		}

		uasMatch, strategy, matchIdx := findUASMatch(uac, available)
		if uasMatch != nil && matchIdx >= 0 {
			usedUAS[availableIdx[matchIdx]] = true
		}

		uacTx := getIntField(uac, "rtp_tx_pkts")
		uasRx := getIntField(uasMatch, "rtp_rx_from_sbc_pkts", "rtp_rx_pkts")
		uasTx := getIntField(uasMatch, "rtp_tx_pkts")
		uacRx := getIntField(uac, "rtp_rx_from_sbc_pkts", "rtp_rx_pkts")

		aPct := deltaPct(uacTx, uasRx)
		bPct := deltaPct(uasTx, uacRx)

		uacExt := getStrField(uac, "ext", "caller")
		uasExt := getStrField(uac, "peer_ext", "callee")

		// Markers from each leg's own sending side.
		uacMarkersSent := getIntField(uac, "markers_sent")
		uasMarkersSent := getIntField(uasMatch, "markers_sent")

		// Cross-leg received: what the OTHER side received.
		// uacMarkersReceived: UAC received markers sent by UAS (uas_to_uac check).
		// uasMarkersReceived: UAS received markers sent by UAC (uac_to_uas check).
		uacMarkersReceived := getIntField(uac, "markers_received")
		uasMarkersReceived := getIntField(uasMatch, "markers_received")

		// markers_ok = the sender's count matches what the receiver actually received.
		uacToUASMarkersOK := uasMatch == nil || uacMarkersSent == uasMarkersReceived
		uasToUACMarkersOK := uasMatch == nil || uasMarkersSent == uacMarkersReceived

		worstDelta := math.Max(aPct, bPct)
		var verdict string
		switch {
		case worstDelta <= 5:
			verdict = "PASS"
		case worstDelta <= 15:
			verdict = "WARNING"
		default:
			verdict = "FAIL"
		}
		integrityPct := round1(100.0 - worstDelta)

		var legBCallID any
		if uasMatch != nil {
			legBCallID = getStrField(uasMatch, "call_id")
		}

		// Convert flat leg maps to structured SpineLeg with nested rtp block.
		uacLeg := mapToSpineLeg(uac)
		var uasLeg *SpineLeg
		if uasMatch != nil {
			leg := mapToSpineLeg(uasMatch)
			uasLeg = &leg
		}

		uacLegRaw, _ := json.Marshal(uacLeg)
		var uasLegRaw json.RawMessage
		if uasLeg != nil {
			uasLegRaw, _ = json.Marshal(uasLeg)
		} else {
			uasLegRaw = json.RawMessage("null")
		}

		rec := SpineRecord{
			SpineID:           fmt.Sprintf("%s->%s@%s", uacExt, uasExt, getStrField(uac, "ts_utc")),
			CorrelationMethod: strategy,
			CallIDs: spineCallIDs{
				LegA:          getStrField(uac, "call_id"),
				LegB:          legBCallID,
				B2BUABoundary: "avaya_cm",
				Note:          "CM generates a new Call-ID for Leg B. Legs correlated by: " + strategy,
			},
			UACLeg: uacLegRaw,
			UASLeg: uasLegRaw,
			MediaIntegrity: spineMediaIntegrity{
				UACtoUAS: spineMediaIntegrityDir{
					UACTX:              uacTx,
					UASRX:              uasRx,
					DeltaPct:           aPct,
					UACMarkersSent:     uacMarkersSent,
					UASMarkersReceived: uasMarkersReceived,
					MarkersOK:          uacToUASMarkersOK,
					Status:             deltaFlag(aPct),
				},
				UAStoUAC: spineMediaIntegrityDirRev{
					UASTX:              uasTx,
					UACRX:              uacRx,
					DeltaPct:           bPct,
					UASMarkersSent:     uasMarkersSent,
					UACMarkersReceived: uacMarkersReceived,
					MarkersOK:          uasToUACMarkersOK,
					Status:             deltaFlag(bPct),
				},
				Verdict:      verdict,
				IntegrityPct: integrityPct,
			},
			KamTrace: nil,
		}

		raw, err := json.Marshal(rec)
		if err != nil {
			slog.Error("Failed to marshal spine record", "err", err)
			continue
		}
		spines = append(spines, json.RawMessage(raw))
	}

	return spines
}


// ---------------------------------------------------------------------------
// Correlation strategies
// ---------------------------------------------------------------------------

type correlationStrategy struct {
	name    string
	matcher func(uac, uas map[string]any) bool
}

var strategies = []correlationStrategy{
	{name: "gsid", matcher: strategyGSID},
	{name: "ext_time", matcher: strategyExtTime},
}

func findUASMatch(uac map[string]any, candidates []map[string]any) (match map[string]any, strategy string, idx int) {
	for _, s := range strategies {
		for i, c := range candidates {
			if s.matcher(uac, c) {
				return c, s.name, i
			}
		}
	}
	return nil, "unmatched", -1
}

func strategyGSID(uac, uas map[string]any) bool {
	g1 := getStrField(uac, "gsid", "x_gsid")
	g2 := getStrField(uas, "gsid", "x_gsid")
	return g1 != "" && g2 != "" && g1 == g2
}

func strategyExtTime(uac, uas map[string]any) bool {
	uacExt := getStrField(uac, "ext", "caller")
	uasExt := getStrField(uac, "peer_ext", "callee")
	uasOwnExt := getStrField(uas, "ext", "callee")
	uasPeerExt := getStrField(uas, "peer_ext", "caller")

	if uacExt != uasPeerExt || uasExt != uasOwnExt {
		return false
	}

	uacTS := parseTS(getStrField(uac, "ts_utc"))
	uasTS := parseTS(getStrField(uas, "ts_utc"))
	return uacTS != 0 && uasTS != 0 && math.Abs(uacTS-uasTS) < 3.0
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// parseTS parses an ISO-8601 timestamp to Unix seconds. Returns 0 on failure.
func parseTS(tsStr string) float64 {
	if tsStr == "" {
		return 0
	}
	tsStr = strings.Replace(tsStr, "Z", "+00:00", 1)

	for _, layout := range []string{
		"2006-01-02T15:04:05.999999999-07:00",
		"2006-01-02T15:04:05-07:00",
		"2006-01-02T15:04:05.999999999Z07:00",
		"2006-01-02T15:04:05Z07:00",
		"2006-01-02 15:04:05.999999999-07:00",
		"2006-01-02 15:04:05-07:00",
		time.RFC3339Nano,
		time.RFC3339,
	} {
		if t, err := time.Parse(layout, tsStr); err == nil {
			return float64(t.Unix()) + float64(t.Nanosecond())/1e9
		}
	}
	return 0
}

// deltaPct computes |a-b|/a * 100. Returns 0 if both zero, 100 if only a is zero.
func deltaPct(a, b int) float64 {
	if a == 0 && b == 0 {
		return 0
	}
	if a == 0 {
		return 100.0
	}
	return round1(math.Abs(float64(a-b)) / float64(a) * 100)
}

// deltaFlag returns "OK" if pct ≤ 5, "WARNING" if ≤ 15, else "CRITICAL".
func deltaFlag(pct float64) string {
	if pct <= 5 {
		return "OK"
	}
	if pct <= 15 {
		return "WARNING"
	}
	return "CRITICAL"
}

// getIntField tries each key in m and returns the first non-zero integer value.
// Handles float64 (JSON numbers), int, and int64. Returns 0 if m is nil or no key matched.
func getIntField(m map[string]any, keys ...string) int {
	if m == nil {
		return 0
	}
	for _, k := range keys {
		v, ok := m[k]
		if !ok || v == nil {
			continue
		}
		switch n := v.(type) {
		case float64:
			if int(n) != 0 {
				return int(n)
			}
		case int:
			if n != 0 {
				return n
			}
		case int64:
			if n != 0 {
				return int(n)
			}
		case json.Number:
			if i, err := n.Int64(); err == nil && i != 0 {
				return int(i)
			}
		}
	}
	return 0
}

// getStrField tries each key in m and returns the first non-empty string value.
// Returns "" if m is nil or no key matched.
func getStrField(m map[string]any, keys ...string) string {
	if m == nil {
		return ""
	}
	for _, k := range keys {
		v, ok := m[k]
		if !ok || v == nil {
			continue
		}
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}

// getBoolField reads a boolean value from a map by key. Returns false if absent or wrong type.
func getBoolField(m map[string]any, key string) bool {
	if m == nil {
		return false
	}
	v, ok := m[key]
	if !ok || v == nil {
		return false
	}
	if b, ok := v.(bool); ok {
		return b
	}
	return false
}

// getFloat64Field reads a float64 value from a map by key, handling json.Number and int types.
func getFloat64Field(m map[string]any, keys ...string) float64 {
	if m == nil {
		return 0
	}
	for _, k := range keys {
		v, ok := m[k]
		if !ok || v == nil {
			continue
		}
		switch n := v.(type) {
		case float64:
			if n != 0 {
				return n
			}
		case int:
			if n != 0 {
				return float64(n)
			}
		case int64:
			if n != 0 {
				return float64(n)
			}
		case json.Number:
			if f, err := n.Float64(); err == nil && f != 0 {
				return f
			}
		}
	}
	return 0
}
