"""
traffic/rtp_stream.py
=====================
Unified asyncio RTP endpoint for bidirectional media-plane load testing.

RFC 3550 RTP + G.711 MU-law (PCMU, PT=0) — matches CM Codec Set:
  - 8 000 Hz sample rate
  - 20 ms ptime  ->  160 bytes payload  ->  50 pps at full rate
  - Silence payload: 0x7F x 160  (MU-law +0 dBm0, ITU-T G.711)
  - No silence suppression (matches CM "Silence Suppression: n")

3-Phase send pattern (per call, per direction):
  BURST_START  : rtp_burst_pps for rtp_burst_seconds  (establish media path)
  KEEPALIVE    : 1 pkt / rtp_keepalive_interval       (prevent SBC timeout)
  BURST_END    : rtp_burst_pps for rtp_burst_seconds  (verify path before BYE)

Both UAC and UAS use the same RtpEndpoint class — one UDP socket per call leg
that sends (3-phase) and receives (counting protocol).

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
import random
import struct
import time
from dataclasses import dataclass
from typing import Optional, Tuple

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RTP / codec constants (G.711 MU-law, 20 ms ptime, CM-aligned)
# ---------------------------------------------------------------------------

_PT_PCMU      = 0           # G.711 MU-law payload type (RFC 3551)
_PTIME_SEC    = 0.020       # 20 ms per packet
_TS_INC       = 160         # timestamp increment per packet (8000 Hz x 20 ms)
_PCMU_SILENCE = bytes([0x7F] * 160)  # MU-law silence (positive zero, 160 bytes)


# ---------------------------------------------------------------------------
# RTP packet builder  (12-byte header + 160-byte payload = 172 bytes total)
# ---------------------------------------------------------------------------

def _pack_rtp(seq: int, ts: int, ssrc: int) -> bytes:
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
        0x80,                    # V=2, P=0, X=0, CC=0
        _PT_PCMU,                # M=0, PT=0
        seq  & 0xFFFF,
        ts   & 0xFFFFFFFF,
        ssrc & 0xFFFFFFFF,
    ) + _PCMU_SILENCE


# ---------------------------------------------------------------------------
# RTP stats dataclass
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RtpStats:
    """Immutable snapshot of an RtpEndpoint's receive counters (three-tier classification)."""
    rtp_rx_pkts: int            # all valid RTP received (primary, unchanged semantics)
    rtp_rx_from_sbc: int        # valid RTP from expected SBC relay address
    rtp_rx_other: int           # valid RTP from other sources (probes, etc.)
    first_rx_ms: float | None
    last_rx_ms: float | None


# ---------------------------------------------------------------------------
# Counting DatagramProtocol — three-tier RTP receive counter
# ---------------------------------------------------------------------------

class _CountingProtocol(asyncio.DatagramProtocol):
    """
    Counts incoming UDP datagrams with three-tier classification:
    - packets_received: ALL valid RTP (version=2, len>=12) — primary counter, unchanged semantics
    - pkts_from_expected_src: valid RTP from the known SBC relay address only
    - pkts_from_other_src: valid RTP from any other source (SBC probes, RTCP-over-RTP, etc.)

    Non-RTP packets (version != 2 or len < 12) are silently ignored and not counted in any bucket.
    This prevents SBC keep-alive probes and RTCP packets from appearing as RTP traffic.
    """
    def __init__(self):
        self.packets_received: int = 0
        self.pkts_from_expected_src: int = 0
        self.pkts_from_other_src: int = 0
        self.first_recv_ts: float | None = None
        self.last_recv_ts: float | None = None
        self._expected_src: tuple[str, int] | None = None
        self._transport = None

    def connection_made(self, transport) -> None:
        self._transport = transport

    def set_expected_src(self, ip: str, port: int) -> None:
        """
        Register the SBC RTP relay address after SDP negotiation.
        Until called, all valid RTP is counted in packets_received but
        pkts_from_expected_src remains 0 (pre-answer phase packets are
        attributed to pkts_from_other_src).
        """
        self._expected_src = (ip, port)

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        if len(data) < 12:
            return

        if (data[0] >> 6) != 2:
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

    def error_received(self, exc: Exception) -> None:
        log.debug("RTP socket error: %s", exc)

    def connection_lost(self, exc) -> None:
        pass


# ---------------------------------------------------------------------------
# RtpEndpoint — unified bidirectional endpoint (replaces RtpStream + RtpAbsorber)
# ---------------------------------------------------------------------------

