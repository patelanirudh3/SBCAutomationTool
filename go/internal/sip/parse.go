package sip

import (
	"fmt"
	"strconv"
	"strings"
)

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

	lastHeader := ""
	for _, line := range lines[1:] {
		if line == "" {
			continue
		}
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && lastHeader != "" {
			vals := msg.headers[lastHeader]
			if len(vals) > 0 {
				vals[len(vals)-1] = vals[len(vals)-1] + " " + strings.TrimSpace(line)
				msg.headers[lastHeader] = vals
				for i := len(msg.headerOrder) - 1; i >= 0; i-- {
					if msg.headerOrder[i].name == lastHeader {
						msg.headerOrder[i].value = vals[len(vals)-1]
						break
					}
				}
			}
			continue
		}
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		name := line[:idx]
		value := strings.TrimSpace(line[idx+1:])
		msg.AddHeader(name, value)
		lastHeader = NormalizeHeaderName(name)
	}
	return msg
}

// ParseMessage splits a complete SIP message into parsed headers and its exact
// body. Transport framing has already applied Content-Length; this helper does
// not read beyond the header/body separator.
func ParseMessage(raw string) (*SipMessage, string, error) {
	parts := strings.SplitN(raw, CRLFCRLF, 2)
	if len(parts) != 2 {
		return ParseHeaders(raw), "", fmt.Errorf("sip message missing header/body separator")
	}
	return ParseHeaders(parts[0]), parts[1], nil
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

	for _, h := range msg.orderedHeaders() {
		if h.name == HdrContentLength {
			continue
		}
		b.WriteString(h.name)
		b.WriteString(": ")
		b.WriteString(h.value)
		b.WriteString(CRLF)
	}
	b.WriteString(HdrContentLength)
	b.WriteString(": ")
	b.WriteString(strconv.Itoa(len(content)))
	b.WriteString(CRLF)

	b.WriteString(CRLF)
	b.WriteString(content)

	return b.String()
}
