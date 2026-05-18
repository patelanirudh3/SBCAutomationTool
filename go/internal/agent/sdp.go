package agent

import (
	"fmt"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// sdpSessionCounter is incremented per BuildSDP call to guarantee uniqueness
// even when two SDPs are generated within the same nanosecond on the same
// host (e.g. burst of concurrent INVITEs at high CPS).
var sdpSessionCounter uint64

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
	sessID := uint64(time.Now().UnixNano()) ^ atomic.AddUint64(&sdpSessionCounter, 1)
	rtcpMuxLine := ""
	if rtcpMux {
		rtcpMuxLine = "a=rtcp-mux\r\n"
	}
	return fmt.Sprintf(
		"v=0\r\n"+
			"o=- %d 1 IN IP4 %s\r\n"+
			"s=-\r\n"+
			"c=IN IP4 %s\r\n"+
			"t=0 0\r\n"+
			"m=audio %d RTP/AVP 0 8 101\r\n"+
			"a=rtpmap:0 PCMU/8000\r\n"+
			"a=rtpmap:8 PCMA/8000\r\n"+
			"a=rtpmap:101 telephone-event/8000\r\n"+
			"a=fmtp:101 0-15\r\n"+
			"a=ptime:20\r\n"+
			"a=sendrecv\r\n"+
			"%s",
		sessID, localHost, localHost, rtpPort, rtcpMuxLine,
	)
}

// ParseSDPMedia extracts the RTP IP and port from an SDP body.
func ParseSDPMedia(sdpBody string) (ip string, port int) {
	sessionIP := ""
	mediaIP := ""
	inAudio := false

	for _, line := range strings.Split(sdpBody, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "c=IN "):
			parts := strings.Fields(line)
			if len(parts) >= 3 {
				if inAudio {
					mediaIP = parts[2]
				} else {
					sessionIP = parts[2]
				}
			}
		case strings.HasPrefix(line, "m="):
			parts := strings.Fields(line)
			if len(parts) < 2 {
				inAudio = false
				continue
			}
			inAudio = strings.TrimPrefix(parts[0], "m=") == "audio"
			if inAudio {
				if p, err := strconv.Atoi(parts[1]); err == nil && p > 0 {
					port = p
				}
			}
		}
	}
	if mediaIP != "" {
		ip = mediaIP
	} else {
		ip = sessionIP
	}
	return
}
