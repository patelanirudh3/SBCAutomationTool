package agent

import (
	"strings"
	"testing"

	"github.com/cci/traffic-engine/internal/config"
)

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

func TestParseSDPMediaInfoExtractsOfferedCodecs(t *testing.T) {
	info := ParseSDPMediaInfo("v=0\r\nc=IN IP4 10.0.0.1\r\nm=audio 50000 RTP/AVP 18 0 8 101\r\na=rtpmap:18 G729/8000\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:101 telephone-event/8000\r\n")
	got := strings.Join(info.OfferedCodecs(), ",")
	if got != "G729,G711_ULAW,G711_ALAW" {
		t.Fatalf("offered codecs=%q", got)
	}
	if !info.HasCodec("G729") || !info.HasCodec("PCMU") || !info.HasCodec("PCMA") {
		t.Fatalf("codec lookup failed: %+v", info.PayloadCodecs)
	}
}

func TestNegotiateSingleCodecFallbackAndReject(t *testing.T) {
	offer := ParseSDPMediaInfo("v=0\r\nc=IN IP4 10.0.0.1\r\nm=audio 50000 RTP/AVP 0 8 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\n")
	codec, fallback, reject := NegotiateSingleCodec(offer, "G729", "fallback_g711")
	if codec != "G711_ULAW" || !fallback || reject != "" {
		t.Fatalf("fallback negotiation codec=%q fallback=%v reject=%q", codec, fallback, reject)
	}
	codec, fallback, reject = NegotiateSingleCodec(offer, "G729", "reject_488")
	if codec != "" || fallback || reject == "" {
		t.Fatalf("reject negotiation codec=%q fallback=%v reject=%q", codec, fallback, reject)
	}
}

func TestBuildSDPWithSRTPCryptoLines(t *testing.T) {
	sdp := BuildSDPWithOptions("10.0.0.1", 40000, SDPOptions{
		MediaSecurity: "srtp_sdes",
		SRTPCryptoLines: []string{
			"a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abc",
			"a=crypto:2 AES_CM_128_HMAC_SHA1_32 inline:def",
		},
	})
	if !strings.Contains(sdp, "m=audio 40000 RTP/SAVP 0 8 101") {
		t.Fatalf("SRTP SDP missing RTP/SAVP:\n%s", sdp)
	}
	if !strings.Contains(sdp, "a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abc") ||
		!strings.Contains(sdp, "a=crypto:2 AES_CM_128_HMAC_SHA1_32 inline:def") {
		t.Fatalf("SRTP SDP missing crypto lines:\n%s", sdp)
	}
}

func TestBuildSDPWithG729(t *testing.T) {
	sdp := BuildSDPWithOptions("10.0.0.1", 40000, SDPOptions{
		RTPCodec: "G729",
		RTPPtime: 20,
	})
	if !strings.Contains(sdp, "m=audio 40000 RTP/AVP 18 101") {
		t.Fatalf("G729 SDP missing payload 18:\n%s", sdp)
	}
	if !strings.Contains(sdp, "a=rtpmap:18 G729/8000") ||
		!strings.Contains(sdp, "a=fmtp:18 annexb=no") ||
		!strings.Contains(sdp, "a=ptime:20") {
		t.Fatalf("G729 SDP missing codec attributes:\n%s", sdp)
	}
}

func TestBuildSDPWithG729AudioAdvertisesStandardG729(t *testing.T) {
	sdp := BuildSDPWithOptions("10.0.0.1", 40000, SDPOptions{
		RTPCodec: "G729_AUDIO",
		RTPPtime: 20,
	})
	if !strings.Contains(sdp, "m=audio 40000 RTP/AVP 18 101") ||
		!strings.Contains(sdp, "a=rtpmap:18 G729/8000") ||
		!strings.Contains(sdp, "a=fmtp:18 annexb=no") {
		t.Fatalf("G729_AUDIO SDP should advertise standard G729:\n%s", sdp)
	}
	codec, fallback, reject := NegotiateSingleCodec(ParseSDPMediaInfo(sdp), "G729_AUDIO", "reject_488")
	if codec != "G729" || fallback || reject != "" {
		t.Fatalf("codec=%q fallback=%v reject=%q, want canonical G729", codec, fallback, reject)
	}
}

func TestGenerateSRTPCryptoOffers(t *testing.T) {
	offers, err := GenerateSRTPCryptoOffers([]string{"AES_CM_128_HMAC_SHA1_80", "AES_CM_128_HMAC_SHA1_32"})
	if err != nil {
		t.Fatalf("GenerateSRTPCryptoOffers err=%v", err)
	}
	if len(offers) != 2 || offers[0].Tag != 1 || offers[1].Tag != 2 {
		t.Fatalf("unexpected offers=%+v", offers)
	}
	if len(offers[0].KeySalt) != 30 || offers[0].SDPLine == "" || offers[0].KeyParams == "" {
		t.Fatalf("bad offer=%+v", offers[0])
	}
}

func TestHandleIncomingInviteStoresSRTPRemoteCrypto(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{Domain: "avaya.com", SIPTransport: "TLS", SIPScheme: "SIPS"}
	a.Config.MediaSecurity = "srtp_sdes"
	body := "v=0\r\nc=IN IP4 10.0.0.1\r\nm=audio 50000 RTP/SAVP 0\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abc123\r\n"
	raw := "INVITE sips:6000000@avaya.com SIP/2.0\r\n" +
		"Call-ID: srtp-invite\r\n" +
		"From: <sips:6000001@avaya.com>;tag=remote\r\n" +
		"To: <sips:6000000@avaya.com>\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"Via: SIP/2.0/TLS 10.0.0.1:5061;branch=z9hG4bK1\r\n" +
		"Content-Type: application/sdp\r\n" +
		"Content-Length: 0\r\n\r\n" + body
	dialog, err := a.HandleIncomingInvite(raw)
	if err != nil {
		t.Fatalf("HandleIncomingInvite err=%v", err)
	}
	if dialog.MediaSecurity != "srtp_sdes" {
		t.Fatalf("media security=%q, want srtp_sdes", dialog.MediaSecurity)
	}
	if len(dialog.SRTPRemoteCrypto.CryptoLines) != 1 {
		t.Fatalf("remote crypto lines=%v, want 1", dialog.SRTPRemoteCrypto.CryptoLines)
	}
	if dialog.SRTPRemoteCrypto.CryptoLines[0].Suite != "AES_CM_128_HMAC_SHA1_80" {
		t.Fatalf("remote crypto=%+v", dialog.SRTPRemoteCrypto.CryptoLines[0])
	}
}

func TestParseSDPMediaInfoReportsMissingAudio(t *testing.T) {
	info := ParseSDPMediaInfo("v=0\r\nc=IN IP4 10.0.0.1\r\nm=video 9 RTP/AVP 99\r\n")
	if info.HasAudio || info.Port != 0 {
		t.Fatalf("expected no audio, got %+v", info)
	}
}
