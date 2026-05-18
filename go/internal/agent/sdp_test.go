package agent

import "testing"

func TestParseSDPMediaSessionConnection(t *testing.T) {
	ip, port := ParseSDPMedia("v=0\r\nc=IN IP4 10.0.0.10\r\nm=audio 40000 RTP/AVP 0\r\n")
	if ip != "10.0.0.10" || port != 40000 {
		t.Fatalf("ParseSDPMedia=%s:%d", ip, port)
	}
}

func TestParseSDPMediaMediaConnectionAfterAudio(t *testing.T) {
	ip, port := ParseSDPMedia("v=0\r\nm=audio 52024 RTP/AVP 0\r\nc=IN IP4 10.133.48.203\r\n")
	if ip != "10.133.48.203" || port != 52024 {
		t.Fatalf("ParseSDPMedia=%s:%d", ip, port)
	}
}

func TestParseSDPMediaMediaConnectionOverridesSession(t *testing.T) {
	ip, port := ParseSDPMedia("v=0\nc=IN IP4 10.0.0.1\nm=video 9 RTP/AVP 99\nc=IN IP4 10.0.0.2\nm=audio 50000 RTP/AVP 0\nc=IN IP4 10.0.0.3\n")
	if ip != "10.0.0.3" || port != 50000 {
		t.Fatalf("ParseSDPMedia=%s:%d", ip, port)
	}
}
