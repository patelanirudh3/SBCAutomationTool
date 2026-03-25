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

    def connection_made(self, transport) -> None:
        self._transport = transport

    def set_expected_src(self, ip: str, port: int) -> None:
        self._expected_src = (ip, port)

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if len(data) < 12:
            return

        if (data[0] >> 6) != 2:
            return

        # RTCP filter: PT byte in RTP/RTCP is byte[1] & 0x7F
        pt = data[1] & 0x7F
        if pt >= 200:
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

        # Marker detection: check for magic bytes in payload (after 12-byte RTP header)
        if len(data) >= 16 and data[12:16] == _MARKER_MAGIC:
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
    """

    __slots__ = ("_transport", "_protocol", "_local_port", "_closed", "_tx_pkts",
                 "_markers_sent", "_remote_ip", "_remote_port",
                 "_ts_inc", "_tone_payload", "_marker_template")

    def __init__(
        self,
        transport: asyncio.DatagramTransport,
        protocol: _CountingProtocol,
        local_port: int,
        ptime_ms: int = 20,
    ) -> None:
        self._transport = transport
        self._protocol  = protocol
        self._local_port = local_port
        self._closed    = False
        self._tx_pkts   = 0
        self._markers_sent = 0
        self._remote_ip: str = ""
        self._remote_port: int = 0

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
        return cls(transport, protocol, port, ptime_ms)

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

            seq = (seq + 1) & 0xFFFF
            ts  = (ts + self._ts_inc) & 0xFFFFFFFF

            next_send += interval
            sleep_for = next_send - loop.time()
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

        return seq, ts

    # ------------------------------------------------------------------

    async def close(self) -> None:
        """Close the underlying UDP socket.  Safe to call multiple times."""
        if not self._closed:
            self._closed = True
            try:
                self._transport.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Backward-compatible aliases
# ---------------------------------------------------------------------------

RtpStream = RtpEndpoint
RtpAbsorber = RtpEndpoint
