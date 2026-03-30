package sip

import "strings"

// ParseHeaders splits a raw SIP message (headers only, no body) into a
// SipMessage. The first line is treated as a request-line or status-line
// depending on whether it starts with "SIP/2.0". Remaining lines are
// parsed as "Header-Name: value" pairs and normalized.
func ParseHeaders(raw string) *SipMessage {
	lines := strings.Split(raw, CRLF)
	msg := NewSipMessage()

	if len(lines) == 0 {
		return msg
	}

	first := lines[0]
	if strings.HasPrefix(first, "SIP/2.0") {
		msg.SetResponseLine(first)
	} else {
		msg.SetRequestLine(first)
	}

	for _, line := range lines[1:] {
		if line == "" {
			continue
		}
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := line[:idx]
		value := strings.TrimSpace(line[idx+1:])
		msg.AddHeader(name, value)
	}
	return msg
}

// BuildMessage serializes a SipMessage back into a raw SIP wire-format string.
// The optional content parameter is appended after the blank line separator
// (typically SDP). Pass an empty string for no body.
func BuildMessage(msg *SipMessage, content string) string {
	var b strings.Builder

	if msg.GetRequestLine() != "" {
		b.WriteString(msg.GetRequestLine())
	} else {
		b.WriteString(msg.GetResponseLine())
	}
	b.WriteString(CRLF)

	for name, vals := range msg.GetAllHeaders() {
		for _, v := range vals {
			b.WriteString(name)
			b.WriteString(": ")
			b.WriteString(v)
			b.WriteString(CRLF)
		}
	}

	b.WriteString(CRLF)
	b.WriteString(content)

	return b.String()
}
