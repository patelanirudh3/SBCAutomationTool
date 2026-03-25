"""
traffic/rtp_stream.py
=====================
Unified asyncio RTP endpoint for bidirectional media-plane load testing.

RFC 3550 RTP + G.711 MU-law (PCMU, PT=0) — matches CM Codec Set:
  - 8 000 Hz sample rate
  - Configurable ptime (20 ms default, 40 ms option)
  - Payload: 1 kHz tone (PCMU-encoded sine wave)
  - No silence suppression (matches CM "Silence Suppression: n")

Two send modes:
  3-Phase (default for traffic):
    BURST_START → KEEPALIVE → BURST_END
  Continuous (default for smoke/scenario):
    Full PPS for entire hold_time

Marker payload validation:
  Every N packets (default 100), the sender embeds a 4-byte magic + 4-byte
  sequence in the payload.  The receiver inspects every incoming RTP packet
  for the magic bytes and increments a counter.  Cross-check at the spine
  level compares markers_sent vs markers_received from the other side.

PCAP capture (optional):
  When enabled via enable_pcap(), every TX and RX packet is written to a
  standard pcap file with synthetic IPv4/UDP headers.  Wireshark opens these
  files natively and auto-decodes the 1 kHz tone as playable G.711 audio.

Both UAC and UAS use the same RtpEndpoint class — one UDP socket per call leg
that sends and receives (counting protocol).

Corner cases handled:
  - CancelledError (SIGTERM / early BYE)  -> loop exits, re-raises
  - sendto errors                         -> loop breaks, no crash
  - remote_port 0 / 9                     -> sleep fallback
  - close() called multiple times         -> idempotent
  - N concurrent calls                    -> each gets a distinct OS port
"""

from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import struct
import time
from dataclasses import dataclass
from typing import Tuple

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RTP / codec constants
# ---------------------------------------------------------------------------

_PT_PCMU      = 0           # G.711 MU-law payload type (RFC 3551)
_SAMPLE_RATE  = 8000        # G.711 sample rate

# Marker payload magic bytes (embedded every N packets for validation)
_MARKER_MAGIC = b'\xCC\x11\xCC\x11'
_MARKER_INTERVAL = 100      # embed marker every 100th packet (internal, not on GUI)


# ---------------------------------------------------------------------------
# Ptime-aware payload and constants
# ---------------------------------------------------------------------------

def _compute_ptime_params(ptime_ms: int = 20) -> tuple[int, int, bytes, bytes]:
    """
    Compute (ts_increment, payload_size, tone_payload, marker_template)
    for the given ptime.

    Returns:
        ts_inc:           RTP timestamp increment per packet
        payload_size:     bytes per packet payload
        tone_payload:     1 kHz tone PCMU-encoded
        marker_template:  marker payload (magic + 4 zero bytes + tone tail)
    """
    samples = _SAMPLE_RATE * ptime_ms // 1000   # 160 for 20ms, 320 for 40ms
    ts_inc  = samples

    # Build 1 kHz tone as PCMU-encoded samples
    tone = bytearray(samples)
    for i in range(samples):
        t = i / _SAMPLE_RATE
        linear = int(16384 * math.sin(2 * math.pi * 1000 * t))
        tone[i] = _linear_to_ulaw(linear)
    tone_payload = bytes(tone)

    # Marker: magic(4) + seq(4) + remaining tone
    marker = bytearray(samples)
    marker[0:4] = _MARKER_MAGIC
    marker[4:8] = b'\x00\x00\x00\x00'  # placeholder for sequence
    marker[8:] = tone_payload[8:]
    marker_template = bytes(marker)

    return ts_inc, samples, tone_payload, marker_template


def _linear_to_ulaw(sample: int) -> int:
    """Convert a signed 16-bit linear PCM sample to G.711 mu-law."""
    BIAS = 0x84
    CLIP = 32635
    sign = 0
    if sample < 0:
        sign = 0x80
        sample = -sample
    if sample > CLIP:
        sample = CLIP
    sample += BIAS
    exponent = 7
    for exp_val in (0x4000, 0x2000, 0x1000, 0x800, 0x400, 0x200, 0x100):
        if sample >= exp_val:
            break
        exponent -= 1
    mantissa = (sample >> (exponent + 3)) & 0x0F
    return ~(sign | (exponent << 4) | mantissa) & 0xFF


