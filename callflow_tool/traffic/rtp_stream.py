"""
traffic/rtp_stream.py
=====================
Lightweight asyncio RTP sender (UAC) and absorber (UAS) for media-plane
load testing.

RFC 3550 RTP + G.711 MU-law (PCMU, PT=0) — matches CM Codec Set:
  - 8 000 Hz sample rate
  - 20 ms ptime  →  160 bytes payload  →  50 pps per call
  - Silence payload: 0x7F × 160  (MU-law +0 dBm0, ITU-T G.711)
  - No silence suppression (matches CM "Silence Suppression: n")

UAC side → RtpStream.create(local_ip)
              stream.run(remote_ip, remote_port, hold_seconds)
              stream.close()

UAS side → RtpAbsorber.create(local_ip)
              absorber.run()   ← cancel on BYE
              absorber.close()

Both classes bind a real OS UDP port so it can be advertised in SDP.
If the negotiated remote_port is 0 or 9 (RFC 4566 discard), RtpStream
falls back to asyncio.sleep so hold_time is still honoured cleanly.

Corner cases handled:
  - CancelledError (SIGTERM / early BYE)  → packet loop exits, re-raises
  - sendto errors                         → loop breaks, no crash
  - remote_port 0 / 9                     → sleep fallback
  - close() called multiple times         → idempotent
  - N concurrent calls                    → each gets a distinct OS port
"""

from __future__ import annotations

import asyncio
import logging
import random
import struct
from typing import Optional, Tuple

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RTP / codec constants (G.711 MU-law, 20 ms ptime, CM-aligned)
# ---------------------------------------------------------------------------

_PT_PCMU      = 0           # G.711 MU-law payload type (RFC 3551)
_PTIME        = 0.020       # 20 ms per packet
_TS_INC       = 160         # timestamp increment per packet (8000 Hz × 20 ms)
_PCMU_SILENCE = bytes([0x7F] * 160)  # MU-law silence (positive zero, 160 bytes)


# ---------------------------------------------------------------------------
# RTP packet builder  (12-byte header + 160-byte payload = 172 bytes total)
# ---------------------------------------------------------------------------

