package rtp

import (
	"context"
	"encoding/binary"
	"log"
	"math/rand"
	"net"
	"sync"
	"time"
)

const (
	PT_PCMU        = 0
	SampleRate     = 8000
	MarkerInterval = 100
)

// MarkerMagic is embedded in every Nth RTP payload for validation.
var MarkerMagic = []byte{0xCC, 0x11, 0xCC, 0x11}

// RtpStats is an immutable snapshot of an RtpEndpoint's receive counters.
type RtpStats struct {
	RTPRxPkts      int
	RTPRxFromSBC   int
	RTPRxOther     int
	RTCPRxPkts     int
	MarkersReceived int
	FirstRxMs      *float64
	LastRxMs       *float64
}

// RtpEndpoint is a bidirectional G.711 PCMU RTP endpoint used by both UAC and UAS.
type RtpEndpoint struct {
	conn      *net.UDPConn
	localPort int
	localIP   string
	closed    bool

	txPkts      int
	markersSent int

	remoteIP   string
	remotePort int

	tsInc          int
	tonePayload    []byte
	markerTemplate []byte

	expectedSrc *net.UDPAddr

	packetsReceived     int
	pktsFromExpectedSrc int
	pktsFromOtherSrc    int
	rtcpReceived        int
	markersReceived     int
	firstRecvTs         *float64
	lastRecvTs          *float64

	mu   sync.Mutex
	pcap *PcapWriter
}

// NewRtpEndpoint binds a UDP socket on localIP with an OS-assigned port.
func NewRtpEndpoint(localIP string, ptimeMs int) (*RtpEndpoint, error) {
	addr, err := net.ResolveUDPAddr("udp4", localIP+":0")
	if err != nil {
		return nil, err
	}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		return nil, err
	}

	localAddr := conn.LocalAddr().(*net.UDPAddr)

	tsInc, _, tone, marker := ComputePtimeParams(ptimeMs)

	ep := &RtpEndpoint{
		conn:           conn,
		localPort:      localAddr.Port,
		localIP:        localIP,
		tsInc:          tsInc,
		tonePayload:    tone,
		markerTemplate: marker,
	}

	go ep.receiveLoop()

	return ep, nil
}

// LocalPort returns the OS-assigned UDP port.
func (ep *RtpEndpoint) LocalPort() int {
	return ep.localPort
}

// TxPkts returns the number of transmitted packets.
func (ep *RtpEndpoint) TxPkts() int {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	return ep.txPkts
}

// MarkersSent returns the number of marker payloads sent.
func (ep *RtpEndpoint) MarkersSent() int {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	return ep.markersSent
}

// SetRemoteRTPAddr sets the expected source address for the three-counter receive.
func (ep *RtpEndpoint) SetRemoteRTPAddr(ip string, port int) {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	ep.remoteIP = ip
	ep.remotePort = port
	ep.expectedSrc = &net.UDPAddr{IP: net.ParseIP(ip), Port: port}
}

// EnablePcap starts writing every TX/RX packet to a pcap file.
func (ep *RtpEndpoint) EnablePcap(path string) error {
	pw, err := NewPcapWriter(path, ep.localIP, ep.localPort)
	if err != nil {
		return err
	}
	ep.mu.Lock()
	ep.pcap = pw
	ep.mu.Unlock()
	return nil
}

// Stats returns an immutable snapshot of the receive counters.
func (ep *RtpEndpoint) Stats() RtpStats {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	var firstMs, lastMs *float64
	if ep.firstRecvTs != nil {
		v := *ep.firstRecvTs
		firstMs = &v
	}
	if ep.lastRecvTs != nil {
		v := *ep.lastRecvTs
		lastMs = &v
	}
	return RtpStats{
		RTPRxPkts:       ep.packetsReceived,
		RTPRxFromSBC:    ep.pktsFromExpectedSrc,
		RTPRxOther:      ep.pktsFromOtherSrc,
		RTCPRxPkts:      ep.rtcpReceived,
		MarkersReceived: ep.markersReceived,
		FirstRxMs:       firstMs,
		LastRxMs:        lastMs,
	}
}

// getPayload returns the next TX payload, embedding a marker every MarkerInterval packets.
func (ep *RtpEndpoint) getPayload() []byte {
	ep.txPkts++
	if ep.txPkts%MarkerInterval == 0 {
		ep.markersSent++
		return buildMarkerPayload(ep.markerTemplate, ep.markersSent)
	}
	return ep.tonePayload
}

