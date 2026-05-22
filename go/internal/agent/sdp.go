package agent

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// sdpSessionCounter is incremented per BuildSDP call to guarantee uniqueness
// even when two SDPs are generated within the same nanosecond on the same
// host (e.g. burst of concurrent INVITEs at high CPS).
var sdpSessionCounter uint64

type SDPOptions struct {
	RTCPMux         bool
	MediaSecurity   string
	SRTPCryptoLines []string
}

// BuildSDP builds a G.711 audio SDP for the given local host and RTP port.
// The o= line carries a unique session-id derived from a process-local
// monotonic timestamp combined with an atomic counter, satisfying RFC 4566
// §5.2 ("the session id MUST be unique"). The session-version is fixed at 1
// because we do not currently emit re-INVITEs that modify the SDP body.
//
// When rtcpMux is true an a=rtcp-mux attribute is appended (RFC 5761),
// signalling that the same UDP port carries both RTP and RTCP. Phase 2
// — only enabled when the endpoint will also transmit RTCP SR.
func BuildSDP(localHost string, rtpPort int, rtcpMux bool) string {
	return BuildSDPWithOptions(localHost, rtpPort, SDPOptions{RTCPMux: rtcpMux})
}

func BuildSDPWithOptions(localHost string, rtpPort int, opts SDPOptions) string {
	sessID := uint64(time.Now().UnixNano()) ^ atomic.AddUint64(&sdpSessionCounter, 1)
	rtcpMuxLine := ""
	if opts.RTCPMux {
		rtcpMuxLine = "a=rtcp-mux\r\n"
	}
	proto := "RTP/AVP"
	cryptoLines := ""
	if opts.MediaSecurity == "srtp_sdes" {
		proto = "RTP/SAVP"
		for _, line := range opts.SRTPCryptoLines {
			if strings.TrimSpace(line) != "" {
				cryptoLines += line + "\r\n"
			}
		}
	}
	return fmt.Sprintf(
		"v=0\r\n"+
			"o=- %d 1 IN IP4 %s\r\n"+
			"s=-\r\n"+
			"c=IN IP4 %s\r\n"+
			"t=0 0\r\n"+
			"m=audio %d %s 0 8 101\r\n"+
			"a=rtpmap:0 PCMU/8000\r\n"+
			"a=rtpmap:8 PCMA/8000\r\n"+
			"a=rtpmap:101 telephone-event/8000\r\n"+
			"a=fmtp:101 0-15\r\n"+
			"a=ptime:20\r\n"+
			"a=sendrecv\r\n"+
			"%s"+
			"%s",
		sessID, localHost, localHost, rtpPort, proto, cryptoLines, rtcpMuxLine,
	)
}

type SRTPCryptoOffer struct {
	Tag       int
	Suite     string
	KeySalt   []byte
	SDPLine   string
	KeyParams string
}

func GenerateSRTPCryptoOffers(suites []string) ([]SRTPCryptoOffer, error) {
	out := make([]SRTPCryptoOffer, 0, len(suites))
	for i, suite := range suites {
		keySalt := make([]byte, 30)
		if _, err := rand.Read(keySalt); err != nil {
			return nil, err
		}
		keyParams := "inline:" + base64.StdEncoding.EncodeToString(keySalt)
		tag := i + 1
		out = append(out, SRTPCryptoOffer{
			Tag:       tag,
			Suite:     suite,
			KeySalt:   keySalt,
			KeyParams: keyParams,
			SDPLine:   fmt.Sprintf("a=crypto:%d %s %s", tag, suite, keyParams),
		})
	}
	return out, nil
}

// SDPMediaInfo is a strict summary of the audio media section needed by the
// traffic engine. It intentionally keeps most SDP values as raw strings so SRTP
// support can validate protocols/crypto without a full SDP object model.
type SDPMediaInfo struct {
	IP              string
	Port            int
	MediaType       string
	Proto           string
	PayloadTypes    []int
	CryptoSuite     string
	CryptoKeyParams string
	CryptoLines     []SRTPCryptoOffer
	RTCPMux         bool
	HasSessionConn  bool
	HasMediaConn    bool
	HasAudio        bool
}

