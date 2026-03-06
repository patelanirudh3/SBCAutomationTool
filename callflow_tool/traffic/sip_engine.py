"""
traffic/sip_engine.py
=====================
Async SIP transport layer (replaces the blocking transport.py + listenthread.py
+ messagebuffer.py for the traffic path).

The existing transport.py is NOT modified — it remains in use by the Flask
orchestrator. This module is the traffic-path-only replacement.

Transport hierarchy:
  AsyncSipTransport   (Protocol / abstract interface)
  ├── UdpSipTransport (asyncio.DatagramProtocol — one socket per extension)
  └── TcpSipTransport (asyncio.StreamReader/Writer — persistent TCP/TLS conn)

Message framing for TCP reuses the same CRLF+CRLF + Content-Length logic
that was in messagebuffer.py lines 101-120, ported to async StreamReader.
"""

from __future__ import annotations

import asyncio
import logging
import ssl
import socket
import time
from abc import ABC, abstractmethod
from typing import Callable, Optional

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants (matches sipconstants.py to avoid import dependency)
# ---------------------------------------------------------------------------
CRLF = "\r\n"
CRLFCRLF = "\r\n\r\n"
CONTENT_LENGTH_HEADER = "Content-Length"
RECV_BUFFER = 65536


# ---------------------------------------------------------------------------
# Abstract interface
# ---------------------------------------------------------------------------

class AsyncSipTransport(ABC):
    """
    Abstract base for all SIP transports in the traffic engine.
    One instance per extension — the socket/connection lives for the entire
    test run, not per-call.
    """

    @abstractmethod
    async def connect(self) -> None:
        """Establish the underlying connection / bind the socket."""

    @abstractmethod
    async def send(self, message: str) -> None:
        """Send a raw SIP message string."""

    @property
    @abstractmethod
    def recv_queue(self) -> asyncio.Queue:
        """Asyncio queue producing raw SIP message strings as they arrive."""

    @abstractmethod
    async def close(self) -> None:
        """Gracefully close the transport."""

    @property
    @abstractmethod
    def local_port(self) -> int:
        """The bound local port (OS-assigned when port=0)."""


# ---------------------------------------------------------------------------
# UDP Transport
# ---------------------------------------------------------------------------

class _UdpProtocol(asyncio.DatagramProtocol):
    """
    asyncio DatagramProtocol implementation.
    Each received datagram = one SIP message (RFC 3261 §18.1).
    """

    def __init__(self, queue: asyncio.Queue) -> None:
        self._queue = queue
        self._transport: Optional[asyncio.DatagramTransport] = None

    def connection_made(self, transport: asyncio.DatagramTransport) -> None:  # type: ignore[override]
        self._transport = transport

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        try:
            message = data.decode("utf-8", errors="replace")
            self._queue.put_nowait(message)
        except Exception:
            log.exception("UDP datagram_received decode error from %s", addr)

    def error_received(self, exc: Exception) -> None:
        log.warning("UDP error received: %s", exc)

    def connection_lost(self, exc: Optional[Exception]) -> None:
        if exc:
            log.warning("UDP connection lost: %s", exc)


class UdpSipTransport(AsyncSipTransport):
    """
    UDP SIP transport.
    One UDP socket per extension, bound to (local_host, 0) for OS-assigned port.
    """

    def __init__(
        self,
        local_host: str,
        remote_host: str,
        remote_port: int,
    ) -> None:
        self._local_host = local_host
        self._remote_host = remote_host
        self._remote_port = remote_port
        self._queue: asyncio.Queue = asyncio.Queue()
        self._transport: Optional[asyncio.DatagramTransport] = None
        self._protocol: Optional[_UdpProtocol] = None
        self._local_port: int = 0

    async def connect(self) -> None:
        loop = asyncio.get_event_loop()
        self._transport, self._protocol = await loop.create_datagram_endpoint(
            lambda: _UdpProtocol(self._queue),
            local_addr=(self._local_host, 0),
            remote_addr=(self._remote_host, self._remote_port),
        )
        sock = self._transport.get_extra_info("socket")
        self._local_port = sock.getsockname()[1]
        log.debug(
            "UDP socket bound to %s:%d → %s:%d",
            self._local_host, self._local_port,
            self._remote_host, self._remote_port,
        )

    async def send(self, message: str) -> None:
        if self._transport is None or self._transport.is_closing():
            raise RuntimeError("UDP transport not connected")
        self._transport.sendto(message.encode("utf-8"))

    @property
    def recv_queue(self) -> asyncio.Queue:
        return self._queue

    async def close(self) -> None:
        if self._transport and not self._transport.is_closing():
            self._transport.close()
        log.debug("UDP transport closed (port %d)", self._local_port)

    @property
    def local_port(self) -> int:
        return self._local_port


