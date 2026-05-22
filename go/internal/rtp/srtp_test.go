package rtp

import (
	"bytes"
	"testing"
)

func TestSRTPProtectUnprotectRoundTrip(t *testing.T) {
	a, err := NewRtpEndpointFull("127.0.0.1", 20, true, false, 0)
	if err != nil {
		t.Fatalf("endpoint A: %v", err)
	}
	defer a.Close()
	b, err := NewRtpEndpointFull("127.0.0.1", 20, true, false, 0)
	if err != nil {
		t.Fatalf("endpoint B: %v", err)
	}
	defer b.Close()

	keyA := bytes.Repeat([]byte{0xA1}, 30)
	keyB := bytes.Repeat([]byte{0xB2}, 30)
	if err := a.ConfigureSRTP(SRTPSessionConfig{Enabled: true, CryptoSuite: "AES_CM_128_HMAC_SHA1_80", OutboundKeySalt: keyA, InboundKeySalt: keyB}); err != nil {
		t.Fatalf("configure A: %v", err)
	}
	if err := b.ConfigureSRTP(SRTPSessionConfig{Enabled: true, CryptoSuite: "AES_CM_128_HMAC_SHA1_80", OutboundKeySalt: keyB, InboundKeySalt: keyA}); err != nil {
		t.Fatalf("configure B: %v", err)
	}

	plain := packRTP(1, 160, 0x11223344, []byte{1, 2, 3, 4}, true)
	protected, err := a.protectRTP(plain)
	if err != nil {
		t.Fatalf("protect: %v", err)
	}
	if bytes.Equal(protected, plain) {
		t.Fatal("protected packet equals plain RTP")
	}
	got, err := b.unprotectRTP(protected)
	if err != nil {
		t.Fatalf("unprotect: %v", err)
	}
	if !bytes.Equal(got, plain) {
		t.Fatalf("unprotected packet mismatch")
	}
}