// ParseSDPMedia extracts the RTP IP and port from an SDP body.
func ParseSDPMedia(sdpBody string) (ip string, port int) {
	info := ParseSDPMediaInfo(sdpBody)
	return info.IP, info.Port
}

// ParseSDPMediaInfo extracts audio media, connection, RTP profile, and basic
// SRTP crypto details from SDP. It scans line by line and does not recover
// missing fields; callers can inspect HasAudio/IP/Port/Proto for diagnostics.
func ParseSDPMediaInfo(sdpBody string) SDPMediaInfo {
	var info SDPMediaInfo
	sessionIP := ""
	mediaIP := ""
	inAudio := false

	for offset := 0; offset < len(sdpBody); {
		line, next := nextSDPLine(sdpBody, offset)
		offset = next
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		switch {
		case strings.HasPrefix(line, "c=IN "):
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				if inAudio {
					mediaIP = parts[2]
					info.HasMediaConn = true
				} else {
					sessionIP = parts[2]
					info.HasSessionConn = true
				}
			}
		case strings.HasPrefix(line, "m="):
			parts := strings.Fields(line)
			if len(parts) < 4 {
				inAudio = false
				continue
			}
			mediaType := strings.TrimPrefix(parts[0], "m=")
			inAudio = mediaType == "audio"
			if inAudio {
				info.HasAudio = true
				info.MediaType = mediaType
				if p, err := strconv.Atoi(parts[1]); err == nil && p > 0 {
					info.Port = p
				}
				info.Proto = parts[2]
				info.PayloadTypes = info.PayloadTypes[:0]
				for _, ptRaw := range parts[3:] {
					if pt, err := strconv.Atoi(ptRaw); err == nil {
						info.PayloadTypes = append(info.PayloadTypes, pt)
					}
				}
			}
		case inAudio && strings.HasPrefix(line, "a=crypto:"):
			parseCryptoLine(line, &info)
		case inAudio && strings.EqualFold(line, "a=rtcp-mux"):
			info.RTCPMux = true
		}
	}
	if mediaIP != "" {
		info.IP = mediaIP
	} else {
		info.IP = sessionIP
	}
	if !info.HasAudio || info.IP == "" || info.Port == 0 {
		slog.Debug("SDP media incomplete",
			"has_audio", info.HasAudio,
			"has_session_connection", info.HasSessionConn,
			"has_media_connection", info.HasMediaConn,
			"ip", info.IP,
			"port", info.Port,
			"proto", info.Proto,
			"body_len", len(sdpBody),
			"sdp_head", truncateSDP(sdpBody, 180),
		)
	}
	return info
}

func nextSDPLine(s string, offset int) (line string, next int) {
	if offset >= len(s) {
		return "", len(s)
	}
	for i := offset; i < len(s); i++ {
		if s[i] == '\n' {
			end := i
			if end > offset && s[end-1] == '\r' {
				end--
			}
			return s[offset:end], i + 1
		}
	}
	return s[offset:], len(s)
}

func parseCryptoLine(line string, info *SDPMediaInfo) {
	fields := strings.Fields(line)
	if len(fields) < 3 {
		return
	}
	tagRaw := strings.TrimPrefix(fields[0], "a=crypto:")
	tag, _ := strconv.Atoi(tagRaw)
	info.CryptoSuite = fields[1]
	info.CryptoKeyParams = fields[2]
	info.CryptoLines = append(info.CryptoLines, SRTPCryptoOffer{
		Tag:       tag,
		Suite:     fields[1],
		KeyParams: fields[2],
		SDPLine:   line,
	})
}

func truncateSDP(s string, max int) string {
	s = strings.ReplaceAll(s, "\r", "\\r")
	s = strings.ReplaceAll(s, "\n", "\\n")
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
