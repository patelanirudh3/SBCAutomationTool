package rtp

import (
	"fmt"
	"math"
	"strings"
)

const (
	ulawBias = 0x84
	ulawClip = 32635
)

type CodecProfile struct {
	Name                 string
	PayloadType          int
	ClockRate            int
	FrameDurationMs      int
	BytesPerFrame        int
	PayloadMarkerEnabled bool
}

func ProfileForCodec(codec string) CodecProfile {
	switch strings.ToUpper(strings.TrimSpace(codec)) {
	case "G711_ALAW":
		return CodecProfile{Name: "G711_ALAW", PayloadType: 8, ClockRate: 8000, FrameDurationMs: 1, BytesPerFrame: 1, PayloadMarkerEnabled: true}
	case "G729":
		return CodecProfile{Name: "G729", PayloadType: 18, ClockRate: 8000, FrameDurationMs: 10, BytesPerFrame: 10, PayloadMarkerEnabled: false}
	default:
		return CodecProfile{Name: "G711_ULAW", PayloadType: 0, ClockRate: 8000, FrameDurationMs: 1, BytesPerFrame: 1, PayloadMarkerEnabled: true}
	}
}

// LinearToUlaw converts a signed 16-bit linear PCM sample to G.711 mu-law.
func LinearToUlaw(sample int16) byte {
	var sign byte
	s := int(sample)
	if s < 0 {
		sign = 0x80
		s = -s
	}
	if s > ulawClip {
		s = ulawClip
	}
	s += ulawBias

	exponent := 7
	for _, threshold := range []int{0x4000, 0x2000, 0x1000, 0x800, 0x400, 0x200, 0x100} {
		if s >= threshold {
			break
		}
		exponent--
	}

	mantissa := (s >> (uint(exponent) + 3)) & 0x0F
	return ^(sign | byte(exponent<<4) | byte(mantissa)) & 0xFF
}

// LinearToAlaw converts a signed 16-bit linear PCM sample to G.711 A-law.
func LinearToAlaw(sample int16) byte {
	s := int(sample)
	mask := byte(0xD5)
	if s < 0 {
		mask = 0x55
		s = -s - 1
	}
	if s > 32635 {
		s = 32635
	}

	var aval byte
	if s >= 256 {
		seg := 7
		for threshold := 0x4000; seg > 0 && s < threshold; threshold >>= 1 {
			seg--
		}
		aval = byte(seg<<4) | byte((s>>(uint(seg)+3))&0x0F)
	} else {
		aval = byte(s >> 4)
	}
	return aval ^ mask
}

// g729ToneFrames are pre-encoded 10 ms G.729 frames generated offline from a
// steady narrowband tone. The RTP endpoint treats them as opaque codec bytes and
// never embeds validation markers inside them.
var g729ToneFrames = [][]byte{
	{0x6f, 0xa1, 0x20, 0xc8, 0x9a, 0x56, 0x22, 0x32, 0x15, 0x0f},
	{0x70, 0x11, 0x22, 0x48, 0x8b, 0x57, 0x20, 0x31, 0x17, 0x10},
	{0x6e, 0x91, 0x24, 0xc7, 0x9c, 0x55, 0x23, 0x33, 0x14, 0x0e},
	{0x71, 0x01, 0x21, 0x49, 0x89, 0x58, 0x21, 0x30, 0x18, 0x11},
}

// ComputePtimeParams returns the RTP timestamp increment, payload size,
// PCMU-encoded 1 kHz tone payload, and marker template for a given ptime.
func ComputePtimeParams(ptimeMs int) (tsInc int, payloadSize int, tonePayload []byte, markerTemplate []byte) {
	return ComputeCodecPtimeParams("G711_ULAW", ptimeMs)
}

func ComputeCodecPtimeParams(codec string, ptimeMs int) (tsInc int, payloadSize int, tonePayload []byte, markerTemplate []byte) {
	profile := ProfileForCodec(codec)
	samples := 8000 * ptimeMs / 1000
	tsInc = samples

	if profile.Name == "G729" {
		if ptimeMs%profile.FrameDurationMs != 0 {
			ptimeMs = ((ptimeMs + profile.FrameDurationMs - 1) / profile.FrameDurationMs) * profile.FrameDurationMs
			tsInc = 8000 * ptimeMs / 1000
		}
		framesPerPacket := ptimeMs / profile.FrameDurationMs
		if framesPerPacket <= 0 {
			framesPerPacket = 1
		}
		payload := make([]byte, 0, framesPerPacket*profile.BytesPerFrame)
		for i := 0; i < framesPerPacket; i++ {
			payload = append(payload, g729ToneFrames[i%len(g729ToneFrames)]...)
		}
		return tsInc, len(payload), payload, nil
	}

	tone := make([]byte, samples)
	for i := 0; i < samples; i++ {
		t := float64(i) / float64(SampleRate)
		linear := int16(16384.0 * math.Sin(2.0*math.Pi*1000.0*t))
		if profile.Name == "G711_ALAW" {
			tone[i] = LinearToAlaw(linear)
		} else {
			tone[i] = LinearToUlaw(linear)
		}
	}
	tonePayload = tone

	marker := make([]byte, samples)
	if len(marker) < 8 {
		panic(fmt.Sprintf("ptime %d produced marker payload too small", ptimeMs))
	}
	copy(marker[0:4], MarkerMagic)
	// bytes 4-7 stay zero (placeholder for sequence)
	copy(marker[8:], tonePayload[8:])
	markerTemplate = marker

	return tsInc, samples, tonePayload, markerTemplate
}

// Pre-computed default 20 ms payloads.
var (
	DefaultTsInc          int
	DefaultPayloadSize    int
	DefaultTonePayload    []byte
	DefaultMarkerTemplate []byte
)

func init() {
	DefaultTsInc, DefaultPayloadSize, DefaultTonePayload, DefaultMarkerTemplate =
		ComputePtimeParams(20)
}
