package sip

import "strings"

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
		if code == "200" {
			method := cseqMethod(raw)
			switch method {
			case "PRACK":
				return "200_PRACK", raw
			case "INVITE":
				return "200_INVITE", raw
			case "BYE":
				return "200_BYE", raw
			case "CANCEL":
				return "200_CANCEL", raw
			}
		}
		if code == "407" && cseqMethod(raw) == "PRACK" {
			return "407_PRACK", raw
		}
		return code, raw
	}

	method := strings.SplitN(firstLine, " ", 2)[0]
	return method, raw
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