# Pre-compute default payloads (20ms)
_DEFAULT_TS_INC, _DEFAULT_PAYLOAD_SIZE, _DEFAULT_TONE, _DEFAULT_MARKER = \
    _compute_ptime_params(20)


# ---------------------------------------------------------------------------
# PCAP writer — standard libpcap file format (Wireshark-native)
# ---------------------------------------------------------------------------

class PcapWriter:
    """
    Write RTP packets to a pcap file with synthetic IPv4/UDP headers.

    File format: standard libpcap (magic 0xa1b2c3d4), link type LINKTYPE_RAW
    (101 = raw IPv4).  Wireshark opens these directly, auto-detects RTP by
    port heuristics, and can play back the 1 kHz tone.
    """

    _PCAP_MAGIC    = 0xa1b2c3d4
    _VER_MAJOR     = 2
    _VER_MINOR     = 4
    _SNAPLEN       = 65535
    _LINKTYPE_RAW  = 101        # Raw IPv4 — no Ethernet framing needed

    __slots__ = ("_f", "_local_ip", "_local_port", "_pkt_count", "path")

    def __init__(self, path: str, local_ip: str, local_port: int) -> None:
        self.path = path
        self._local_ip = local_ip
        self._local_port = local_port
        self._pkt_count = 0

        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)

        self._f = open(path, "wb")
        self._f.write(struct.pack(
            "<IHHiIII",
            self._PCAP_MAGIC,
            self._VER_MAJOR,
            self._VER_MINOR,
            0,                  # thiszone
            0,                  # sigfigs
            self._SNAPLEN,
            self._LINKTYPE_RAW,
        ))

    @property
    def packet_count(self) -> int:
        return self._pkt_count

    @staticmethod
    def _ip_bytes(ip: str) -> bytes:
        return bytes(int(octet) for octet in ip.split("."))

    def _frame(
        self,
        rtp_data: bytes,
        src_ip: str, src_port: int,
        dst_ip: str, dst_port: int,
    ) -> bytes:
        """Build raw IPv4 + UDP + RTP payload frame."""
        udp_len   = 8 + len(rtp_data)
        total_len = 20 + udp_len

        ip_hdr = struct.pack(
            "!BBHHHBBH4s4s",
            0x45,                       # ver=4, IHL=5 (20 bytes, no options)
            0x00,                       # DSCP / ECN
            total_len,
            0,                          # identification
            0x4000,                     # flags=DF, frag_offset=0
            64,                         # TTL
            17,                         # protocol = UDP
            0,                          # checksum (0 = let Wireshark recalc)
            self._ip_bytes(src_ip),
            self._ip_bytes(dst_ip),
        )
        udp_hdr = struct.pack("!HHHH", src_port, dst_port, udp_len, 0)
        return ip_hdr + udp_hdr + rtp_data

    def _write(
        self,
        rtp_data: bytes,
        src_ip: str, src_port: int,
        dst_ip: str, dst_port: int,
    ) -> None:
        frame = self._frame(rtp_data, src_ip, src_port, dst_ip, dst_port)
        now = time.time()
        ts_sec  = int(now)
        ts_usec = int((now - ts_sec) * 1_000_000)

        self._f.write(struct.pack("<IIII", ts_sec, ts_usec, len(frame), len(frame)))
        self._f.write(frame)
        self._pkt_count += 1

    def write_tx(self, rtp_data: bytes, dst_ip: str, dst_port: int) -> None:
        """Record a transmitted RTP packet."""
        self._write(rtp_data, self._local_ip, self._local_port, dst_ip, dst_port)

    def write_rx(self, rtp_data: bytes, src_ip: str, src_port: int) -> None:
        """Record a received RTP packet (including RTCP — useful in Wireshark)."""
        self._write(rtp_data, src_ip, src_port, self._local_ip, self._local_port)

    def close(self) -> None:
        if self._f and not self._f.closed:
            self._f.flush()
            self._f.close()


