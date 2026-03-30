package rtp

import (
	"encoding/binary"
	"net"
	"os"
	"sync"
	"time"
)

const (
	pcapMagic       = 0xa1b2c3d4
	pcapVerMajor    = 2
	pcapVerMinor    = 4
	pcapSnaplen     = 65535
	pcapLinktypeRaw = 101 // LINKTYPE_RAW — raw IPv4, no Ethernet framing
)

// PcapWriter writes RTP packets to a standard libpcap file with synthetic
// IPv4/UDP headers. Wireshark opens these natively.
type PcapWriter struct {
	f         *os.File
	localIP   string
	localPort int
	pktCount  int
	mu        sync.Mutex
}

// NewPcapWriter creates a pcap file and writes the global header.
func NewPcapWriter(path, localIP string, localPort int) (*PcapWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}

	// pcap global header: magic, version 2.4, thiszone, sigfigs, snaplen, linktype
	var hdr [24]byte
	binary.LittleEndian.PutUint32(hdr[0:4], pcapMagic)
	binary.LittleEndian.PutUint16(hdr[4:6], pcapVerMajor)
	binary.LittleEndian.PutUint16(hdr[6:8], pcapVerMinor)
	binary.LittleEndian.PutUint32(hdr[8:12], 0)  // thiszone
	binary.LittleEndian.PutUint32(hdr[12:16], 0) // sigfigs
	binary.LittleEndian.PutUint32(hdr[16:20], pcapSnaplen)
	binary.LittleEndian.PutUint32(hdr[20:24], pcapLinktypeRaw)

	if _, err := f.Write(hdr[:]); err != nil {
		f.Close()
		return nil, err
	}

	return &PcapWriter{
		f:         f,
		localIP:   localIP,
		localPort: localPort,
	}, nil
}

// WriteTx records a transmitted RTP packet.
func (pw *PcapWriter) WriteTx(rtpData []byte, dstIP string, dstPort int) {
	pw.writePacket(rtpData, pw.localIP, pw.localPort, dstIP, dstPort)
}

// WriteRx records a received RTP packet.
func (pw *PcapWriter) WriteRx(rtpData []byte, srcIP string, srcPort int) {
	pw.writePacket(rtpData, srcIP, srcPort, pw.localIP, pw.localPort)
}

// Close flushes and closes the pcap file.
func (pw *PcapWriter) Close() {
	pw.mu.Lock()
	defer pw.mu.Unlock()
	if pw.f != nil {
		pw.f.Sync()
		pw.f.Close()
		pw.f = nil
	}
}

// PacketCount returns the number of packets written.
func (pw *PcapWriter) PacketCount() int {
	pw.mu.Lock()
	defer pw.mu.Unlock()
	return pw.pktCount
}

// writePacket builds a raw IPv4+UDP frame and writes a pcap record.
func (pw *PcapWriter) writePacket(rtpData []byte, srcIP string, srcPort int, dstIP string, dstPort int) {
	frame := buildFrame(rtpData, srcIP, srcPort, dstIP, dstPort)
	now := time.Now()
	tsSec := uint32(now.Unix())
	tsUsec := uint32(now.Nanosecond() / 1000)

	var recHdr [16]byte
	binary.LittleEndian.PutUint32(recHdr[0:4], tsSec)
	binary.LittleEndian.PutUint32(recHdr[4:8], tsUsec)
	binary.LittleEndian.PutUint32(recHdr[8:12], uint32(len(frame)))
	binary.LittleEndian.PutUint32(recHdr[12:16], uint32(len(frame)))

	pw.mu.Lock()
	defer pw.mu.Unlock()
	if pw.f == nil {
		return
	}
	pw.f.Write(recHdr[:])
	pw.f.Write(frame)
	pw.pktCount++
}

// buildFrame constructs a raw IPv4 + UDP + RTP payload byte slice.
func buildFrame(rtpData []byte, srcIP string, srcPort int, dstIP string, dstPort int) []byte {
	udpLen := 8 + len(rtpData)
	totalLen := 20 + udpLen

	frame := make([]byte, totalLen)

	// IPv4 header (20 bytes)
	frame[0] = 0x45 // version=4, IHL=5
	frame[1] = 0x00 // DSCP/ECN
	binary.BigEndian.PutUint16(frame[2:4], uint16(totalLen))
	binary.BigEndian.PutUint16(frame[4:6], 0) // identification
	binary.BigEndian.PutUint16(frame[6:8], 0x4000) // DF flag
	frame[8] = 64  // TTL
	frame[9] = 17  // protocol = UDP
	binary.BigEndian.PutUint16(frame[10:12], 0) // checksum (let Wireshark recalc)
	copy(frame[12:16], net.ParseIP(srcIP).To4())
	copy(frame[16:20], net.ParseIP(dstIP).To4())

	// UDP header (8 bytes)
	binary.BigEndian.PutUint16(frame[20:22], uint16(srcPort))
	binary.BigEndian.PutUint16(frame[22:24], uint16(dstPort))
	binary.BigEndian.PutUint16(frame[24:26], uint16(udpLen))
	binary.BigEndian.PutUint16(frame[26:28], 0) // checksum

	// RTP payload
	copy(frame[28:], rtpData)

	return frame
}
