package rtp

import (
	"context"
	"encoding/binary"
	"log/slog"
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

// RtpStats is an immutable snapshot of an RtpEndpoint's receive counters
// and computed quality metrics.
type RtpStats struct {
	RTPRxPkts       int
	RTPRxFromSBC    int
	RTPRxOther      int
	RTCPRxPkts      int
	MarkersReceived int
	FirstRxMs       *float64
	LastRxMs        *float64

	// QoS metrics (Phase 1, RFC 3550 §6.4.1).
	// JitterMs is the running interarrival jitter in milliseconds, computed
	// per dominant SSRC (the first SSRC observed). 0 until at least 2
	// packets from that SSRC have been received.
	JitterMs       float64
	LostPackets    int
	OOOPackets     int
	DupPackets     int
	PacketLossPct  float64 // lost / (received + lost) * 100, 0..100

	// Remote-side metrics extracted from received RTCP RR blocks
	// (the SBC's report back to us). Zero when no RR has been parsed.
	RemoteJitterMs float64
	RemoteLossPct  float64
}

// RtpEndpoint is a bidirectional G.711 PCMU RTP endpoint used by both UAC and UAS.
type RtpEndpoint struct {
	conn      *net.UDPConn
	localPort int
	localIP   string
	closed    bool

	txPkts      int
	markersSent int
	// firstPacketSent tracks whether the very first RTP packet of this
	// session has been transmitted yet. The RTP header M (marker) bit is
	// set on that first packet only, per RFC 3551 §4.1 (start of talkspurt).
	firstPacketSent bool

	// ── QoS measurement state (RFC 3550 §6.4.1) ──────────────────
	// qosEnabled is captured from VMConfig at endpoint construction so the
	// receive loop can short-circuit jitter/loss math when QoS is disabled.
	qosEnabled bool

	// Per-dominant-SSRC tracking. The first SSRC seen is "pinned" so that
	// stray traffic from another sender does not pollute jitter/loss data.
	dominantSSRC     uint32
	dominantSSRCSet  bool
	prevArrivalMs    float64 // wall-clock arrival of last packet (ms since UnixEpoch)
	prevRTPTimestamp uint32  // RTP timestamp of last packet
	prevSampleSet    bool    // whether prevArrival/prevRTPTimestamp are valid
	jitterRTPUnits   float64 // running jitter in RTP timestamp units (RFC 3550)

	// Sequence-number tracking for loss / OOO / dup detection.
	expectedSeq    uint16
	expectedSeqSet bool
	lostPackets    int
	oooPackets     int
	dupPackets     int

	// Last-SSRC-RR snapshot extracted from RTCP RR blocks the SBC sends us.
	remoteJitterRTP float64 // raw jitter from RR (RTP units)
	remoteLossPct   float64 // from fraction-lost field, 0..100

	remoteIP   string
	remotePort int

	tsInc          int
	tonePayload    []byte
	markerTemplate []byte

	expectedSrc    *net.UDPAddr
	preSdpSourceIP string

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
// QoS measurement (jitter, loss, OOO, RTCP RR parsing) is enabled by
// default; callers needing to opt out should use NewRtpEndpointWithOpts.
func NewRtpEndpoint(localIP string, ptimeMs int) (*RtpEndpoint, error) {
	return NewRtpEndpointWithOpts(localIP, ptimeMs, true)
}

// NewRtpEndpointWithOpts is the explicit-options form of NewRtpEndpoint.
// qosEnabled controls per-packet jitter / loss / OOO computation in the
// receive loop. Disabling it skips the small per-packet overhead but loses
// the jitter, packet_loss_pct, and lost_packets fields in CallResult.
func NewRtpEndpointWithOpts(localIP string, ptimeMs int, qosEnabled bool) (*RtpEndpoint, error) {
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
		qosEnabled:     qosEnabled,
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

// SetRemoteRTPAddr sets the expected source address for the three-counter
// receive classification.
//
// Pre-SDP packets that arrived before the SDP answer are handled with a
// guarded reclassification: if the first pre-SDP packet came from the same
// IP as the now-known expected source (the SBC relay), those packets are
// promoted to the "expected" bucket.  Packets from any other IP are left in
// the "other" bucket as genuine stray traffic.  This is safe at scale
// (3k-5k extensions) because the freshly allocated OS-assigned UDP port is
// only known to the SBC via the SDP offer.
func (ep *RtpEndpoint) SetRemoteRTPAddr(ip string, port int) {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	ep.remoteIP = ip
	ep.remotePort = port
	ep.expectedSrc = &net.UDPAddr{IP: net.ParseIP(ip), Port: port}

	if ep.pktsFromOtherSrc > 0 && ep.preSdpSourceIP == ip {
		ep.pktsFromExpectedSrc += ep.pktsFromOtherSrc
		ep.pktsFromOtherSrc = 0
	}
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

// Stats returns an immutable snapshot of the receive counters and computed
// QoS metrics. RFC 3550 jitter is converted from RTP timestamp units to
// milliseconds using the PCMU 8 kHz sample rate.
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
	// Convert RFC 3550 jitter (RTP timestamp units) to milliseconds.
	// PCMU samples at 8 kHz → 1 RTP unit = 0.125 ms = 1/8 ms.
	jitterMs := ep.jitterRTPUnits / float64(SampleRate) * 1000.0
	remoteJitterMs := ep.remoteJitterRTP / float64(SampleRate) * 1000.0

	totalSeq := ep.packetsReceived + ep.lostPackets
	lossPct := 0.0
	if totalSeq > 0 {
		lossPct = float64(ep.lostPackets) / float64(totalSeq) * 100.0
	}

	return RtpStats{
		RTPRxPkts:       ep.packetsReceived,
		RTPRxFromSBC:    ep.pktsFromExpectedSrc,
		RTPRxOther:      ep.pktsFromOtherSrc,
		RTCPRxPkts:      ep.rtcpReceived,
		MarkersReceived: ep.markersReceived,
		FirstRxMs:       firstMs,
		LastRxMs:        lastMs,

		JitterMs:       jitterMs,
		LostPackets:    ep.lostPackets,
		OOOPackets:     ep.oooPackets,
		DupPackets:     ep.dupPackets,
		PacketLossPct:  lossPct,
		RemoteJitterMs: remoteJitterMs,
		RemoteLossPct:  ep.remoteLossPct,
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

// consumeFirstPacketFlag returns true exactly once per endpoint lifetime, on
// the first call. Used to set the RTP header M bit on the first transmitted
// packet of the session per RFC 3551 §4.1.
func (ep *RtpEndpoint) consumeFirstPacketFlag() bool {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	if ep.firstPacketSent {
		return false
	}
	ep.firstPacketSent = true
	return true
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
			pkt := packRTP(seq, ts, ssrc, payload, ep.consumeFirstPacketFlag())
			if _, err := ep.conn.WriteToUDP(pkt, dest); err != nil {
				slog.Warn("RTP keepalive sendto error", "err", err, "dest", dest.String())
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
			pkt := packRTP(seq, ts, ssrc, payload, ep.consumeFirstPacketFlag())
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
		pkt := packRTP(seq, ts, ssrc, payload, ep.consumeFirstPacketFlag())
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
//
// On every UDP datagram it:
//   - validates RTP version (== 2)
//   - mirrors to the optional pcap writer
//   - branches into RTCP parsing (PT 200-207) or RTP measurement
//
// For RTP packets, when QoS is enabled, it accumulates RFC 3550 §6.4.1
// interarrival jitter and tracks sequence-number gaps for packet-loss /
// out-of-order / duplicate detection. Jitter and loss are computed only
// for the dominant SSRC (the first SSRC observed); packets from other
// SSRCs are still counted but excluded from quality math to avoid noise.
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

		// RTCP branch — try to extract jitter/loss from RR blocks before
		// counting. Failure to parse is non-fatal.
		if data[1] >= 200 && data[1] <= 207 {
			ep.mu.Lock()
			ep.rtcpReceived++
			ep.mu.Unlock()
			if ep.qosEnabled {
				ep.parseRTCPPacket(data)
			}
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

		if ep.expectedSrc == nil && ep.preSdpSourceIP == "" {
			ep.preSdpSourceIP = addr.IP.String()
		}

		if ep.expectedSrc != nil && addr.IP.Equal(ep.expectedSrc.IP) && addr.Port == ep.expectedSrc.Port {
			ep.pktsFromExpectedSrc++
		} else {
			ep.pktsFromOtherSrc++
		}

		// QoS metrics — pin to dominant SSRC, then update jitter / seq
		// tracking. Skip entirely when QoS is disabled at construction.
		if ep.qosEnabled {
			seq := binary.BigEndian.Uint16(data[2:4])
			rtpTs := binary.BigEndian.Uint32(data[4:8])
			ssrc := binary.BigEndian.Uint32(data[8:12])
			ep.updateQoSMetricsLocked(ssrc, seq, rtpTs, nowMs)
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

// updateQoSMetricsLocked accumulates RFC 3550 jitter and sequence-number
// statistics for a freshly received RTP packet. Caller MUST hold ep.mu.
//
// Jitter is only computed for the "dominant" SSRC — the first SSRC observed
// on the endpoint — so that stray pre-SDP packets from another sender don't
// contaminate the running average. Packets from other SSRCs still count
// towards packetsReceived but are excluded from jitter / seq tracking.
func (ep *RtpEndpoint) updateQoSMetricsLocked(ssrc uint32, seq uint16, rtpTs uint32, nowMs float64) {
	if !ep.dominantSSRCSet {
		ep.dominantSSRC = ssrc
		ep.dominantSSRCSet = true
	} else if ssrc != ep.dominantSSRC {
		// Different SSRC — skip jitter/seq updates to keep the metric
		// representative of the primary media stream.
		return
	}

	// ── Jitter (RFC 3550 §6.4.1) ──────────────────────────────────
	// D(i,j) = (Rj - Ri) - (Sj - Si), where R is arrival in RTP units
	// and S is the RTP timestamp from the packet.
	// J(i) = J(i-1) + (|D| - J(i-1)) / 16
	if ep.prevSampleSet {
		// Convert wall-clock arrival delta (ms) to RTP units (samples).
		// PCMU SampleRate=8000 → 1 ms = 8 RTP units.
		arrivalDeltaRTPUnits := (nowMs - ep.prevArrivalMs) * float64(SampleRate) / 1000.0
		// RTP timestamps are uint32; subtract using signed int32 to get
		// the correct delta even across the 32-bit wraparound boundary.
		tsDelta := float64(int32(rtpTs - ep.prevRTPTimestamp))
		d := arrivalDeltaRTPUnits - tsDelta
		if d < 0 {
			d = -d
		}
		ep.jitterRTPUnits += (d - ep.jitterRTPUnits) / 16.0
	}
	ep.prevArrivalMs = nowMs
	ep.prevRTPTimestamp = rtpTs
	ep.prevSampleSet = true

	// ── Sequence-number tracking (loss / OOO / dup) ──────────────
	// Use signed 16-bit modular arithmetic so wrap-around (65535 → 0) is
	// treated as a +1 delta, not a -65535 OOO event.
	if !ep.expectedSeqSet {
		ep.expectedSeq = seq + 1
		ep.expectedSeqSet = true
		return
	}
	delta := int16(seq - ep.expectedSeq)
	switch {
	case delta == 0:
		ep.expectedSeq++
	case delta > 0:
		// Gap: 'delta' packets between expectedSeq and the one we got
		// were never seen. They are counted as lost; receiver advances.
		ep.lostPackets += int(delta)
		ep.expectedSeq = seq + 1
	default: // delta < 0
		// Late-arriving packet (OOO) or duplicate. We can't easily
		// tell them apart without a windowed buffer, so anything that
		// "fills a gap" we previously counted is treated as OOO and
		// silently restored from the lost counter when possible.
		ep.oooPackets++
		if ep.lostPackets > 0 {
			ep.lostPackets--
		} else {
			ep.dupPackets++
		}
	}
}

// parseRTCPPacket walks compound RTCP packets and extracts the most recent
// RR block targeting our SSRC. RFC 3550 §6.4 / §6.4.1 layouts:
//
//   SR  (PT=200): 4-byte header + 24-byte sender info + N×24-byte RR blocks
//   RR  (PT=201): 4-byte header + 4-byte reporter SSRC + N×24-byte RR blocks
//
// Compound packets stack multiple RTCP records back-to-back; we walk by
// the length field and parse SR/RR types, ignoring SDES/BYE/APP/etc.
//
// On a successful RR block parse we update remoteJitterRTP and remoteLossPct
// from the fraction-lost (byte 4) and interarrival-jitter (bytes 12-15)
// fields of the report block. Caller does NOT need to hold ep.mu (this
// helper acquires it for the brief write).
func (ep *RtpEndpoint) parseRTCPPacket(data []byte) {
	off := 0
	for off+4 <= len(data) {
		if (data[off]>>6) != 2 {
			return // not RTCP, malformed
		}
		rc := int(data[off] & 0x1F)
		pt := data[off+1]
		// length is in 32-bit words, minus 1; total bytes = (length+1)*4.
		lengthWords := int(binary.BigEndian.Uint16(data[off+2 : off+4]))
		recordLen := (lengthWords + 1) * 4
		if recordLen <= 0 || off+recordLen > len(data) {
			return
		}

		// SR (200): skip the 4-byte header + 20-byte sender info to land
		//           at the first report block (offset 28 within record).
		// RR (201): skip the 4-byte header + 4-byte reporter SSRC to land
		//           at the first report block (offset 8 within record).
		var blockBase int
		switch pt {
		case 200:
			blockBase = off + 28
		case 201:
			blockBase = off + 8
		default:
			off += recordLen
			continue
		}

		for i := 0; i < rc; i++ {
			start := blockBase + i*24
			if start+24 > off+recordLen {
				break
			}
			// fraction lost = byte 4 of the report block, expressed as
			// the integer numerator of a fraction over 256.
			fractionLost := data[start+4]
			// Interarrival jitter = bytes 12-15 (RTP timestamp units).
			jitterRTP := binary.BigEndian.Uint32(data[start+12 : start+16])

			ep.mu.Lock()
			ep.remoteJitterRTP = float64(jitterRTP)
			ep.remoteLossPct = float64(fractionLost) / 256.0 * 100.0
			ep.mu.Unlock()
		}

		off += recordLen
	}
}

// packRTP builds a minimal 12-byte RFC 3550 RTP header + payload.
// When marker is true the RTP M bit (bit 7 of byte 1) is set, signalling the
// start of a talkspurt per RFC 3551 §4.1.
func packRTP(seq uint16, ts uint32, ssrc uint32, payload []byte, marker bool) []byte {
	hdr := make([]byte, 12+len(payload))
	hdr[0] = 0x80          // V=2, P=0, X=0, CC=0
	pt := byte(PT_PCMU)    // PT=0 (PCMU)
	if marker {
		pt |= 0x80 // M=1
	}
	hdr[1] = pt
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
