package rtp

import "testing"

func TestG729PtimePayloadUsesTwoTenMsFrames(t *testing.T) {
	tsInc, payloadSize, payload, marker := ComputeCodecPtimeParams("G729", 20)
	if tsInc != 160 {
		t.Fatalf("tsInc=%d, want 160", tsInc)
	}
	if payloadSize != 20 || len(payload) != 20 {
		t.Fatalf("G729 payload size=%d len=%d, want 20", payloadSize, len(payload))
	}
	if marker != nil {
		t.Fatalf("G729 marker template=%v, want nil", marker)
	}
}

func TestPackRTPWithG729PayloadType(t *testing.T) {
	payload := make([]byte, 20)
	pkt := packRTPWithPayloadType(7, 160, 1234, payload, ProfileForCodec("G729").PayloadType, false)
	if len(pkt) != 32 {
		t.Fatalf("packet len=%d, want 32", len(pkt))
	}
	if pkt[1] != 18 {
		t.Fatalf("payload type byte=%d, want 18", pkt[1])
	}
}