# ---------------------------------------------------------------------------
# RTP packet builder
# ---------------------------------------------------------------------------

def _pack_rtp(seq: int, ts: int, ssrc: int, payload: bytes) -> bytes:
    """
    Build a minimal RFC 3550 RTP packet.
      Byte 1 : V=2  P=0  X=0  CC=0   -> 0x80
      Byte 2 : M=0  PT=0 (PCMU)      -> 0x00
      Bytes 3-4  : sequence number
      Bytes 5-8  : timestamp
      Bytes 9-12 : SSRC
    """
    return struct.pack(
        "!BBHII",
        0x80,
        _PT_PCMU,
        seq  & 0xFFFF,
        ts   & 0xFFFFFFFF,
        ssrc & 0xFFFFFFFF,
    ) + payload


def _build_marker_payload(template: bytes, marker_seq: int) -> bytes:
    """Embed the marker sequence number into the marker template."""
    buf = bytearray(template)
    struct.pack_into("!I", buf, 4, marker_seq)
    return bytes(buf)


# ---------------------------------------------------------------------------
# RTP stats dataclass
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RtpStats:
    """Immutable snapshot of an RtpEndpoint's counters."""
    rtp_rx_pkts: int
    rtp_rx_from_sbc: int
    rtp_rx_other: int
    rtcp_rx_pkts: int
    markers_received: int
    first_rx_ms: float | None
    last_rx_ms: float | None


# ---------------------------------------------------------------------------
# Counting DatagramProtocol — with RTCP filter and marker detection
# ---------------------------------------------------------------------------

class _CountingProtocol(asyncio.DatagramProtocol):
    """
    Counts incoming UDP datagrams with classification:
    - RTP (PT < 200): counted by source (expected SBC vs other)
    - RTCP (PT >= 200): counted separately, not mixed into RTP
    - Marker detection: inspects payload for magic bytes
    - PCAP: optionally writes every RX packet to a PcapWriter
    """
    def __init__(self):
        self.packets_received: int = 0
        self.pkts_from_expected_src: int = 0
        self.pkts_from_other_src: int = 0
        self.rtcp_received: int = 0
        self.markers_received: int = 0
        self.first_recv_ts: float | None = None
        self.last_recv_ts: float | None = None
        self._expected_src: tuple[str, int] | None = None
        self._transport = None
        self._pcap: PcapWriter | None = None

    def connection_made(self, transport) -> None:
        self._transport = transport

    def set_expected_src(self, ip: str, port: int) -> None:
        self._expected_src = (ip, port)

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if len(data) < 12:
            return

        if (data[0] >> 6) != 2:
            return

        if self._pcap:
            try:
                self._pcap.write_rx(data, addr[0], addr[1])
            except Exception:
                pass

        # RTCP filter: RTCP packet types occupy the full byte[1] (200-207).
        # In RTP byte[1] is M(1)|PT(7) so valid RTP PTs are 0-127 even with
        # the marker bit set (128+PT).  RTCP types 200-207 never collide.
        if 200 <= data[1] <= 207:
            self.rtcp_received += 1
            return

        now = time.monotonic() * 1000
        if self.first_recv_ts is None:
            self.first_recv_ts = now
        self.last_recv_ts = now
        self.packets_received += 1

        if self._expected_src is not None and addr == self._expected_src:
            self.pkts_from_expected_src += 1
        else:
            self.pkts_from_other_src += 1

        # Marker detection: compute actual payload offset accounting for
        # CSRC entries (CC field) and header extensions (X bit) that the
        # SBC may add when relaying packets.
        cc = data[0] & 0x0F
        has_ext = bool(data[0] & 0x10)
        payload_off = 12 + cc * 4
        if has_ext and len(data) >= payload_off + 4:
            ext_len = int.from_bytes(data[payload_off + 2:payload_off + 4], 'big')
            payload_off += 4 + ext_len * 4

        if len(data) >= payload_off + 4 and data[payload_off:payload_off + 4] == _MARKER_MAGIC:
            self.markers_received += 1

    def error_received(self, exc: Exception) -> None:
        log.debug("RTP socket error: %s", exc)

    def connection_lost(self, exc) -> None:
        pass


