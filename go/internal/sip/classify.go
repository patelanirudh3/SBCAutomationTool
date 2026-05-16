package sip

import (
	"log/slog"
	"strings"
)

// ClassifyMessage determines the SIP event code from a raw message.
//
// For responses (status line starts with "SIP/2.0"), the three-digit code is
// returned. For 200 responses the CSeq method is inspected to distinguish
// "200_PRACK", "200_INVITE", and "200_BYE" from a generic "200".
//
// For requests the method token (e.g. "INVITE", "BYE") is returned.
func ClassifyMessage(raw string) (eventCode string, rawMsg string) {
	firstLine, _, _ := strings.Cut(raw, CRLF)
	firstLine = strings.TrimSpace(firstLine)

	if strings.HasPrefix(firstLine, "SIP/2.0") {
		parts := strings.SplitN(firstLine, " ", 3)
		code := "UNKNOWN"
		if len(parts) > 1 {
			code = parts[1]
		}
		method := cseqMethod(raw)
		if code == "200" {
			switch method {
			case "PRACK":
				slog.Debug("ClassifyMessage", "eventCode", "200_PRACK", "code", code, "method", method)
				return "200_PRACK", raw
			case "INVITE":
				slog.Debug("ClassifyMessage", "eventCode", "200_INVITE", "code", code, "method", method)
				return "200_INVITE", raw
			case "BYE":
				slog.Debug("ClassifyMessage", "eventCode", "200_BYE", "code", code, "method", method)
				return "200_BYE", raw
			case "CANCEL":
				slog.Debug("ClassifyMessage", "eventCode", "200_CANCEL", "code", code, "method", method)
				return "200_CANCEL", raw
			}
		}
		if code == "401" {
			switch method {
			case "INVITE":
				slog.Debug("ClassifyMessage", "eventCode", "401_INVITE", "code", code, "method", method)
				return "401_INVITE", raw
			case "PRACK":
				slog.Debug("ClassifyMessage", "eventCode", "401_PRACK", "code", code, "method", method)
				return "401_PRACK", raw
			case "BYE":
				slog.Debug("ClassifyMessage", "eventCode", "401_BYE", "code", code, "method", method)
				return "401_BYE", raw
			}
		}
		if code == "407" {
			switch method {
			case "INVITE":
				slog.Debug("ClassifyMessage", "eventCode", "407_INVITE", "code", code, "method", method)
				return "407_INVITE", raw
			case "PRACK":
				slog.Debug("ClassifyMessage", "eventCode", "407_PRACK", "code", code, "method", method)
				return "407_PRACK", raw
			case "BYE":
				slog.Debug("ClassifyMessage", "eventCode", "407_BYE", "code", code, "method", method)
				return "407_BYE", raw
			}
		}
		ec := code
		if ec == "" || firstLine == "" {
			slog.Warn("ClassifyMessage: unexpected empty classification",
				"eventCode", ec, "code", code, "method", method,
				"firstLine", firstLine, "rawLen", len(raw),
				"rawHead", truncHead(raw, 120))
		} else {
			slog.Debug("ClassifyMessage", "eventCode", ec, "code", code, "method", method)
		}
		return ec, raw
	}

	method := strings.SplitN(firstLine, " ", 2)[0]
	if method == "" {
		slog.Warn("ClassifyMessage: empty method from request line",
			"firstLine", firstLine, "rawLen", len(raw),
			"rawHead", truncHead(raw, 120))
	} else {
		slog.Debug("ClassifyMessage", "eventCode", method, "method", method)
	}
	return method, raw
}

// IsFinalFailureCode returns true for a 3-digit SIP status code that is a
// non-success final response not covered by an explicit handler — i.e. any
// 4xx, 5xx, or 6xx response other than 401 and 407, which carry their own
// dedicated event codes (e.g. "401_INVITE", "407_PRACK", "407_BYE").
//
// The CallEngine uses this together with the synthetic "_FINAL_FAIL"
// wildcard event so that final-failure responses are processed via the
// SendAckForFailure path (RFC 3261 §17.1.1.3) instead of timing out and
// triggering an incorrect CANCEL.
func IsFinalFailureCode(code string) bool {
	if len(code) != 3 {
		return false
	}
	if code == "401" || code == "407" {
		return false
	}
	switch code[0] {
	case '4', '5', '6':
		return true
	}
	return false
}

func truncHead(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// cseqMethod extracts the method token from the CSeq header
// (e.g. "CSeq: 1 INVITE" → "INVITE"). Returns empty string if not found.
func cseqMethod(raw string) string {
	for _, line := range strings.Split(raw, CRLF) {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		if !strings.HasPrefix(lower, "cseq:") {
			continue
		}
		val := strings.TrimSpace(trimmed[len("cseq:"):])
		parts := strings.Fields(val)
		if len(parts) >= 2 {
			return strings.ToUpper(parts[len(parts)-1])
		}
		return ""
	}
	return ""
}