// Run executes the UAC send loop with 3-phase or continuous mode.
func (ep *RtpEndpoint) Run(
	ctx context.Context,
	remoteIP string, remotePort int,
	durationSeconds float64,
	burstSeconds float64, burstPPS int,
	keepaliveInterval float64,
	continuous bool,
) error {
	if remotePort <= 0 || remotePort == 9 {
		select {
		case <-time.After(time.Duration(durationSeconds * float64(time.Second))):
		case <-ctx.Done():
		}
		return ctx.Err()
	}

	dest := &net.UDPAddr{IP: net.ParseIP(remoteIP), Port: remotePort}
	ssrc := rand.Uint32() | 1
	seq := uint16(rand.Intn(0x10000))
	ts := rand.Uint32()
	callDeadline := time.Now().Add(time.Duration(durationSeconds * float64(time.Second)))

	if continuous {
		var err error
		seq, ts, err = ep.sendBurst(ctx, dest, ssrc, seq, ts, callDeadline, burstPPS)
		if err != nil {
			return err
		}
	} else {
		burstEndStart := callDeadline.Add(-time.Duration(burstSeconds * float64(time.Second)))

		// Phase 1: BURST_START
		phase1Deadline := time.Now().Add(time.Duration(burstSeconds * float64(time.Second)))
		if phase1Deadline.After(callDeadline) {
			phase1Deadline = callDeadline
		}
		var err error
		seq, ts, err = ep.sendBurst(ctx, dest, ssrc, seq, ts, phase1Deadline, burstPPS)
		if err != nil {
			return err
		}

		// Phase 2: KEEPALIVE
		for time.Now().Before(burstEndStart) {
			remaining := time.Until(burstEndStart)
			sleepFor := time.Duration(keepaliveInterval * float64(time.Second))
			if sleepFor > remaining {
				sleepFor = remaining
			}
			if sleepFor <= 0 {
				break
			}

			select {
			case <-time.After(sleepFor):
			case <-ctx.Done():
				return ctx.Err()
			}

			if time.Now().After(callDeadline) {
				break
			}

			payload := ep.getPayload()
			pkt := packRTP(seq, ts, ssrc, payload)
			if _, err := ep.conn.WriteToUDP(pkt, dest); err != nil {
				log.Printf("rtp: keepalive sendto error: %v", err)
				break
			}

			ep.mu.Lock()
			pw := ep.pcap
			ep.mu.Unlock()
			if pw != nil {
				pw.WriteTx(pkt, remoteIP, remotePort)
			}

			seq++
			ts += uint32(ep.tsInc)
		}

		// Phase 3: BURST_END
		if time.Now().Before(callDeadline) {
			seq, ts, err = ep.sendBurst(ctx, dest, ssrc, seq, ts, callDeadline, burstPPS)
			if err != nil {
				return err
			}
		}
	}

	return nil
}

// RunUntilCancelled is the UAS variant that runs until ctx is cancelled.
func (ep *RtpEndpoint) RunUntilCancelled(
	ctx context.Context,
	remoteIP string, remotePort int,
	burstSeconds float64, burstPPS int,
	keepaliveInterval float64,
	continuous bool,
) error {
	if remotePort <= 0 || remotePort == 9 {
		<-ctx.Done()
		return ctx.Err()
	}

	dest := &net.UDPAddr{IP: net.ParseIP(remoteIP), Port: remotePort}
	ssrc := rand.Uint32() | 1
	seq := uint16(rand.Intn(0x10000))
	ts := rand.Uint32()

	if continuous {
		farFuture := time.Now().Add(24 * time.Hour)
		_, _, err := ep.sendBurst(ctx, dest, ssrc, seq, ts, farFuture, burstPPS)
		if err != nil {
			return err
		}
	} else {
		burstDeadline := time.Now().Add(time.Duration(burstSeconds * float64(time.Second)))
		var err error
		seq, ts, err = ep.sendBurst(ctx, dest, ssrc, seq, ts, burstDeadline, burstPPS)
		if err != nil {
			return err
		}

		// KEEPALIVE forever until cancelled
		for {
			select {
			case <-time.After(time.Duration(keepaliveInterval * float64(time.Second))):
			case <-ctx.Done():
				return ctx.Err()
			}

			payload := ep.getPayload()
			pkt := packRTP(seq, ts, ssrc, payload)
			_, _ = ep.conn.WriteToUDP(pkt, dest)

			ep.mu.Lock()
			pw := ep.pcap
			ep.mu.Unlock()
			if pw != nil {
				pw.WriteTx(pkt, remoteIP, remotePort)
			}

			seq++
			ts += uint32(ep.tsInc)
		}
	}

	return nil
}

