package sip

import "testing"

func TestExtractSIPMessageUsesStrictContentLength(t *testing.T) {
	body := "v=0\r\n"
	extra := "m=audio 50000 RTP/AVP 0\r\n"
	next := "SIP/2.0 200 OK\r\nContent-Length: 0\r\n\r\n"
	raw := "SIP/2.0 200 OK\r\nContent-Type: application/sdp\r\nContent-Length: 5\r\n\r\n" + body + extra + next

	msg, consumed := extractSIPMessage([]byte(raw))
	if consumed != len(raw)-len(extra)-len(next) {
		t.Fatalf("consumed=%d, want %d", consumed, len(raw)-len(extra)-len(next))
	}
	_, gotBody, err := ParseMessage(msg)
	if err != nil {
		t.Fatalf("ParseMessage err=%v", err)
	}
	if gotBody != body {
		t.Fatalf("body=%q, want %q", gotBody, body)
	}
}

func TestExtractSIPMessageWaitsForFragmentedBody(t *testing.T) {
	raw := "SIP/2.0 200 OK\r\nContent-Length: 10\r\n\r\n12345"
	msg, consumed := extractSIPMessage([]byte(raw))
	if msg != "" || consumed != 0 {
		t.Fatalf("extractSIPMessage=%q,%d, want empty,0", msg, consumed)
	}
}
