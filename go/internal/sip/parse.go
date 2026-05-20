package sip

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseHeaders parses a SIP start-line + header block into a SipMessage.
// It scans line-by-line instead of splitting the whole message, preserving
// header order, duplicate headers, unknown headers, and folded continuation
// lines while normalizing lookup names.
func ParseHeaders(raw string) *SipMessage {
	msg := NewSipMessage()
	first, next, ok := scanLine(raw, 0)
	if !ok {
		return msg
	}
	if strings.HasPrefix(first, "SIP/2.0") {
		msg.SetResponseLine(first)
	} else {
		msg.SetRequestLine(first)
	}

	lastHeader := ""
	for next <= len(raw) {
		line, after, ok := scanLine(raw, next)
		if !ok {
			break
		}
		next = after
		if line == "" {
			break
		}
		if (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) && lastHeader != "" {
			msg.appendFoldedHeader(lastHeader, strings.TrimSpace(line))
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

// ParseMessage parses a complete SIP message into headers and the exact body
// bytes delivered by transport framing. It does not read beyond the first
// CRLFCRLF separator and does not trust Content-Length inside this already
// framed message.
func ParseMessage(raw string) (*SipMessage, string, error) {
	sep := strings.Index(raw, CRLFCRLF)
	if sep < 0 {
		return ParseHeaders(raw), "", fmt.Errorf("sip message missing header/body separator")
	}
	return ParseHeaders(raw[:sep]), raw[sep+len(CRLFCRLF):], nil
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

func scanLine(s string, offset int) (line string, next int, ok bool) {
	if offset > len(s) {
		return "", offset, false
	}
	if offset == len(s) {
		return "", offset, false
	}
	if idx := strings.Index(s[offset:], CRLF); idx >= 0 {
		start := offset
		end := offset + idx
		return s[start:end], end + len(CRLF), true
	}
	return s[offset:], len(s), true
}
