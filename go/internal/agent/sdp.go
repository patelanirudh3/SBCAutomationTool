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
	for _, line := range strings.Split(sdpBody, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "c=IN IP4 ") {
			parts := strings.Fields(line[9:])
			if len(parts) > 0 {
				ip = parts[0]
			}
		} else if strings.HasPrefix(line, "m=audio ") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				p, err := strconv.Atoi(parts[1])
				if err == nil {
					port = p
				}
			}
			break
		}
	}
	return
}
