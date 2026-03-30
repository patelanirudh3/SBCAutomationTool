package rtp

import "math"

const (
	ulawBias = 0x84
	ulawClip = 32635
)

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

// ComputePtimeParams returns the RTP timestamp increment, payload size,
// PCMU-encoded 1 kHz tone payload, and marker template for a given ptime.
func ComputePtimeParams(ptimeMs int) (tsInc int, payloadSize int, tonePayload []byte, markerTemplate []byte) {
	samples := 8000 * ptimeMs / 1000
	tsInc = samples

	tone := make([]byte, samples)
	for i := 0; i < samples; i++ {
		t := float64(i) / float64(SampleRate)
		linear := int16(16384.0 * math.Sin(2.0*math.Pi*1000.0*t))
		tone[i] = LinearToUlaw(linear)
	}
	tonePayload = tone

	marker := make([]byte, samples)
	copy(marker[0:4], MarkerMagic)
	// bytes 4-7 stay zero (placeholder for sequence)
	copy(marker[8:], tonePayload[8:])
	markerTemplate = marker

	return tsInc, samples, tonePayload, markerTemplate
}

// Pre-computed default 20 ms payloads.
var (
	DefaultTsInc         int
	DefaultPayloadSize   int
	DefaultTonePayload   []byte
	DefaultMarkerTemplate []byte
)

func init() {
	DefaultTsInc, DefaultPayloadSize, DefaultTonePayload, DefaultMarkerTemplate =
		ComputePtimeParams(20)
}