class RtpEndpoint:
    """
    Bidirectional G.711 PCMU RTP endpoint — used by both UAC and UAS.

    Binds one OS-assigned UDP port (advertised in SDP).  Sends using the
    3-phase heartbeat pattern and receives via _CountingProtocol.

    Usage (one instance per active call leg):
        ep = await RtpEndpoint.create(local_ip)
        # advertise ep.local_port in SDP m=audio line
        await ep.run(remote_ip, remote_port, hold_seconds, burst_sec, burst_pps, ka_interval)
        stats = ep.stats
        await ep.close()
    """

    __slots__ = ("_transport", "_protocol", "_local_port", "_closed", "_tx_pkts",
                 "_remote_ip", "_remote_port")

    def __init__(
        self,
        transport: asyncio.DatagramTransport,
        protocol: _CountingProtocol,
        local_port: int,
    ) -> None:
        self._transport = transport
        self._protocol  = protocol
        self._local_port = local_port
        self._closed    = False
        self._tx_pkts   = 0
        self._remote_ip: str = ""
        self._remote_port: int = 0

    # ------------------------------------------------------------------

    @classmethod
    async def create(cls, local_ip: str) -> "RtpEndpoint":
        """
        Bind a UDP socket on an OS-assigned ephemeral port.
        Raises OSError if the bind fails (caller logs and falls back).
        """
        loop = asyncio.get_running_loop()
        transport, protocol = await loop.create_datagram_endpoint(
            _CountingProtocol,
            local_addr=(local_ip, 0),
        )
        sock = transport.get_extra_info("socket")
        port = sock.getsockname()[1]
        log.debug("RtpEndpoint: bound %s:%d", local_ip, port)
        return cls(transport, protocol, port)

    # ------------------------------------------------------------------

    @property
    def local_port(self) -> int:
        return self._local_port

    @property
    def tx_pkts(self) -> int:
        """Total RTP packets sent by this endpoint."""
        return self._tx_pkts

    def set_remote_rtp_addr(self, ip: str, port: int) -> None:
        """
        Called by CallEngine after parsing 200 OK SDP answer (UAC) or INVITE SDP (UAS).
        Registers the SBC relay address with the counting protocol so it can
        distinguish SBC media traffic from SBC probes/RTCP.
        Safe to call before or after run() — protocol is updated immediately if running.
        """
        self._remote_ip = ip
        self._remote_port = port
        if self._protocol is not None:
            self._protocol.set_expected_src(ip, port)

    @property
    def stats(self) -> RtpStats:
        """Snapshot of receive counters (three-tier).  Safe to read after run() completes."""
        if self._protocol is None:
            return RtpStats(0, 0, 0, None, None)
        return RtpStats(
            rtp_rx_pkts=self._protocol.packets_received,
            rtp_rx_from_sbc=self._protocol.pkts_from_expected_src,
            rtp_rx_other=self._protocol.pkts_from_other_src,
            first_rx_ms=self._protocol.first_recv_ts,
            last_rx_ms=self._protocol.last_recv_ts,
        )

    # ------------------------------------------------------------------

    async def run(
        self,
        remote_ip: str,
        remote_port: int,
        duration_seconds: float,
        burst_seconds: float = 2.0,
        burst_pps: int = 50,
        keepalive_interval: float = 5.0,
    ) -> None:
        """
        3-phase send loop:
          BURST_START  -> burst_pps for burst_seconds
          KEEPALIVE    -> 1 pkt / keepalive_interval
          BURST_END    -> burst_pps for burst_seconds

        Falls back to asyncio.sleep when remote endpoint is invalid (port 0/9).
        Handles CancelledError cleanly — re-raises for task infrastructure.
        """
        if not remote_ip or remote_port <= 0 or remote_port == 9:
            log.debug(
                "RtpEndpoint: remote %s:%d — discard/invalid, sleeping %.1fs",
                remote_ip, remote_port, duration_seconds,
            )
            await asyncio.sleep(duration_seconds)
            return

        loop = asyncio.get_running_loop()
        ssrc = random.randint(1, 0xFFFFFFFF)
        seq  = random.randint(0, 0xFFFF)
        ts   = random.randint(0, 0xFFFFFFFF)
        dest = (remote_ip, remote_port)

        call_deadline = loop.time() + duration_seconds
        burst_end_start = call_deadline - burst_seconds

        try:
            # ── Phase 1: BURST_START ──────────────────────────────────
            seq, ts = await self._send_burst(
                dest, ssrc, seq, ts,
                min(loop.time() + burst_seconds, call_deadline),
                burst_pps, loop,
            )

            # ── Phase 2: KEEPALIVE ────────────────────────────────────
            while loop.time() < burst_end_start:
                remaining = burst_end_start - loop.time()
                sleep_for = min(keepalive_interval, remaining)
                if sleep_for <= 0:
                    break
                await asyncio.sleep(sleep_for)

                if loop.time() >= call_deadline:
                    break

                pkt = _pack_rtp(seq, ts, ssrc)
                try:
                    self._transport.sendto(pkt, dest)
                    self._tx_pkts += 1
                except Exception as exc:
                    log.debug("RtpEndpoint: keepalive sendto error: %s", exc)
                    break

                seq = (seq + 1) & 0xFFFF
                ts  = (ts + _TS_INC) & 0xFFFFFFFF

            # ── Phase 3: BURST_END ────────────────────────────────────
            if loop.time() < call_deadline:
                seq, ts = await self._send_burst(
                    dest, ssrc, seq, ts,
                    call_deadline,
                    burst_pps, loop,
                )

        except asyncio.CancelledError:
            log.debug(
                "RtpEndpoint: cancelled after %d tx / %d rx -> %s:%d",
                self._tx_pkts, self._protocol.packets_received,
                remote_ip, remote_port,
            )
            raise

        log.debug(
            "RtpEndpoint: done — tx=%d rx=%d -> %s:%d (%.1fs)",
            self._tx_pkts, self._protocol.packets_received,
            remote_ip, remote_port, duration_seconds,
        )

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
        """
        Send at `pps` packets/sec until `deadline`.
        Returns updated (seq, ts).  Drift-correcting pacing.
        """
        interval = 1.0 / pps
        next_send = loop.time()

        while loop.time() < deadline:
            pkt = _pack_rtp(seq, ts, ssrc)
            try:
                self._transport.sendto(pkt, dest)
                self._tx_pkts += 1
            except Exception as exc:
                log.debug("RtpEndpoint: burst sendto error: %s — stopping burst", exc)
                remaining = deadline - loop.time()
                if remaining > 0:
                    await asyncio.sleep(remaining)
                break

            seq = (seq + 1) & 0xFFFF
            ts  = (ts + _TS_INC) & 0xFFFFFFFF

            next_send += interval
            sleep_for = next_send - loop.time()
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

        return seq, ts

    # ------------------------------------------------------------------

    async def run_until_cancelled(
        self,
        remote_ip: str,
        remote_port: int,
        burst_seconds: float = 2.0,
        burst_pps: int = 50,
        keepalive_interval: float = 5.0,
    ) -> None:
        """
        UAS variant: runs indefinitely until externally cancelled.
        Sends BURST_START, then KEEPALIVE forever.  No BURST_END (BYE
        cancels the task, which is the signal to stop).

        On cancellation the caller reads .stats for verification.
        """
        if not remote_ip or remote_port <= 0 or remote_port == 9:
            log.debug(
                "RtpEndpoint: remote %s:%d — discard/invalid, waiting for cancel",
                remote_ip, remote_port,
            )
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
            # ── BURST_START ───────────────────────────────────────────
            burst_deadline = loop.time() + burst_seconds
            seq, ts = await self._send_burst(
                dest, ssrc, seq, ts,
                burst_deadline, burst_pps, loop,
            )

            # ── KEEPALIVE (forever until cancelled) ───────────────────
            while True:
                await asyncio.sleep(keepalive_interval)

                pkt = _pack_rtp(seq, ts, ssrc)
                try:
                    self._transport.sendto(pkt, dest)
                    self._tx_pkts += 1
                except Exception:
                    pass

                seq = (seq + 1) & 0xFFFF
                ts  = (ts + _TS_INC) & 0xFFFFFFFF

        except asyncio.CancelledError:
            log.debug(
                "RtpEndpoint: UAS cancelled — tx=%d rx=%d -> %s:%d",
                self._tx_pkts, self._protocol.packets_received,
                remote_ip, remote_port,
            )

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
# Backward-compatible aliases (import sites that haven't migrated)
# ---------------------------------------------------------------------------

RtpStream = RtpEndpoint
RtpAbsorber = RtpEndpoint
