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

func TestParseSDPMediaInfoExtractsProtocolPayloadsAndCrypto(t *testing.T) {
	info := ParseSDPMediaInfo("v=0\r\nc=IN IP4 10.0.0.1\r\nm=audio 50000 RTP/SAVP 0 8 101\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abc123\r\na=rtcp-mux\r\n")
	if info.IP != "10.0.0.1" || info.Port != 50000 || info.Proto != "RTP/SAVP" {
		t.Fatalf("media info ip=%s port=%d proto=%s", info.IP, info.Port, info.Proto)
	}
	if !info.HasAudio || !info.HasSessionConn || info.HasMediaConn {
		t.Fatalf("media flags=%+v", info)
	}
	if len(info.PayloadTypes) != 3 || info.PayloadTypes[0] != 0 || info.PayloadTypes[2] != 101 {
		t.Fatalf("payloads=%v", info.PayloadTypes)
	}
	if info.CryptoSuite != "AES_CM_128_HMAC_SHA1_80" || info.CryptoKeyParams != "inline:abc123" || !info.RTCPMux {
		t.Fatalf("crypto/mux info=%+v", info)
	}
}

func TestParseSDPMediaInfoReportsMissingAudio(t *testing.T) {
	info := ParseSDPMediaInfo("v=0\r\nc=IN IP4 10.0.0.1\r\nm=video 9 RTP/AVP 99\r\n")
	if info.HasAudio || info.Port != 0 {
		t.Fatalf("expected no audio, got %+v", info)
	}
}
