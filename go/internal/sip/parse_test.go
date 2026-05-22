package sip

import (
	"strings"
	"testing"
)

func TestParseMessagePreservesExactBody(t *testing.T) {
	body := "v=0\r\nc=IN IP4 10.0.0.1\r\nm=audio 40000 RTP/AVP 0\r\n"
	raw := "SIP/2.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: 999\r\n\r\n" + body
	msg, got, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("ParseMessage err=%v", err)
	}
	if msg.GetResponseCode() != "200" {
		t.Fatalf("code=%q, want 200", msg.GetResponseCode())
	}
	if got != body {
		t.Fatalf("body=%q, want %q", got, body)
	}
}

func TestParseHeadersCompactCaseInsensitiveAndFolded(t *testing.T) {
	msg := ParseHeaders("SIP/2.0 200 OK\r\ncontent-length: 12\r\nc: application/sdp\r\nSupported: replaces,\r\n 100rel\r\nv: SIP/2.0/TCP first\r\nVia: SIP/2.0/TCP second\r\nX-Trace-ID: abc\r\n\r\n")
	if got := msg.GetHeader(HdrContentLength); len(got) != 1 || got[0] != "12" {
		t.Fatalf("Content-Length=%v", got)
	}
	if got := msg.GetHeader(HdrContentType); len(got) != 1 || got[0] != "application/sdp" {
		t.Fatalf("Content-Type=%v", got)
	}
	if got := msg.GetHeader(HdrSupported); len(got) != 1 || got[0] != "replaces, 100rel" {
		t.Fatalf("Supported=%v", got)
	}
	if got := msg.GetHeader(HdrVia); len(got) != 2 || got[0] != "SIP/2.0/TCP first" || got[1] != "SIP/2.0/TCP second" {
		t.Fatalf("Via=%v", got)
	}
	if got := msg.GetHeader("X-Trace-ID"); len(got) != 1 || got[0] != "abc" {
		t.Fatalf("unknown header=%v", got)
	}
}

func TestParseMessageRequestLineAndExactBody(t *testing.T) {
	body := "hello\r\nworld"
	raw := "NOTIFY sip:6001@example.com SIP/2.0\r\nCall-ID: n1\r\nCSeq: 7 NOTIFY\r\nContent-Length: 999\r\n\r\n" + body
	msg, gotBody, err := ParseMessage(raw)
	if err != nil {
		t.Fatalf("ParseMessage err=%v", err)
	}
	if !msg.IsRequest() || msg.GetRequestURI() != "sip:6001@example.com" || msg.GetMethod() != "NOTIFY" {
		t.Fatalf("bad request parse line=%q uri=%q cseqMethod=%q", msg.GetRequestLine(), msg.GetRequestURI(), msg.GetMethod())
	}
	if gotBody != body {
		t.Fatalf("body=%q, want %q", gotBody, body)
	}
}

func TestParseHeadersDiagnosticsCounters(t *testing.T) {
	before := ParserHealthSnapshot()
	msg := ParseHeaders("SIP/2.0 200 OK\r\n orphan\r\nBadHeader\r\nContent-Length: 0\r\n\r\n")
	if msg.GetResponseCode() != "200" {
		t.Fatalf("response code=%q, want 200", msg.GetResponseCode())
	}
	after := ParserHealthSnapshot()
	if after.FoldedHeaderWithoutParent != before.FoldedHeaderWithoutParent+1 {
		t.Fatalf("folded counter=%d, want %d", after.FoldedHeaderWithoutParent, before.FoldedHeaderWithoutParent+1)
	}
	if after.MalformedHeader != before.MalformedHeader+1 {
		t.Fatalf("malformed counter=%d, want %d", after.MalformedHeader, before.MalformedHeader+1)
	}
}

func TestBuildMessageComputesContentLengthAndPreservesHeaderOrder(t *testing.T) {
	msg := NewSipMessage()
	msg.SetResponseLine("SIP/2.0 200 OK")
	msg.AddHeader(HdrVia, "SIP/2.0/TCP first;branch=1")
	msg.AddHeader(HdrVia, "SIP/2.0/TCP second;branch=2")
	msg.AddHeader(HdrContentLength, "999")

	raw := BuildMessage(msg, "v=0\r\n")
	if strings.Count(raw, "Content-Length:") != 1 {
		t.Fatalf("unexpected Content-Length count in:\n%s", raw)
	}
	if !strings.Contains(raw, "Content-Length: 5\r\n") {
		t.Fatalf("missing computed Content-Length 5 in:\n%s", raw)
	}
	if strings.Index(raw, "first;branch=1") > strings.Index(raw, "second;branch=2") {
		t.Fatalf("Via order not preserved:\n%s", raw)
	}
}
