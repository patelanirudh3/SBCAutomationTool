package rtp

import (
	"context"
	"encoding/binary"
	"fmt"
	"log/slog"
	"math"
	"math/rand"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/srtp/v3"
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
	SSRCCount       int
	ExpectedPackets int
	FirstRxMs       *float64
	LastRxMs        *float64

	// QoS metrics (Phase 1, RFC 3550 §6.4.1).
	// JitterMs is the running interarrival jitter in milliseconds, computed
	// per dominant SSRC (the first SSRC observed). 0 until at least 2
	// packets from that SSRC have been received.
	JitterMs      float64
	LostPackets   int
	OOOPackets    int
	DupPackets    int
	PacketLossPct float64 // lost / (received + lost) * 100, 0..100

	// Remote-side metrics extracted from received RTCP RR blocks
	// (the SBC's report back to us). Zero when no RR has been parsed.
	RemoteJitterMs float64
	RemoteLossPct  float64

	// RTTMs is the round-trip time computed from RTCP SR/RR exchange:
	//   RTT = NTP(now) - LSR - DLSR (32-bit middle-NTP units → ms)
	// Zero when RTCP SR transmission is disabled or no RR has been
	// received that references one of our SRs.
	RTTMs float64

	SRTPEnabled         bool
	SRTPDecryptFailures int
	SRTPAuthFailures    int
	SRTPReplayFailures  int
}

type SRTPSessionConfig struct {
	Enabled         bool
	CryptoSuite     string
	OutboundKeySalt []byte
	InboundKeySalt  []byte
}

