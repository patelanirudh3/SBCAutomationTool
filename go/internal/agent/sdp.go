package agent

import (
	"fmt"
	"strconv"
	"strings"
)

// BuildSDP builds a G.711 audio SDP for the given local host and RTP port.
func BuildSDP(localHost string, rtpPort int) string {
	return fmt.Sprintf(
		"v=0\r\n"+
			"o=- 0 0 IN IP4 %s\r\n"+
			"s=-\r\n"+
			"c=IN IP4 %s\r\n"+
			"t=0 0\r\n"+
			"m=audio %d RTP/AVP 0 8 101\r\n"+
			"a=rtpmap:0 PCMU/8000\r\n"+
			"a=rtpmap:8 PCMA/8000\r\n"+
			"a=rtpmap:101 telephone-event/8000\r\n"+
			"a=fmtp:101 0-15\r\n"+
			"a=ptime:20\r\n"+
			"a=sendrecv\r\n",
		localHost, localHost, rtpPort,
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