# ---------------------------------------------------------------------------
# RtpEndpoint — unified bidirectional endpoint
# ---------------------------------------------------------------------------

class RtpEndpoint:
    """
    Bidirectional G.711 PCMU RTP endpoint — used by both UAC and UAS.

    Binds one OS-assigned UDP port (advertised in SDP).  Sends using the
    configured mode (3-phase or continuous) and receives via _CountingProtocol.

    Optional pcap capture: call enable_pcap(path) after create() to write
    every TX and RX packet to a standard pcap file.  Wireshark opens the
    file natively and can play back the 1 kHz tone as audio.
    """

    __slots__ = ("_transport", "_protocol", "_local_port", "_local_ip",
                 "_closed", "_tx_pkts",
                 "_markers_sent", "_remote_ip", "_remote_port",
                 "_ts_inc", "_tone_payload", "_marker_template",
                 "_pcap")

    def __init__(
        self,
        transport: asyncio.DatagramTransport,
        protocol: _CountingProtocol,
        local_port: int,
        local_ip: str = "",
        ptime_ms: int = 20,
    ) -> None:
        self._transport = transport
        self._protocol  = protocol
        self._local_port = local_port
        self._local_ip  = local_ip
        self._closed    = False
        self._tx_pkts   = 0
        self._markers_sent = 0
        self._remote_ip: str = ""
        self._remote_port: int = 0
        self._pcap: PcapWriter | None = None

        ts_inc, _, tone, marker = _compute_ptime_params(ptime_ms)
        self._ts_inc = ts_inc
        self._tone_payload = tone
        self._marker_template = marker

    @classmethod
    async def create(cls, local_ip: str, ptime_ms: int = 20) -> "RtpEndpoint":
        loop = asyncio.get_running_loop()
        transport, protocol = await loop.create_datagram_endpoint(
            _CountingProtocol,
            local_addr=(local_ip, 0),
        )
        sock = transport.get_extra_info("socket")
        port = sock.getsockname()[1]
        log.debug("RtpEndpoint: bound %s:%d (ptime=%dms)", local_ip, port, ptime_ms)
        return cls(transport, protocol, port, local_ip, ptime_ms)

    @property
    def local_port(self) -> int:
        return self._local_port

    @property
    def tx_pkts(self) -> int:
        return self._tx_pkts

    @property
    def markers_sent(self) -> int:
        return self._markers_sent

    def set_remote_rtp_addr(self, ip: str, port: int) -> None:
        self._remote_ip = ip
        self._remote_port = port
        if self._protocol is not None:
            self._protocol.set_expected_src(ip, port)

    def enable_pcap(self, path: str) -> None:
        """Enable pcap capture. Call after create(), before run()."""
        try:
            self._pcap = PcapWriter(path, self._local_ip, self._local_port)
            self._protocol._pcap = self._pcap
            log.info("RtpEndpoint: pcap capture enabled -> %s", path)
        except Exception as exc:
            log.warning("RtpEndpoint: pcap init failed (%s) — continuing without capture", exc)
            self._pcap = None

    @property
    def pcap_path(self) -> str:
        """Return the pcap file path, or empty string if capture is not enabled."""
        return self._pcap.path if self._pcap else ""

    @property
    def stats(self) -> RtpStats:
        if self._protocol is None:
            return RtpStats(0, 0, 0, 0, 0, None, None)
        return RtpStats(
            rtp_rx_pkts=self._protocol.packets_received,
            rtp_rx_from_sbc=self._protocol.pkts_from_expected_src,
            rtp_rx_other=self._protocol.pkts_from_other_src,
            rtcp_rx_pkts=self._protocol.rtcp_received,
            markers_received=self._protocol.markers_received,
            first_rx_ms=self._protocol.first_recv_ts,
            last_rx_ms=self._protocol.last_recv_ts,
        )

    # ------------------------------------------------------------------
    # Payload helpers
    # ------------------------------------------------------------------

    def _get_payload(self) -> bytes:
        """Get the payload for the next packet, embedding a marker every N packets."""
        self._tx_pkts += 1
        if self._tx_pkts % _MARKER_INTERVAL == 0:
            self._markers_sent += 1
            return _build_marker_payload(self._marker_template, self._markers_sent)
        return self._tone_payload

    # ------------------------------------------------------------------
    # 3-Phase mode (UAC)
    # ------------------------------------------------------------------

    async def run(
        self,
        remote_ip: str,
        remote_port: int,
        duration_seconds: float,
        burst_seconds: float = 2.0,
        burst_pps: int = 50,
        keepalive_interval: float = 5.0,
        continuous: bool = False,
    ) -> None:
        """
        UAC send loop.

        continuous=False (3-phase):
          BURST_START -> KEEPALIVE -> BURST_END

        continuous=True:
          Full PPS for entire duration_seconds
        """
        if not remote_ip or remote_port <= 0 or remote_port == 9:
            log.debug("RtpEndpoint: remote %s:%d — discard/invalid, sleeping %.1fs",
                      remote_ip, remote_port, duration_seconds)
            await asyncio.sleep(duration_seconds)
            return

        loop = asyncio.get_running_loop()
        ssrc = random.randint(1, 0xFFFFFFFF)
        seq  = random.randint(0, 0xFFFF)
        ts   = random.randint(0, 0xFFFFFFFF)
        dest = (remote_ip, remote_port)
        call_deadline = loop.time() + duration_seconds

        try:
            if continuous:
                seq, ts = await self._send_burst(
                    dest, ssrc, seq, ts, call_deadline, burst_pps, loop,
                )
            else:
                burst_end_start = call_deadline - burst_seconds

                # Phase 1: BURST_START
                seq, ts = await self._send_burst(
                    dest, ssrc, seq, ts,
                    min(loop.time() + burst_seconds, call_deadline),
                    burst_pps, loop,
                )

                # Phase 2: KEEPALIVE
                while loop.time() < burst_end_start:
                    remaining = burst_end_start - loop.time()
                    sleep_for = min(keepalive_interval, remaining)
                    if sleep_for <= 0:
                        break
                    await asyncio.sleep(sleep_for)
                    if loop.time() >= call_deadline:
                        break

                    payload = self._get_payload()
                    pkt = _pack_rtp(seq, ts, ssrc, payload)
                    try:
                        self._transport.sendto(pkt, dest)
                    except Exception as exc:
                        log.debug("RtpEndpoint: keepalive sendto error: %s", exc)
                        break

                    if self._pcap:
                        try:
                            self._pcap.write_tx(pkt, dest[0], dest[1])
                        except Exception:
                            pass

                    seq = (seq + 1) & 0xFFFF
                    ts  = (ts + self._ts_inc) & 0xFFFFFFFF

                # Phase 3: BURST_END
                if loop.time() < call_deadline:
                    seq, ts = await self._send_burst(
                        dest, ssrc, seq, ts, call_deadline, burst_pps, loop,
                    )

        except asyncio.CancelledError:
            log.debug("RtpEndpoint: cancelled after %d tx / %d rx -> %s:%d",
                      self._tx_pkts, self._protocol.packets_received,
                      remote_ip, remote_port)
            raise

        log.debug("RtpEndpoint: done — tx=%d rx=%d markers_sent=%d -> %s:%d (%.1fs)",
                  self._tx_pkts, self._protocol.packets_received,
                  self._markers_sent, remote_ip, remote_port, duration_seconds)

    # ------------------------------------------------------------------
    # UAS variant: runs until cancelled
    # ------------------------------------------------------------------

    async def run_until_cancelled(
        self,
        remote_ip: str,
        remote_port: int,
        burst_seconds: float = 2.0,
        burst_pps: int = 50,
        keepalive_interval: float = 5.0,
        continuous: bool = False,
    ) -> None:
        """
        UAS variant: runs indefinitely until externally cancelled (BYE).

        continuous=False: BURST_START → KEEPALIVE forever
        continuous=True:  Full PPS forever
        """
        if not remote_ip or remote_port <= 0 or remote_port == 9:
            log.debug("RtpEndpoint: remote %s:%d — discard/invalid, waiting for cancel",
                      remote_ip, remote_port)
            try:
                while True:
                    await asyncio.sleep(1.0)
            except asyncio.CancelledError:
                return
            return

        loop = asyncio.get_running_loop()
        ssrc = random.randint(1, 0xFFFFFFFF)
        seq  = random.randint(0, 0xFFFF)
        ts   = random.randint(0, 0xFFFFFFFF)
        dest = (remote_ip, remote_port)

        try:
            if continuous:
                # Send at full PPS forever until cancelled
                far_future = loop.time() + 86400  # 24 hours — cancelled long before
                seq, ts = await self._send_burst(
                    dest, ssrc, seq, ts, far_future, burst_pps, loop,
                )
            else:
                # BURST_START
                burst_deadline = loop.time() + burst_seconds
                seq, ts = await self._send_burst(
                    dest, ssrc, seq, ts, burst_deadline, burst_pps, loop,
                )

                # KEEPALIVE forever until cancelled
                while True:
                    await asyncio.sleep(keepalive_interval)
                    payload = self._get_payload()
                    pkt = _pack_rtp(seq, ts, ssrc, payload)
                    try:
                        self._transport.sendto(pkt, dest)
                    except Exception:
                        pass

                    if self._pcap:
                        try:
                            self._pcap.write_tx(pkt, dest[0], dest[1])
                        except Exception:
                            pass

                    seq = (seq + 1) & 0xFFFF
                    ts  = (ts + self._ts_inc) & 0xFFFFFFFF

        except asyncio.CancelledError:
            log.debug("RtpEndpoint: UAS cancelled — tx=%d rx=%d markers_sent=%d -> %s:%d",
                      self._tx_pkts, self._protocol.packets_received,
                      self._markers_sent, remote_ip, remote_port)

    # ------------------------------------------------------------------
    # Burst sender (shared by both modes)
    # ------------------------------------------------------------------

    async def _send_burst(
        self,
        dest: Tuple[str, int],
        ssrc: int,
        seq: int,
        ts: int,
        deadline: float,
        pps: int,
        loop: asyncio.AbstractEventLoop,
    ) -> Tuple[int, int]:
        """Send at `pps` packets/sec until `deadline`. Drift-correcting pacing."""
        interval = 1.0 / pps
        next_send = loop.time()
        pcap = self._pcap

        while loop.time() < deadline:
            payload = self._get_payload()
            pkt = _pack_rtp(seq, ts, ssrc, payload)
            try:
                self._transport.sendto(pkt, dest)
            except Exception as exc:
                log.debug("RtpEndpoint: burst sendto error: %s — stopping burst", exc)
                remaining = deadline - loop.time()
                if remaining > 0:
                    await asyncio.sleep(remaining)
                break

            if pcap:
                try:
                    pcap.write_tx(pkt, dest[0], dest[1])
                except Exception:
                    pass

            seq = (seq + 1) & 0xFFFF
            ts  = (ts + self._ts_inc) & 0xFFFFFFFF

            next_send += interval
            sleep_for = next_send - loop.time()
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

        return seq, ts

    # ------------------------------------------------------------------

    async def close(self) -> None:
        """Close the underlying UDP socket and pcap file.  Safe to call multiple times."""
        if not self._closed:
            self._closed = True
            try:
                self._transport.close()
            except Exception:
                pass
            if self._pcap:
                self._pcap.close()
                log.info(
                    "RtpEndpoint: pcap saved -> %s (%d packets)",
                    self._pcap.path, self._pcap.packet_count,
                )
                self._pcap = None


# ---------------------------------------------------------------------------
# Backward-compatible aliases
# ---------------------------------------------------------------------------

RtpStream = RtpEndpoint
RtpAbsorber = RtpEndpoint
