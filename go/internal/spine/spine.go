package spine

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net/http"
	"strings"
	"time"
)

// BuildCallSpines correlates UAC and UAS call results into spine records.
// Each UAC call is matched to at most one UAS call using the strategy chain
// (GSID exact match first, then ext+time window). Unmatched UAC calls still
// produce a spine with a nil UAS leg.
func BuildCallSpines(uacCalls, uasCalls []map[string]any) []map[string]any {
	spines := make([]map[string]any, 0, len(uacCalls))
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

		uacMarkersSent := getIntField(uac, "markers_sent")
		uasMarkersSent := getIntField(uasMatch, "markers_sent")

		uacExpectedMarkers := 0
		if uacTx > 0 {
			uacExpectedMarkers = uacTx / 100
		}
		uasExpectedMarkers := 0
		if uasTx > 0 {
			uasExpectedMarkers = uasTx / 100
		}

		uacEmbedOK := uacMarkersSent == uacExpectedMarkers
		if uacExpectedMarkers == 0 {
			uacEmbedOK = uacMarkersSent == 0
		}
		uasEmbedOK := uasMarkersSent == uasExpectedMarkers
		if uasExpectedMarkers == 0 {
			uasEmbedOK = uasMarkersSent == 0
		}

		mediaOK := deltaFlag(aPct) == "OK" && deltaFlag(bPct) == "OK"
		worstDelta := math.Max(aPct, bPct)

		var payloadOverall string
		switch {
		case uacEmbedOK && uasEmbedOK && mediaOK:
			payloadOverall = "PASS"
		case mediaOK:
			payloadOverall = "PASS"
		case worstDelta <= 15:
			payloadOverall = "WARNING"
		default:
			payloadOverall = "FAIL"
		}
		integrityPct := round1(100.0 - worstDelta)

		var legBCallID any
		if uasMatch != nil {
			legBCallID = getStrField(uasMatch, "call_id")
		}

		var uasLeg any
		if uasMatch != nil {
			uasLeg = uasMatch
		}

		uasRxTotal := getIntField(uasMatch, "rtp_rx_pkts")
		uacRxTotal := getIntField(uac, "rtp_rx_pkts")

		spine := map[string]any{
			"spine_id":           fmt.Sprintf("%s->%s@%s", uacExt, uasExt, getStrField(uac, "ts_utc")),
			"correlation_method": strategy,
			"call_ids": map[string]any{
				"leg_a":          getStrField(uac, "call_id"),
				"leg_b":          legBCallID,
				"b2bua_boundary": "avaya_cm",
				"note":           "CM generates a new Call-ID for Leg B. Legs correlated by: " + strategy,
			},
			"uac_leg": uac,
			"uas_leg": uasLeg,
			"media_cross_check": map[string]any{
				"uac_tx_vs_uas_rx": map[string]any{
					"uac_tx":    uacTx,
					"uas_rx":    uasRx,
					"uas_rx_total": uasRxTotal,
					"delta_pct": aPct,
					"flag":      deltaFlag(aPct),
				},
				"uas_tx_vs_uac_rx": map[string]any{
					"uas_tx":    uasTx,
					"uac_rx":    uacRx,
					"uac_rx_total": uacRxTotal,
					"delta_pct": bPct,
					"flag":      deltaFlag(bPct),
				},
				"overall_status": overallMediaStatus(aPct, bPct),
			},
			"payload_integrity": map[string]any{
				"uac_to_uas": map[string]any{
					"uac_tx":              uacTx,
					"uas_rx":              uasRx,
					"uac_markers_sent":    uacMarkersSent,
					"uac_markers_expected": uacExpectedMarkers,
					"markers_embedded_ok": uacEmbedOK,
					"delta_pct":           aPct,
					"integrity_pct":       round1(100.0 - aPct),
					"verdict":             deltaFlag(aPct),
				},
				"uas_to_uac": map[string]any{
					"uas_tx":              uasTx,
					"uac_rx":              uacRx,
					"uas_markers_sent":    uasMarkersSent,
					"uas_markers_expected": uasExpectedMarkers,
					"markers_embedded_ok": uasEmbedOK,
					"delta_pct":           bPct,
					"integrity_pct":       round1(100.0 - bPct),
					"verdict":             deltaFlag(bPct),
				},
				"overall_verdict":       payloadOverall,
				"overall_integrity_pct": integrityPct,
				"note":                  "Markers verified locally (B2BUA rewrites payload); flow verified by packet count cross-check",
			},
			"kam_trace": nil,
		}
		spines = append(spines, spine)
	}

	return spines
}

// CollectUASCallResults fetches call results from UAS via HTTP GET /api/call-results.
// Returns empty slice on any failure — never blocks the run export.
func CollectUASCallResults(uasBaseURL string, timeoutSeconds float64) []map[string]any {
	url := strings.TrimRight(uasBaseURL, "/") + "/api/call-results"
	client := &http.Client{
		Timeout: time.Duration(timeoutSeconds * float64(time.Second)),
	}

	resp, err := client.Get(url)
	if err != nil {
		slog.Warn("Could not collect UAS CallResults — spine will be UAC-only",
			"url", url, "error", err)
		return nil
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		slog.Warn("UAS /api/call-results returned non-200 — spine will be UAC-only",
			"url", url, "status", resp.StatusCode)
		return nil
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		slog.Warn("Failed to read UAS call-results response body",
			"url", url, "error", err)
		return nil
	}

	var results []map[string]any
	if err := json.Unmarshal(body, &results); err != nil {
		slog.Warn("Failed to decode UAS call-results JSON",
			"url", url, "error", err)
		return nil
	}

	slog.Info("Collected UAS CallResults", "count", len(results), "url", url)
	return results
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

func overallMediaStatus(aPct, bPct float64) string {
	if deltaFlag(aPct) == "OK" && deltaFlag(bPct) == "OK" {
		return "OK"
	}
	return "DEGRADED"
}

func round1(v float64) float64 {
	return math.Round(v*10) / 10
}