// RtpEndpoint is a bidirectional G.711 PCMU RTP endpoint used by both UAC and UAS.
type RtpEndpoint struct {
	conn      *net.UDPConn
	localPort int
	localIP   string
	closed    bool

	txPkts      int
	txOctets    uint64 // cumulative RTP payload bytes sent (for RTCP SR sender info)
	markersSent int
	// firstPacketSent tracks whether the very first RTP packet of this
	// session has been transmitted yet. The RTP header M (marker) bit is
	// set on that first packet only, per RFC 3551 §4.1 (start of talkspurt).
	firstPacketSent bool

	// SSRC pinned for our outbound RTP stream. Set by Run/RunUntilCancelled
	// before any packet is sent so the RTCP SR loop can include it.
	txSSRC    uint32
	txSSRCSet bool

	// rtpEpoch is the RTP timestamp at the beginning of the call (the
	// random initial value picked by Run). Used to compute the RTP
	// timestamp embedded in RTCP SR, derived as epoch + samples-since-start.
	rtpEpoch    uint32
	rtpEpochSet bool
	rtpStartMs  float64 // wall clock when rtpEpoch was set

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
	ssrcRx         map[uint32]*ssrcRxState

	// Last-SSRC-RR snapshot extracted from RTCP RR blocks the SBC sends us.
	remoteJitterRTP float64 // raw jitter from RR (RTP units)
	remoteLossPct   float64 // from fraction-lost field, 0..100

	// ── RTCP Sender Report transmission (Phase 2, default OFF) ─────
	// rtcpSREnabled is captured at construction; the SR loop goroutine
	// is only spawned by Run/RunUntilCancelled when this flag is true.
	// rtcpSRInterval defaults to 5s; min 1s, max 60s (validated upstream).
	rtcpSREnabled  bool
	rtcpSRInterval time.Duration

	// rttMs is the most recently computed round-trip time in milliseconds,
	// derived from RTCP SR/RR exchange (RFC 3550 §6.4.1). Zero when no RR
	// referencing one of our SRs has been received yet.
	rttMs float64

	srtpEnabled         bool
	srtpSuite           string
	srtpEncrypt         *srtp.Context
	srtpDecrypt         *srtp.Context
	srtpDecryptFailures int
	srtpAuthFailures    int
	srtpReplayFailures  int

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

type ssrcRxState struct {
	baseSeq  uint16
	maxSeq   uint16
	cycles   uint32
	received int
}

// CoverageOptions controls coverage-based 3-phase RTP generation.
// Percentages are validated by config.Validate; this struct is intentionally
// simple so callers can pass VMConfig values through without translation.
type CoverageOptions struct {
	MediaCoveragePct   int
	StartBurstSharePct int
	EndBurstSharePct   int
	MidBurstSeconds    int
	KeepaliveEnabled   bool
	KeepalivePPS       int
}

// NewRtpEndpoint binds a UDP socket on localIP with an OS-assigned port.
// QoS measurement (jitter, loss, OOO, RTCP RR parsing) is enabled by
// default; callers needing to opt out should use NewRtpEndpointWithOpts.
func NewRtpEndpoint(localIP string, ptimeMs int) (*RtpEndpoint, error) {
	return NewRtpEndpointWithOpts(localIP, ptimeMs, true)
}

// NewRtpEndpointWithOpts is the QoS-aware constructor without RTCP SR
// transmission. Equivalent to NewRtpEndpointFull(..., false, 0).
func NewRtpEndpointWithOpts(localIP string, ptimeMs int, qosEnabled bool) (*RtpEndpoint, error) {
	return NewRtpEndpointFull(localIP, ptimeMs, qosEnabled, false, 0)
}

// NewRtpEndpointFull is the fully-explicit constructor.
//
// qosEnabled       — track jitter / loss / OOO in receive loop (Phase 1)
// rtcpSREnabled    — transmit RTCP Sender Reports (Phase 2, RISKY)
// rtcpSRInterval   — interval between SR packets (only used when SR enabled;
//
//	pass 0 to default to 5 s)
//
// The SR loop goroutine is NOT spawned here; it starts inside Run /
// RunUntilCancelled when there is a known remote destination to send to.
func NewRtpEndpointFull(localIP string, ptimeMs int, qosEnabled, rtcpSREnabled bool, rtcpSRInterval time.Duration) (*RtpEndpoint, error) {
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

	if rtcpSREnabled && rtcpSRInterval <= 0 {
		rtcpSRInterval = 5 * time.Second
	}

	ep := &RtpEndpoint{
		conn:           conn,
		localPort:      localAddr.Port,
		localIP:        localIP,
		tsInc:          tsInc,
		tonePayload:    tone,
		markerTemplate: marker,
		qosEnabled:     qosEnabled,
		rtcpSREnabled:  rtcpSREnabled,
		rtcpSRInterval: rtcpSRInterval,
		ssrcRx:         make(map[uint32]*ssrcRxState),
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

	expectedPackets := 0
	ssrcReceived := 0
	for _, st := range ep.ssrcRx {
		expectedPackets += st.expected()
		ssrcReceived += st.received
	}
	lostPackets := expectedPackets - ssrcReceived
	if lostPackets < 0 {
		lostPackets = 0
	}
	if expectedPackets == 0 {
		lostPackets = ep.lostPackets
		expectedPackets = ep.packetsReceived + ep.lostPackets
	}
	lossPct := 0.0
	if expectedPackets > 0 {
		lossPct = float64(lostPackets) / float64(expectedPackets) * 100.0
	}

	return RtpStats{
		RTPRxPkts:       ep.packetsReceived,
		RTPRxFromSBC:    ep.pktsFromExpectedSrc,
		RTPRxOther:      ep.pktsFromOtherSrc,
		RTCPRxPkts:      ep.rtcpReceived,
		MarkersReceived: ep.markersReceived,
		SSRCCount:       len(ep.ssrcRx),
		ExpectedPackets: expectedPackets,
		FirstRxMs:       firstMs,
		LastRxMs:        lastMs,

		JitterMs:            jitterMs,
		LostPackets:         lostPackets,
		OOOPackets:          ep.oooPackets,
		DupPackets:          ep.dupPackets,
		PacketLossPct:       lossPct,
		RemoteJitterMs:      remoteJitterMs,
		RemoteLossPct:       ep.remoteLossPct,
		RTTMs:               ep.rttMs,
		SRTPEnabled:         ep.srtpEnabled,
		SRTPDecryptFailures: ep.srtpDecryptFailures,
		SRTPAuthFailures:    ep.srtpAuthFailures,
		SRTPReplayFailures:  ep.srtpReplayFailures,
	}
}

func (ep *RtpEndpoint) ConfigureSRTP(cfg SRTPSessionConfig) error {
	ep.mu.Lock()
	defer ep.mu.Unlock()
	if !cfg.Enabled {
		ep.srtpEnabled = false
		ep.srtpEncrypt = nil
		ep.srtpDecrypt = nil
		return nil
	}
	profile, err := protectionProfile(cfg.CryptoSuite)
	if err != nil {
		return err
	}
	keyLen, err := profile.KeyLen()
	if err != nil {
		return err
	}
	saltLen, err := profile.SaltLen()
	if err != nil {
		return err
	}
	if len(cfg.OutboundKeySalt) != keyLen+saltLen {
		return fmt.Errorf("srtp outbound key/salt len=%d, want %d", len(cfg.OutboundKeySalt), keyLen+saltLen)
	}
	if len(cfg.InboundKeySalt) != keyLen+saltLen {
		return fmt.Errorf("srtp inbound key/salt len=%d, want %d", len(cfg.InboundKeySalt), keyLen+saltLen)
	}
	enc, err := srtp.CreateContext(cfg.OutboundKeySalt[:keyLen], cfg.OutboundKeySalt[keyLen:], profile)
	if err != nil {
		return fmt.Errorf("srtp encrypt context: %w", err)
	}
	dec, err := srtp.CreateContext(cfg.InboundKeySalt[:keyLen], cfg.InboundKeySalt[keyLen:], profile)
	if err != nil {
		return fmt.Errorf("srtp decrypt context: %w", err)
	}
	ep.srtpEnabled = true
	ep.srtpSuite = cfg.CryptoSuite
	ep.srtpEncrypt = enc
	ep.srtpDecrypt = dec
	return nil
}

func protectionProfile(suite string) (srtp.ProtectionProfile, error) {
	switch suite {
	case "AES_CM_128_HMAC_SHA1_80":
		return srtp.ProtectionProfileAes128CmHmacSha1_80, nil
	case "AES_CM_128_HMAC_SHA1_32":
		return srtp.ProtectionProfileAes128CmHmacSha1_32, nil
	default:
		return 0, fmt.Errorf("unsupported SRTP crypto suite %q", suite)
	}
}

// getPayload returns the next TX payload, embedding a marker every
// MarkerInterval packets. Also accumulates txOctets for the RTCP SR
// "sender's octet count" field (RFC 3550 §6.4.1).
func (ep *RtpEndpoint) getPayload() []byte {
	ep.txPkts++
	var p []byte
	if ep.txPkts%MarkerInterval == 0 {
		ep.markersSent++
		p = buildMarkerPayload(ep.markerTemplate, ep.markersSent)
	} else {
		p = ep.tonePayload
	}
	ep.txOctets += uint64(len(p))
	return p
}

// pinTxStreamLocked records the SSRC and RTP timestamp epoch (the random
// initial values picked by Run / RunUntilCancelled) so the RTCP SR loop can
// emit consistent sender-info blocks. Caller MUST hold ep.mu.
func (ep *RtpEndpoint) pinTxStreamLocked(ssrc, rtpEpoch uint32) {
	if !ep.txSSRCSet {
		ep.txSSRC = ssrc
		ep.txSSRCSet = true
	}
	if !ep.rtpEpochSet {
		ep.rtpEpoch = rtpEpoch
		ep.rtpEpochSet = true
		ep.rtpStartMs = float64(time.Now().UnixMilli())
	}
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

	// Pin TX stream identity so the RTCP SR loop (if enabled) can emit
	// consistent sender-info blocks. Spawned only when explicitly enabled
	// — when rtcpSREnabled=false this is a no-op (Phase 2 default).
	ep.mu.Lock()
	ep.pinTxStreamLocked(ssrc, ts)
	srEnabled := ep.rtcpSREnabled
	ep.mu.Unlock()
	if srEnabled {
		go ep.rtcpSRLoop(ctx, dest)
	}

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
			wirePkt, err := ep.protectRTP(pkt)
			if err != nil {
				slog.Warn("SRTP keepalive protect error", "err", err)
				break
			}
			if _, err := ep.conn.WriteToUDP(wirePkt, dest); err != nil {
				slog.Warn("RTP keepalive sendto error", "err", err, "dest", dest.String())
				break
			}

			ep.mu.Lock()
			pw := ep.pcap
			ep.mu.Unlock()
			if pw != nil {
				pw.WriteTx(wirePkt, remoteIP, remotePort)
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

// RunCoverage executes the coverage-based 3-phase send loop.
//
// Instead of a fixed short burst + sparse keepalive pattern, this mode derives
// the RTP-active duration from hold time:
//
//	active = hold_time * media_coverage_pct / 100
//
// It then spends that active time as a start burst, evenly spaced mid-call
// bursts, and an end burst while preserving normal full-rate RTP pacing.
func (ep *RtpEndpoint) RunCoverage(
	ctx context.Context,
	remoteIP string, remotePort int,
	durationSeconds float64,
	burstPPS int,
	opts CoverageOptions,
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

	ep.mu.Lock()
	ep.pinTxStreamLocked(ssrc, ts)
	srEnabled := ep.rtcpSREnabled
	ep.mu.Unlock()
	if srEnabled {
		go ep.rtcpSRLoop(ctx, dest)
	}

	coverage := clampFloat(float64(opts.MediaCoveragePct)/100.0, 0.01, 1.0)
	targetActive := durationSeconds * coverage
	startShare := clampFloat(float64(opts.StartBurstSharePct)/100.0, 0.0, 1.0)
	endShare := clampFloat(float64(opts.EndBurstSharePct)/100.0, 0.0, 1.0)
	if startShare+endShare >= 1.0 {
		// Validate rejects this, but keep the endpoint robust for direct tests.
		startShare = 0.2
		endShare = 0.2
	}

	phase1Seconds := targetActive * startShare
	phase3Seconds := targetActive * endShare
	phase2Seconds := targetActive - phase1Seconds - phase3Seconds
	if phase2Seconds < 0 {
		phase2Seconds = 0
	}

	phase1Deadline := time.Now().Add(time.Duration(phase1Seconds * float64(time.Second)))
	if phase1Deadline.After(callDeadline) {
		phase1Deadline = callDeadline
	}
	var err error
	seq, ts, err = ep.sendBurst(ctx, dest, ssrc, seq, ts, phase1Deadline, burstPPS)
	if err != nil {
		return err
	}

	phase3Start := callDeadline.Add(-time.Duration(phase3Seconds * float64(time.Second)))
	if phase3Start.Before(time.Now()) {
		phase3Start = time.Now()
	}

	midBurstSeconds := float64(opts.MidBurstSeconds)
	if midBurstSeconds <= 0 {
		midBurstSeconds = 3
	}
	midBurstCount := 0
	if phase2Seconds > 0 {
		midBurstCount = int(math.Ceil(phase2Seconds / midBurstSeconds))
	}

	midIdleWindow := phase3Start.Sub(time.Now()).Seconds() - phase2Seconds
	if midIdleWindow < 0 {
		midIdleWindow = 0
	}
	spacing := 0.0
	if midBurstCount > 0 {
		spacing = midIdleWindow / float64(midBurstCount+1)
	}

	remainingPhase2 := phase2Seconds
	for i := 0; i < midBurstCount && time.Now().Before(phase3Start); i++ {
		if spacing > 0 {
			seq, ts, err = ep.sendCoverageGap(ctx, dest, ssrc, seq, ts, spacing, opts)
			if err != nil {
				return err
			}
		}

		if remainingPhase2 <= 0 {
			break
		}
		thisBurst := math.Min(midBurstSeconds, remainingPhase2)
		burstDeadline := time.Now().Add(time.Duration(thisBurst * float64(time.Second)))
		if burstDeadline.After(phase3Start) {
			burstDeadline = phase3Start
		}
		seq, ts, err = ep.sendBurst(ctx, dest, ssrc, seq, ts, burstDeadline, burstPPS)
		if err != nil {
			return err
		}
		remainingPhase2 -= thisBurst
	}

	if sleepFor := time.Until(phase3Start); sleepFor > 0 {
		seq, ts, err = ep.sendCoverageGap(ctx, dest, ssrc, seq, ts, sleepFor.Seconds(), opts)
		if err != nil {
			return err
		}
	}

	if time.Now().Before(callDeadline) {
		_, _, err = ep.sendBurst(ctx, dest, ssrc, seq, ts, callDeadline, burstPPS)
		return err
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

	// Pin TX stream identity + spawn RTCP SR loop when enabled (Phase 2).
	ep.mu.Lock()
	ep.pinTxStreamLocked(ssrc, ts)
	srEnabled := ep.rtcpSREnabled
	ep.mu.Unlock()
	if srEnabled {
		go ep.rtcpSRLoop(ctx, dest)
	}

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
			wirePkt, err := ep.protectRTP(pkt)
			if err != nil {
				slog.Warn("SRTP keepalive protect error", "err", err)
				continue
			}
			_, _ = ep.conn.WriteToUDP(wirePkt, dest)

			ep.mu.Lock()
			pw := ep.pcap
			ep.mu.Unlock()
			if pw != nil {
				pw.WriteTx(wirePkt, remoteIP, remotePort)
			}

			seq++
			ts += uint32(ep.tsInc)
		}
	}

	return nil
}

// RunCoverageUntilCancelled is the UAS coverage-mode variant. The UAS does not
// know the exact BYE time, so callers pass a safety duration and cancel the
// context when BYE arrives.
func (ep *RtpEndpoint) RunCoverageUntilCancelled(
	ctx context.Context,
	remoteIP string, remotePort int,
	durationSeconds float64,
	burstPPS int,
	opts CoverageOptions,
) error {
	return ep.RunCoverage(ctx, remoteIP, remotePort, durationSeconds, burstPPS, opts)
}

// sendCoverageGap handles idle windows between coverage bursts. When
// keepalive is enabled it sends low-rate RTP so SBC/media watchdogs continue
// seeing media; otherwise it preserves the old silent-sleep behaviour.
func (ep *RtpEndpoint) sendCoverageGap(
	ctx context.Context,
	dest *net.UDPAddr,
	ssrc uint32, seq uint16, ts uint32,
	durationSeconds float64,
	opts CoverageOptions,
) (uint16, uint32, error) {
	if durationSeconds <= 0 {
		return seq, ts, nil
	}
	if !opts.KeepaliveEnabled {
		select {
		case <-time.After(time.Duration(durationSeconds * float64(time.Second))):
		case <-ctx.Done():
			return seq, ts, ctx.Err()
		}
		return seq, ts, nil
	}
	pps := opts.KeepalivePPS
	if pps <= 0 {
		pps = 3
	}
	return ep.sendKeepalive(ctx, dest, ssrc, seq, ts, durationSeconds, pps)
}

// sendKeepalive sends RTP at a low packet rate for the supplied duration while
// preserving sequence/timestamp continuity for the next full-rate burst.
func (ep *RtpEndpoint) sendKeepalive(
	ctx context.Context,
	dest *net.UDPAddr,
	ssrc uint32, seq uint16, ts uint32,
	durationSeconds float64,
	pps int,
) (uint16, uint32, error) {
	interval := time.Duration(float64(time.Second) / float64(pps))
	deadline := time.Now().Add(time.Duration(durationSeconds * float64(time.Second)))
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
		wirePkt, err := ep.protectRTP(pkt)
		if err != nil {
			slog.Warn("SRTP keepalive protect error", "err", err)
			return seq, ts, nil
		}
		if _, err := ep.conn.WriteToUDP(wirePkt, dest); err != nil {
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
			pw.WriteTx(wirePkt, dest.IP.String(), dest.Port)
		}

		seq++
		ts += uint32(ep.tsInc)

		nextSend = nextSend.Add(interval)
		sleepFor := time.Until(nextSend)
		if untilDeadline := time.Until(deadline); sleepFor > untilDeadline {
			sleepFor = untilDeadline
		}
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

func clampFloat(v, minV, maxV float64) float64 {
	if v < minV {
		return minV
	}
	if v > maxV {
		return maxV
	}
	return v
}

func (ep *RtpEndpoint) protectRTP(pkt []byte) ([]byte, error) {
	ep.mu.Lock()
	enabled := ep.srtpEnabled
	ctx := ep.srtpEncrypt
	ep.mu.Unlock()
	if !enabled {
		return pkt, nil
	}
	if ctx == nil {
		return nil, fmt.Errorf("srtp encrypt context not configured")
	}
	return ctx.EncryptRTP(nil, pkt, nil)
}

func (ep *RtpEndpoint) unprotectRTP(pkt []byte) ([]byte, error) {
	ep.mu.Lock()
	enabled := ep.srtpEnabled
	ctx := ep.srtpDecrypt
	ep.mu.Unlock()
	if !enabled {
		return pkt, nil
	}
	if ctx == nil {
		return nil, fmt.Errorf("srtp decrypt context not configured")
	}
	return ctx.DecryptRTP(nil, pkt, nil)
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
		wirePkt, err := ep.protectRTP(pkt)
		if err != nil {
			slog.Warn("SRTP burst protect error", "err", err)
			return seq, ts, nil
		}
		if _, err := ep.conn.WriteToUDP(wirePkt, dest); err != nil {
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
			pw.WriteTx(wirePkt, dest.IP.String(), dest.Port)
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

		plain, err := ep.unprotectRTP(data)
		if err != nil {
			ep.mu.Lock()
			ep.srtpDecryptFailures++
			errText := strings.ToLower(err.Error())
			if strings.Contains(errText, "duplicated") || strings.Contains(errText, "replay") {
				ep.srtpReplayFailures++
			} else {
				ep.srtpAuthFailures++
			}
			ep.mu.Unlock()
			continue
		}
		data = plain
		n = len(data)

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
	ep.updateSSRCSeqLocked(ssrc, seq)

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

func (ep *RtpEndpoint) updateSSRCSeqLocked(ssrc uint32, seq uint16) {
	st := ep.ssrcRx[ssrc]
	if st == nil {
		ep.ssrcRx[ssrc] = &ssrcRxState{
			baseSeq:  seq,
			maxSeq:   seq,
			received: 1,
		}
		return
	}

	st.received++
	const maxDropout = 3000
	const maxMisorder = 100
	udelta := seq - st.maxSeq
	switch {
	case int(udelta) < maxDropout:
		if seq < st.maxSeq {
			st.cycles += 1 << 16
		}
		st.maxSeq = seq
	case int(udelta) <= (1<<16)-maxMisorder:
		// Probable duplicate, re-ordered packet, or restart. Count it as
		// received, but do not advance the highest extended sequence.
	default:
		// Small negative delta: late/re-ordered packet near maxSeq.
	}
}

func (st *ssrcRxState) expected() int {
	extendedMax := st.cycles + uint32(st.maxSeq)
	base := uint32(st.baseSeq)
	if extendedMax < base {
		return st.received
	}
	return int(extendedMax-base) + 1
}

// parseRTCPPacket walks compound RTCP packets and extracts the most recent
// RR block targeting our SSRC. RFC 3550 §6.4 / §6.4.1 layouts:
//
//	SR  (PT=200): 4-byte header + 24-byte sender info + N×24-byte RR blocks
//	RR  (PT=201): 4-byte header + 4-byte reporter SSRC + N×24-byte RR blocks
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
		if (data[off] >> 6) != 2 {
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
			// Report-block layout (RFC 3550 §6.4.1):
			//   bytes 0-3  : SSRC_n — source this report block describes
			//   byte  4    : fraction lost (numerator over 256)
			//   bytes 12-15: interarrival jitter (RTP timestamp units)
			//   bytes 16-19: LSR — middle 32 bits of the NTP ts in the
			//                last SR we sent, echoed back by the SBC
			//   bytes 20-23: DLSR — delay since the SBC received the SR,
			//                in 1/65536 second units
			reportSSRC := binary.BigEndian.Uint32(data[start : start+4])
			fractionLost := data[start+4]
			jitterRTP := binary.BigEndian.Uint32(data[start+12 : start+16])
			lsr := binary.BigEndian.Uint32(data[start+16 : start+20])
			dlsr := binary.BigEndian.Uint32(data[start+20 : start+24])

			ep.mu.Lock()
			if ep.txSSRCSet && reportSSRC != ep.txSSRC {
				ep.mu.Unlock()
				continue
			}
			ep.remoteJitterRTP = float64(jitterRTP)
			ep.remoteLossPct = float64(fractionLost) / 256.0 * 100.0
			// RTT = NTP(now)_mid32 - LSR - DLSR
			// All three values are in the same 1/65536-second unit; uint32
			// subtraction wraps cleanly. Skip when LSR/DLSR are zero —
			// that means the SBC has no SR from us yet (we never sent
			// one, or the SR loop hasn't fired).
			if lsr != 0 && dlsr != 0 {
				nowHi, nowLo := getNTPNow()
				nowMid := (nowHi << 16) | (nowLo >> 16)
				rttUnits := nowMid - lsr - dlsr
				ep.rttMs = float64(rttUnits) / 65536.0 * 1000.0
			}
			ep.mu.Unlock()
		}

		off += recordLen
	}
}

// getNTPNow returns the current wall clock as a 64-bit NTP timestamp split
// into 32-bit seconds and 32-bit fraction parts (RFC 3550 §4 / RFC 5905).
// NTP epoch is Jan 1, 1900; offset from Unix epoch is 2208988800 seconds.
func getNTPNow() (hi, lo uint32) {
	const ntpEpochOffset uint64 = 2208988800
	now := time.Now()
	secs := uint64(now.Unix()) + ntpEpochOffset
	frac := (uint64(now.Nanosecond()) << 32) / 1_000_000_000
	return uint32(secs), uint32(frac)
}

// buildRTCPSR constructs a 28-byte RTCP Sender Report (PT=200, RC=0) per
// RFC 3550 §6.4.1. No RR blocks are appended — we only emit SR to give the
// SBC enough info to compute RTT back to us via DLSR in its RR.
//
//	 0                   1                   2                   3
//	 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|V=2|P|    RC   |   PT=SR=200   |             length=6          |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|                         SSRC of sender                        |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|              NTP timestamp, most significant word             |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|             NTP timestamp, least significant word             |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|                         RTP timestamp                         |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|                     sender's packet count                     |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
//	|                      sender's octet count                     |
//	+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
func buildRTCPSR(ssrc, ntpHi, ntpLo, rtpTs, pktCount, octCount uint32) []byte {
	buf := make([]byte, 28)
	buf[0] = 0x80                           // V=2, P=0, RC=0
	buf[1] = 200                            // PT = SR
	binary.BigEndian.PutUint16(buf[2:4], 6) // length = (28/4)-1
	binary.BigEndian.PutUint32(buf[4:8], ssrc)
	binary.BigEndian.PutUint32(buf[8:12], ntpHi)
	binary.BigEndian.PutUint32(buf[12:16], ntpLo)
	binary.BigEndian.PutUint32(buf[16:20], rtpTs)
	binary.BigEndian.PutUint32(buf[20:24], pktCount)
	binary.BigEndian.PutUint32(buf[24:28], octCount)
	return buf
}

// rtcpSRLoop emits an RTCP Sender Report to dest every rtcpSRInterval until
// ctx is cancelled. Phase 2 — only spawned when ep.rtcpSREnabled is true.
//
// Sends on the SAME UDP socket as RTP (RFC 5761 multiplexing). The peer SDP
// MUST advertise a=rtcp-mux for this to be safely interpreted by the SBC;
// config.Validate enforces this coupling.
func (ep *RtpEndpoint) rtcpSRLoop(ctx context.Context, dest *net.UDPAddr) {
	interval := ep.rtcpSRInterval
	if interval <= 0 {
		interval = 5 * time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		// Snapshot mutable state under the lock; build/send outside it.
		ep.mu.Lock()
		ssrcSet := ep.txSSRCSet
		epochSet := ep.rtpEpochSet
		ssrc := ep.txSSRC
		epoch := ep.rtpEpoch
		startMs := ep.rtpStartMs
		pkts := uint32(ep.txPkts)
		octs := uint32(ep.txOctets)
		pw := ep.pcap
		ep.mu.Unlock()

		if !ssrcSet || !epochSet {
			// No RTP sent yet — nothing meaningful to report.
			continue
		}

		ntpHi, ntpLo := getNTPNow()
		// Current RTP timestamp = epoch + samples elapsed since first
		// packet. Drives the SBC's playout-buffer correlation between
		// RTP timestamps and wall-clock.
		elapsedMs := float64(time.Now().UnixMilli()) - startMs
		sampleOffset := uint32(elapsedMs * float64(SampleRate) / 1000.0)
		rtpTs := epoch + sampleOffset

		sr := buildRTCPSR(ssrc, ntpHi, ntpLo, rtpTs, pkts, octs)
		if _, err := ep.conn.WriteToUDP(sr, dest); err != nil {
			slog.Debug("RTCP SR send error",
				"err", err, "dest", dest.String(),
				"local_port", ep.localPort)
			continue
		}
		if pw != nil {
			pw.WriteTx(sr, dest.IP.String(), dest.Port)
		}
	}
}

// packRTP builds a minimal 12-byte RFC 3550 RTP header + payload.
// When marker is true the RTP M bit (bit 7 of byte 1) is set, signalling the
// start of a talkspurt per RFC 3551 §4.1.
func packRTP(seq uint16, ts uint32, ssrc uint32, payload []byte, marker bool) []byte {
	hdr := make([]byte, 12+len(payload))
	hdr[0] = 0x80       // V=2, P=0, X=0, CC=0
	pt := byte(PT_PCMU) // PT=0 (PCMU)
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
