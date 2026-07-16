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

func TestG729AudioCodecUsesStandardG729Profile(t *testing.T) {
	profile := ProfileForCodec("G729_AUDIO")
	if profile.Name != "G729" || profile.PayloadType != 18 {
		t.Fatalf("profile=%+v, want canonical G729 payload type 18", profile)
	}
	if !IsG729PreEncodedAudio("G729_AUDIO") || IsG729PreEncodedAudio("G729") {
		t.Fatal("G729 audio source detection mismatch")
	}
}

func TestG729PreEncodedAudioSourceAdvancesThroughStream(t *testing.T) {
	source := newG729PreEncodedAudioSource(20)
	first := append([]byte(nil), source.NextPayload()...)
	second := append([]byte(nil), source.NextPayload()...)
	if len(first) != 20 || len(second) != 20 {
		t.Fatalf("payload sizes=%d,%d want 20,20", len(first), len(second))
	}
	if string(first) == string(second) {
		t.Fatal("pre-encoded audio source did not advance to the next frames")
	}
	wantLen := G729PreEncodedAudioDurationSeconds * 1000 / ProfileForCodec("G729").FrameDurationMs * ProfileForCodec("G729").BytesPerFrame
	if len(g729PreEncodedAudioStream) != wantLen {
		t.Fatalf("embedded audio stream len=%d, want %d", len(g729PreEncodedAudioStream), wantLen)
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