// sendBurst sends at pps packets/sec until deadline with drift-correcting pacing.
func (ep *RtpEndpoint) sendBurst(
	ctx context.Context,
	dest *net.UDPAddr,
	ssrc uint32, seq uint16, ts uint32,
	deadline time.Time,
	pps int,
) (uint16, uint32, error) {
	interval := time.Duration(float64(time.Second) / float64(pps))
	nextSend := time.Now()

	ep.mu.Lock()
	pw := ep.pcap
	ep.mu.Unlock()

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return seq, ts, ctx.Err()
		default:
		}

		payload := ep.getPayload()
		pkt := packRTP(seq, ts, ssrc, payload)
		if _, err := ep.conn.WriteToUDP(pkt, dest); err != nil {
			remaining := time.Until(deadline)
			if remaining > 0 {
				select {
				case <-time.After(remaining):
				case <-ctx.Done():
				}
			}
			return seq, ts, nil
		}

		if pw != nil {
			pw.WriteTx(pkt, dest.IP.String(), dest.Port)
		}

		seq++
		ts += uint32(ep.tsInc)

		nextSend = nextSend.Add(interval)
		sleepFor := time.Until(nextSend)
		if sleepFor > 0 {
			select {
			case <-time.After(sleepFor):
			case <-ctx.Done():
				return seq, ts, ctx.Err()
			}
		}
	}

	return seq, ts, nil
}

// Close closes the UDP socket and pcap file. Safe to call multiple times.
func (ep *RtpEndpoint) Close() error {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	if ep.closed {
		return nil
	}
	ep.closed = true
	err := ep.conn.Close()
	if ep.pcap != nil {
		ep.pcap.Close()
		ep.pcap = nil
	}
	return err
}

// receiveLoop is the background goroutine that classifies incoming datagrams.
func (ep *RtpEndpoint) receiveLoop() {
	buf := make([]byte, 2048)
	for {
		n, addr, err := ep.conn.ReadFromUDP(buf)
		if err != nil {
			return
		}
		if n < 12 {
			continue
		}
		data := buf[:n]

		// RTP version check
		if (data[0] >> 6) != 2 {
			continue
		}

		ep.mu.Lock()
		pw := ep.pcap
		ep.mu.Unlock()
		if pw != nil {
			pw.WriteRx(data, addr.IP.String(), addr.Port)
		}

		// RTCP filter
		if data[1] >= 200 && data[1] <= 207 {
			ep.mu.Lock()
			ep.rtcpReceived++
			ep.mu.Unlock()
			continue
		}

		nowMs := float64(time.Now().UnixMilli())

		ep.mu.Lock()
		if ep.firstRecvTs == nil {
			ep.firstRecvTs = &nowMs
		}
		latest := nowMs
		ep.lastRecvTs = &latest
		ep.packetsReceived++

		if ep.expectedSrc != nil && addr.IP.Equal(ep.expectedSrc.IP) && addr.Port == ep.expectedSrc.Port {
			ep.pktsFromExpectedSrc++
		} else {
			ep.pktsFromOtherSrc++
		}

		// Marker detection: account for CSRC and header extensions
		cc := int(data[0] & 0x0F)
		hasExt := (data[0] & 0x10) != 0
		payloadOff := 12 + cc*4
		if hasExt && n >= payloadOff+4 {
			extLen := int(binary.BigEndian.Uint16(data[payloadOff+2 : payloadOff+4]))
			payloadOff += 4 + extLen*4
		}
		if n >= payloadOff+4 &&
			data[payloadOff] == 0xCC && data[payloadOff+1] == 0x11 &&
			data[payloadOff+2] == 0xCC && data[payloadOff+3] == 0x11 {
			ep.markersReceived++
		}

		ep.mu.Unlock()
	}
}

// packRTP builds a minimal 12-byte RFC 3550 RTP header + payload.
func packRTP(seq uint16, ts uint32, ssrc uint32, payload []byte) []byte {
	hdr := make([]byte, 12+len(payload))
	hdr[0] = 0x80          // V=2, P=0, X=0, CC=0
	hdr[1] = PT_PCMU       // M=0, PT=0
	binary.BigEndian.PutUint16(hdr[2:4], seq)
	binary.BigEndian.PutUint32(hdr[4:8], ts)
	binary.BigEndian.PutUint32(hdr[8:12], ssrc)
	copy(hdr[12:], payload)
	return hdr
}

// buildMarkerPayload embeds the marker sequence number into the template.
func buildMarkerPayload(template []byte, markerSeq int) []byte {
	buf := make([]byte, len(template))
	copy(buf, template)
	binary.BigEndian.PutUint32(buf[4:8], uint32(markerSeq))
	return buf
}