def _pack_rtp(seq: int, ts: int, ssrc: int) -> bytes:
    """
    Build a minimal RFC 3550 RTP packet.
      Byte 1 : V=2  P=0  X=0  CC=0   → 0x80
      Byte 2 : M=0  PT=0 (PCMU)      → 0x00
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
# Shared asyncio DatagramProtocol: silently absorbs all inbound datagrams
# ---------------------------------------------------------------------------

class _NullProtocol(asyncio.DatagramProtocol):
    """No-op protocol — all datagrams are silently discarded."""
    def datagram_received(self, data: bytes, addr: Tuple) -> None: pass
    def error_received(self, exc: Exception)               -> None: pass
    def connection_lost(self, exc: Optional[Exception])    -> None: pass


# ---------------------------------------------------------------------------
# RtpStream — UAC sender
# ---------------------------------------------------------------------------

class RtpStream:
    """
    UAC-side G.711 PCMU RTP sender.

    Usage (one instance per active call leg):
        stream = await RtpStream.create(local_ip)
        # advertise stream.local_port in SDP m=audio line
        await stream.run(remote_ip, remote_port, hold_seconds)
        await stream.close()          # always call; idempotent
    """

    __slots__ = ("_transport", "_local_port", "_closed")

    def __init__(
        self,
        transport: asyncio.DatagramTransport,
        local_port: int,
    ) -> None:
        self._transport  = transport
        self._local_port = local_port
        self._closed     = False

    # ------------------------------------------------------------------

    @classmethod
    async def create(cls, local_ip: str) -> "RtpStream":
        """
        Bind a UDP socket on an OS-assigned ephemeral port.
        Raises OSError if the bind fails (caller logs and falls back).
        """
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            _NullProtocol,
            local_addr=(local_ip, 0),   # port=0 → OS assigns
        )
        sock = transport.get_extra_info("socket")
        port = sock.getsockname()[1]
        log.debug("RtpStream: bound %s:%d", local_ip, port)
        return cls(transport, port)

    # ------------------------------------------------------------------

    @property
    def local_port(self) -> int:
        return self._local_port

    # ------------------------------------------------------------------

    async def run(
        self,
        remote_ip: str,
        remote_port: int,
        duration_seconds: float,
    ) -> None:
        """
        Send G.711 PCMU silence to (remote_ip, remote_port) for
        duration_seconds at 50 pps (one 172-byte RTP packet every 20 ms).

        Timing: deadline-based pacing compensates for per-iteration overhead
        so the overall send rate stays close to 50 pps even under load.

        Falls back to asyncio.sleep (no packets sent) when:
          - remote_port is 0 (media declined by remote)
          - remote_port is 9 (RFC 4566 discard / black-hole)
          - remote_ip is empty

        Handles asyncio.CancelledError cleanly: exits the loop, re-raises
        so the caller's task infrastructure sees the cancellation.
        """
        if not remote_ip or remote_port <= 0 or remote_port == 9:
            log.debug(
                "RtpStream: remote %s:%d — discard/invalid, sleeping %.1fs",
                remote_ip, remote_port, duration_seconds,
            )
            await asyncio.sleep(duration_seconds)
            return

        loop      = asyncio.get_running_loop()
        ssrc      = random.randint(1, 0xFFFFFFFF)
        seq       = random.randint(0, 0xFFFF)
        ts        = random.randint(0, 0xFFFFFFFF)
        deadline  = loop.time() + duration_seconds
        next_send = loop.time()
        sent      = 0

        try:
            while True:
                if loop.time() >= deadline:
                    break

                pkt = _pack_rtp(seq, ts, ssrc)
                try:
                    self._transport.sendto(pkt, (remote_ip, remote_port))
                    sent += 1
                except Exception as exc:
                    log.debug("RtpStream: sendto error: %s — stopping", exc)
                    # Socket may have closed; sleep out the remainder
                    remaining = deadline - loop.time()
                    if remaining > 0:
                        await asyncio.sleep(remaining)
                    break

                seq       = (seq + 1) & 0xFFFF
                ts        = (ts  + _TS_INC) & 0xFFFFFFFF

                # Drift-correcting sleep: target is fixed 20 ms grid
                next_send += _PTIME
                sleep_for  = next_send - loop.time()
                if sleep_for > 0:
                    await asyncio.sleep(sleep_for)

        except asyncio.CancelledError:
            log.debug(
                "RtpStream: cancelled after %d packets → %s:%d",
                sent, remote_ip, remote_port,
            )
            raise  # propagate so task infrastructure handles it correctly

        log.debug(
            "RtpStream: done — %d packets sent → %s:%d (%.1fs)",
            sent, remote_ip, remote_port, duration_seconds,
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
# RtpAbsorber — UAS receiver (minimal: bind a real port, discard packets)
# ---------------------------------------------------------------------------

class RtpAbsorber:
    """
    UAS-side RTP absorber (Phase 2 minimal).

    Binds a real UDP port so the SBC/CM can send media to a valid endpoint.
    All incoming datagrams are silently discarded by _NullProtocol.
    No statistics or RTCP are generated.

    Usage (one instance per active call leg):
        absorber = await RtpAbsorber.create(local_ip)
        # advertise absorber.local_port in 200 OK SDP m=audio line
        task = asyncio.create_task(absorber.run())
        # on BYE received:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await absorber.close()        # always call; idempotent
    """

    __slots__ = ("_transport", "_local_port", "_closed")

    def __init__(
        self,
        transport: asyncio.DatagramTransport,
        local_port: int,
    ) -> None:
        self._transport  = transport
        self._local_port = local_port
        self._closed     = False

    # ------------------------------------------------------------------

    @classmethod
    async def create(cls, local_ip: str) -> "RtpAbsorber":
        """
        Bind a UDP socket on an OS-assigned ephemeral port.
        Raises OSError if the bind fails (caller logs and falls back).
        """
        loop = asyncio.get_running_loop()
        transport, _ = await loop.create_datagram_endpoint(
            _NullProtocol,
            local_addr=(local_ip, 0),
        )
        sock = transport.get_extra_info("socket")
        port = sock.getsockname()[1]
        log.debug("RtpAbsorber: bound %s:%d", local_ip, port)
        return cls(transport, port)

    # ------------------------------------------------------------------

    @property
    def local_port(self) -> int:
        return self._local_port

    # ------------------------------------------------------------------

    async def run(self) -> None:
        """
        Keep the absorber alive until cancelled.
        _NullProtocol.datagram_received() handles all incoming packets
        (no-op); this coroutine exists purely so the caller can cancel it
        when the call ends (BYE received).
        """
        try:
            while True:
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------

    async def close(self) -> None:
        """Close the underlying UDP socket.  Safe to call multiple times."""
        if not self._closed:
            self._closed = True
            try:
                self._transport.close()
            except Exception:
                pass