# ---------------------------------------------------------------------------
# TCP / TLS Transport
# ---------------------------------------------------------------------------

class TcpSipTransport(AsyncSipTransport):
    """
    TCP (or TLS) SIP transport with:
    - Persistent connection per extension (not per-call)
    - Content-Length framing ported from messagebuffer.py lines 101-120
    - Automatic reconnect with exponential backoff on connection drop
    - TLS support via asyncio ssl.SSLContext
    """

    _MAX_BACKOFF = 30.0   # seconds
    _INITIAL_BACKOFF = 0.5

    def __init__(
        self,
        local_host: str,
        remote_host: str,
        remote_port: int,
        use_tls: bool = False,
        ssl_context: Optional[ssl.SSLContext] = None,
    ) -> None:
        self._local_host = local_host
        self._remote_host = remote_host
        self._remote_port = remote_port
        self._use_tls = use_tls
        self._ssl_context = ssl_context or self._default_ssl_ctx() if use_tls else None
        self._queue: asyncio.Queue = asyncio.Queue()
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._local_port: int = 0
        self._closed = False
        self._recv_task: Optional[asyncio.Task] = None

    @staticmethod
    def _default_ssl_ctx() -> ssl.SSLContext:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx

    async def connect(self) -> None:
        await self._do_connect()
        self._recv_task = asyncio.create_task(
            self._recv_loop(), name=f"tcp-recv-{self._local_port}"
        )

    async def _do_connect(self) -> None:
        backoff = self._INITIAL_BACKOFF
        while True:
            try:
                self._reader, self._writer = await asyncio.open_connection(
                    self._remote_host,
                    self._remote_port,
                    ssl=self._ssl_context,
                    local_addr=(self._local_host, 0),
                )
                sock = self._writer.get_extra_info("socket")
                if sock:
                    self._local_port = sock.getsockname()[1]
                log.debug(
                    "TCP%s connected %s:%d → %s:%d",
                    "/TLS" if self._use_tls else "",
                    self._local_host, self._local_port,
                    self._remote_host, self._remote_port,
                )
                return
            except (ConnectionRefusedError, OSError) as exc:
                if self._closed:
                    return
                log.warning(
                    "TCP connect to %s:%d failed (%s), retry in %.1fs",
                    self._remote_host, self._remote_port, exc, backoff,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, self._MAX_BACKOFF)

    async def send(self, message: str) -> None:
        if self._writer is None or self._writer.is_closing():
            raise RuntimeError("TCP transport not connected")
        self._writer.write(message.encode("utf-8"))
        await self._writer.drain()

    @property
    def recv_queue(self) -> asyncio.Queue:
        return self._queue

    async def close(self) -> None:
        self._closed = True
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
        if self._writer and not self._writer.is_closing():
            self._writer.close()
            try:
                await self._writer.wait_closed()
            except Exception:
                pass
        log.debug("TCP transport closed (port %d)", self._local_port)

    @property
    def local_port(self) -> int:
        return self._local_port

    # ------------------------------------------------------------------
    # Receive loop — Content-Length framing from messagebuffer.py logic
    # ------------------------------------------------------------------

    async def _recv_loop(self) -> None:
        """
        Continuously read bytes from the TCP stream and produce complete SIP
        messages onto self._queue.

        Framing algorithm (RFC 3261 §20.14 / messagebuffer.py lines 101-120):
          1. Read until CRLFCRLF to get the header block
          2. Parse Content-Length from the headers
          3. Read exactly Content-Length more bytes for the body
          4. Yield the complete message
        """
        buffer = b""
        while not self._closed:
            try:
                chunk = await self._reader.read(RECV_BUFFER)
                if not chunk:
                    # Remote closed the connection
                    log.info(
                        "TCP connection closed by remote (%s:%d), reconnecting…",
                        self._remote_host, self._remote_port,
                    )
                    if not self._closed:
                        await self._reconnect()
                    return

                buffer += chunk

                # Extract as many complete SIP messages as possible
                while True:
                    msg = self._extract_message(buffer)
                    if msg is None:
                        break
                    complete_msg, consumed = msg
                    buffer = buffer[consumed:]
                    await self._queue.put(complete_msg.decode("utf-8", errors="replace"))

            except asyncio.CancelledError:
                return
            except Exception as exc:
                if self._closed:
                    return
                log.warning("TCP recv error: %s, reconnecting…", exc)
                await self._reconnect()
                buffer = b""
                return

    def _extract_message(self, buf: bytes) -> Optional[tuple[bytes, int]]:
        """
        Try to extract one complete SIP message from buf.
        Returns (message_bytes, bytes_consumed) or None if not enough data.
        Mirrors messagebuffer.py Content-Length parsing.
        """
        separator = b"\r\n\r\n"
        sep_idx = buf.find(separator)
        if sep_idx == -1:
            return None

        header_block = buf[: sep_idx + len(separator)]
        headers_text = header_block.decode("utf-8", errors="replace")

        # Find Content-Length
        content_length = 0
        for line in headers_text.splitlines():
            if line.lower().startswith("content-length"):
                try:
                    content_length = int(line.split(":", 1)[1].strip())
                except (IndexError, ValueError):
                    content_length = 0
                break

        total_needed = sep_idx + len(separator) + content_length
        if len(buf) < total_needed:
            return None

        message = buf[:total_needed]
        return message, total_needed

    async def _reconnect(self) -> None:
        if self._closed:
            return
        if self._writer and not self._writer.is_closing():
            self._writer.close()
        self._reader = None
        self._writer = None
        await self._do_connect()
        # Restart receive loop
        self._recv_task = asyncio.create_task(
            self._recv_loop(), name=f"tcp-recv-{self._local_port}"
        )


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def create_transport(
    transport_type: str,
    local_host: str,
    remote_host: str,
    remote_port: int,
    ssl_context: Optional[ssl.SSLContext] = None,
) -> AsyncSipTransport:
    """
    Create the appropriate AsyncSipTransport for the given transport type.

    Args:
        transport_type: "TCP", "TLS", or "UDP"
        local_host:     Local IP to bind to
        remote_host:    SBC / proxy IP
        remote_port:    SBC / proxy SIP port
        ssl_context:    Optional custom SSLContext for TLS

    Returns:
        An unconnected AsyncSipTransport instance.
        Call await transport.connect() before use.
    """
    t = transport_type.upper()
    if t == "UDP":
        return UdpSipTransport(local_host, remote_host, remote_port)
    elif t == "TCP":
        return TcpSipTransport(local_host, remote_host, remote_port, use_tls=False)
    elif t == "TLS":
        return TcpSipTransport(
            local_host, remote_host, remote_port,
            use_tls=True, ssl_context=ssl_context,
        )
    else:
        raise ValueError(f"Unknown SIP transport type: {transport_type!r}")


# ---------------------------------------------------------------------------
# SIP message event classification
# Ported from messagebuffer.py::getMessageEvtAndMessage()
# ---------------------------------------------------------------------------

def classify_message(raw: str) -> tuple[str, str]:
    """
    Return (event_code, raw_message) where event_code is the SIP method
    (for requests) or response code (for responses).

    Examples:
      "INVITE sip:..." → ("INVITE", raw)
      "SIP/2.0 200 OK" → ("200", raw)
      "SIP/2.0 401 ..."→ ("401", raw)
    """
    first_line = raw.split(CRLF, 1)[0].strip()

    if first_line.startswith("SIP/2.0"):
        parts = first_line.split(" ", 2)
        code = parts[1] if len(parts) > 1 else "UNKNOWN"
        return code, raw
    else:
        method = first_line.split(" ", 1)[0].strip()
        return method, raw
