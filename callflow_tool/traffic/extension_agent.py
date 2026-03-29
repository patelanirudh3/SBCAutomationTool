"""
traffic/extension_agent.py
===========================
ExtensionAgent — one instance per SIP extension number.

Each agent owns exactly ONE persistent socket (via AsyncSipTransport) that
lives for the entire test run. All SIP dialogs for that extension share the
same socket / connection. This mirrors the existing useragent.py pattern
where SignalingSocket is created once and reused.

SIP message building/parsing is 100% delegated to the existing modules:
  sipmessage.py, parserandbuilder.py, authenticate.py, util.py,
  invite.py, bye.py, prack.py, register.py, subscribe.py

ExtensionAgent does NOT use UASession — it uses the lighter DialogState
dataclass defined here, purpose-built for the traffic path.
"""

from __future__ import annotations

import asyncio
import logging
import sys
import os
import time
from dataclasses import dataclass, field
from typing import Any, Optional

# ---------------------------------------------------------------------------
# Path setup — make existing linoxiderepo modules importable
# ---------------------------------------------------------------------------
_REPO = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "useragent", "json", "linoxiderepo")
)
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)

# Existing (keep, do not modify) modules
from sipmessage import SipMessage  # noqa: E402
from sipconstants import SipHeaders, CRLF, SipCallState  # noqa: E402
from parserandbuilder import parseHeaders, parseContent, buildMessage  # noqa: E402
from authenticate import calcDigestResp, recv407ProxyAuth, recv401Unauthorised  # noqa: E402
import util as _util  # noqa: E402
import register as _register  # noqa: E402
import invite as _invite  # noqa: E402
import bye as _bye  # noqa: E402
import prack as _prack  # noqa: E402
import subscribe as _subscribe  # noqa: E402

from .sip_engine import AsyncSipTransport, create_transport, classify_message
from .config import VMConfig

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Lightweight SIP header extractors used by zombie / 481 handler.
# These are intentionally simple string-scan helpers — fast and dependency-free.
# ---------------------------------------------------------------------------

def _extract_call_id(raw: str) -> str:
    """Return the Call-ID value from a raw SIP message without full parsing."""
    for line in raw.split(CRLF):
        lower = line.lower()
        if lower.startswith("call-id:") or lower.startswith("i:"):
            return line.split(":", 1)[1].strip()
    return ""


def _has_to_tag(raw: str) -> bool:
    """Return True if the To header in a raw SIP message contains a tag parameter."""
    for line in raw.split(CRLF):
        if line.lower().startswith("to:") or line.lower().startswith("t:"):
            return "tag=" in line.lower()
    return False


# ---------------------------------------------------------------------------
# Lightweight dialog state (replaces UASession for traffic path)
# ---------------------------------------------------------------------------

@dataclass
class DialogState:
    """
    Minimal SIP dialog state for one call leg.
    Keyed by Call-ID in ExtensionAgent.active_dialogs.
    """
    call_id: str
    local_tag: str
    local_ext: str
    remote_ext: str
    domain: str
    transport: str
    local_host: str
    local_port: int

    # Dialog identifiers (filled as dialog progresses)
    remote_tag: str = ""
    cseq: int = 1
    rseq: int = 0                  # RSeq value from received 1xx
    route_set: list[str] = field(default_factory=list)
    remote_target: str = ""        # Contact from 200 OK — used for BYE
    record_routes: list[str] = field(default_factory=list)

    # State machine
    state: str = "IDLE"            # matches SipCallState string values

    # Metrics timestamps (milliseconds)
    invite_sent_ms: float = 0.0
    ringing_recv_ms: float = 0.0   # time of first 180/183 → PDD
    ack_sent_ms: float = 0.0
    bye_sent_ms: float = 0.0

    # Reliable provisional (100rel)
    is_reliable: bool = True

    # Stored SIP messages for building subsequent requests
    invite_msg: Optional[SipMessage] = None
    prov_msg: Optional[SipMessage] = None

    # RTP media coordinates (populated from SDP answer / SDP offer)
    rtp_remote_ip:   str = ""   # remote RTP IP  (from their SDP c= line)
    rtp_remote_port: int = 0    # remote RTP port (from their SDP m=audio line)


# ---------------------------------------------------------------------------
# SDP media-coordinate extractor (module-level, used by multiple methods)
# ---------------------------------------------------------------------------

def _parse_sdp_media(sdp_body: str) -> tuple:
    """
    Extract (ip, port) from an SDP body.

    Parses the session-level c= line for IP and the first m=audio line
    for port.  Returns ("", 0) on any parse failure so callers can
    treat a missing/unparseable SDP as "no valid remote RTP endpoint".

    Edge cases handled:
      - CRLF or LF line endings
      - Trailing whitespace / extra tokens after IP
      - m=audio port 0 (media declined) or 9 (RFC 4566 discard)
      - Missing c= or m= lines → returns ("", 0)
    """
    ip   = ""
    port = 0
    for line in sdp_body.splitlines():
        line = line.strip()
        if line.startswith("c=IN IP4 "):
            # c=IN IP4 <addr>   (may have trailing text on malformed SDPs)
            ip = line[9:].split()[0] if len(line) > 9 else ""
        elif line.startswith("m=audio "):
            # m=audio <port> <proto> <fmt …>
            parts = line.split()
            if len(parts) >= 2:
                try:
                    port = int(parts[1])
                except ValueError:
                    port = 0
            break   # only first m=audio matters
    return ip, port


# ---------------------------------------------------------------------------
# ExtensionAgent
# ---------------------------------------------------------------------------

class ExtensionAgent:
    """
    One SIP user agent per extension number.

    Lifecycle:
      1. start()          — create transport, connect, start recv loop
      2. register()       — REGISTER → 401 → REGISTER with auth → 200
      3. subscribe()      — SUBSCRIBE → 200
      4. [traffic runs]
      5. unregister()     — REGISTER expires=0
      6. close()          — drain active calls, close transport
    """

    def __init__(self, ext: str, config: VMConfig) -> None:
        self.ext = ext
        self.config = config
        self._transport: Optional[AsyncSipTransport] = None
        self._local_port: int = 0
        self._local_host: str = ""

        # Asyncio events used as barriers in pre_phase.py
        self.registered: asyncio.Event = asyncio.Event()
        self.subscribed: asyncio.Event = asyncio.Event()

        # Active in-flight dialogs: call_id → DialogState
        self.active_dialogs: dict[str, DialogState] = {}

        # Dialogs abandoned on timeout but still potentially receiving late
        # BYE/CANCEL from CM.  The zombie handler auto-responds 200 OK so
        # CM can release the station immediately.  Entries expire after 120 s.
        self.zombie_dialogs: dict[str, DialogState] = {}

        # Queue of (event_code, raw_message) tuples from the transport
        self._recv_queue: asyncio.Queue = asyncio.Queue()

        # Dispatch table: event_code → list[callback(raw_msg)]
        # Used by call_engine / pre_phase to hook into inbound messages
        self._handlers: dict[str, list[asyncio.Queue]] = {}

        self._recv_task: Optional[asyncio.Task] = None
        self._closed = False

        # Registration state (persisted after successful register for unregister)
        self._reg_session: Optional[Any] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Bind transport and start background receive dispatch loop."""
        if self.config.local_host:
            self._local_host = self.config.local_host
        else:
            # Auto-detect the local IP by making a real TCP connection to the
            # SBC on the actual SIP port.  This ensures the detected IP matches
            # the interface that the SIP transport will use, even when UDP and
            # TCP routing differ or port 1 UDP is blocked.
            import socket as _socket
            try:
                _s = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
                _s.settimeout(3)
                _s.connect((self.config.sbc_host, self.config.sbc_port))
                self._local_host = _s.getsockname()[0]
                _s.close()
            except Exception:
                self._local_host = "127.0.0.1"
        _util.Util.my_ip = self._local_host  # shared by existing build functions
        log.info("ext=%s local_host resolved to %s", self.ext, self._local_host)

        self._transport = create_transport(
            self.config.sip_transport,
            self._local_host,
            self.config.sbc_host,
            self.config.sbc_port,
        )
        await self._transport.connect()
        self._local_port = self._transport.local_port

        # Start background dispatch loop
        self._recv_task = asyncio.create_task(
            self._dispatch_loop(),
            name=f"ext-{self.ext}-dispatch",
        )
        log.debug("ExtensionAgent %s started on port %d", self.ext, self._local_port)

    async def close(self) -> None:
        """Stop recv loop and close transport."""
        self._closed = True
        if self._recv_task and not self._recv_task.done():
            self._recv_task.cancel()
            try:
                await self._recv_task
            except asyncio.CancelledError:
                pass
        if self._transport:
            await self._transport.close()

    # ------------------------------------------------------------------
    # Port synchronisation (TCP reconnect may change the ephemeral port)
    # ------------------------------------------------------------------

    def _sync_local_port(self) -> None:
        """Keep _local_port in sync with the transport's actual bound port.
        After a TCP reconnect the OS assigns a new ephemeral port; SIP
        Contact / Via headers must reflect the real source port or the
        SBC will RST the connection on mismatch."""
        if self._transport is not None:
            tp = self._transport.local_port
            if tp and tp != self._local_port:
                log.debug(
                    "ext=%s port changed %d → %d (transport reconnected)",
                    self.ext, self._local_port, tp,
                )
                self._local_port = tp

    # ------------------------------------------------------------------
    # Send helpers
    # ------------------------------------------------------------------

    async def _send(self, sip_msg: SipMessage, body: str = "") -> None:
        """Serialize a SipMessage via existing buildMessage() and send."""
        raw = buildMessage(sip_msg, body)
        await self._transport.send(raw)

    async def _respond_200_to_notify(self, raw_notify: str) -> None:
        """Send 200 OK to an incoming NOTIFY (e.g. dialog subscription)."""
        try:
            parts = raw_notify.split(CRLF + CRLF, 1)
            notify = parseHeaders(parts[0])
            resp = SipMessage()
            resp.setResponseLine("SIP/2.0 200 OK")
            for hdr in (SipHeaders.VIA, SipHeaders.FROM, SipHeaders.TO, SipHeaders.CALLID, SipHeaders.CSEQ):
                vals = notify.getHeader(hdr.value)
                if vals:
                    for v in vals:
                        resp.addHeader(hdr.value, v)
            resp.addHeader(SipHeaders.CONTENTLENGTH.value, "0")
            await self._send(resp)
            log.debug("ext=%s sent 200 OK to NOTIFY", self.ext)
        except Exception:
            log.exception("ext=%s failed to respond 200 to NOTIFY", self.ext)

    async def _respond_200_to_request(self, raw_msg: str) -> None:
        """
        Send 200 OK mirroring all mandatory headers from an inbound SIP request.
        Used by the zombie handler for late BYE/CANCEL arriving on abandoned dialogs.
        Mirrors the same header-copy pattern as handle_bye / handle_prack.
        """
        try:
            parts = raw_msg.split(CRLF + CRLF, 1)
            req = parseHeaders(parts[0])
            resp = SipMessage()
            resp.setResponseLine("SIP/2.0 200 OK")
            for hdr in (SipHeaders.VIA, SipHeaders.FROM, SipHeaders.TO,
                        SipHeaders.CALLID, SipHeaders.CSEQ):
                vals = req.getHeader(hdr.value)
                if vals:
                    for v in vals:
                        resp.addHeader(hdr.value, v)
            resp.addHeader(SipHeaders.CONTENTLENGTH.value, "0")
            await self._send(resp)
            log.debug("ext=%s zombie: 200 OK → late %s (call_id=%s)",
                      self.ext, req.getMethod() if hasattr(req, "getMethod") else "?",
                      req.getCallID() if hasattr(req, "getCallID") else "?")
        except Exception:
            log.exception("ext=%s zombie: failed to send 200 OK to late request", self.ext)

    async def _respond_481_to_request(self, raw_msg: str) -> None:
        """
        Send 481 Call/Transaction Does Not Exist for an in-dialog request whose
        Call-ID is unknown to this agent.  RFC 3261 §12.2.2.
        Ensures CM does not keep retrying teardown for a ghost dialog.
        """
        try:
            parts = raw_msg.split(CRLF + CRLF, 1)
            req = parseHeaders(parts[0])
            resp = SipMessage()
            resp.setResponseLine("SIP/2.0 481 Call/Transaction Does Not Exist")
            for hdr in (SipHeaders.VIA, SipHeaders.FROM, SipHeaders.TO,
                        SipHeaders.CALLID, SipHeaders.CSEQ):
                vals = req.getHeader(hdr.value)
                if vals:
                    for v in vals:
                        resp.addHeader(hdr.value, v)
            resp.addHeader(SipHeaders.CONTENTLENGTH.value, "0")
            await self._send(resp)
            log.debug("ext=%s 481 → unknown in-dialog request (call_id=%s)",
                      self.ext, req.getCallID() if hasattr(req, "getCallID") else "?")
        except Exception:
            log.exception("ext=%s failed to send 481 to unknown dialog request", self.ext)

    # ------------------------------------------------------------------
    # Background receive / dispatch loop
    # ------------------------------------------------------------------

    async def _dispatch_loop(self) -> None:
        """
        Read raw SIP messages from the transport recv_queue, classify them,
        and route them to registered per-event queues (registered by
        _wait_for_event) or to the default dialog handler.
        """
        transport_q = self._transport.recv_queue
        while not self._closed:
            try:
                raw = await asyncio.wait_for(transport_q.get(), timeout=1.0)
                event_code, _ = classify_message(raw)

                # Route to any listener registered for this event code
                queues = self._handlers.get(event_code, [])
                delivered = False
                for q in list(queues):
                    await q.put(raw)
                    delivered = True
                if delivered and event_code in ("407", "200", "200_PRACK", "200_INVITE", "202"):
                    log.debug("ext=%s dispatched %s to %d handler(s)", self.ext, event_code, len(queues))

                # Also deliver to wildcard listeners (empty string key)
                for q in list(self._handlers.get("*", [])):
                    await q.put((event_code, raw))
                    delivered = True

                # Auto-respond 200 OK to NOTIFY (dialog subscription)
                if event_code == "NOTIFY":
                    asyncio.create_task(self._respond_200_to_notify(raw))

                if not delivered:
                    log.debug(
                        "ext=%s unhandled event=%s (%.60s…)",
                        self.ext, event_code, raw.replace(CRLF, " "),
                    )

                # ── Zombie / 481 handler ──────────────────────────────────
                # Fires for BYE and CANCEL regardless of whether the message
                # was already delivered to a specific queue.  Guard: only when
                # Call-ID is NOT in active_dialogs (i.e. the normal _handle_call
                # is NOT processing this dialog — no risk of double response).
                if event_code in ("BYE", "CANCEL"):
                    cid = _extract_call_id(raw)
                    if cid and cid not in self.active_dialogs:
                        if cid in self.zombie_dialogs:
                            asyncio.create_task(
                                self._respond_200_to_request(raw),
                                name=f"zombie-200-{cid[:12]}",
                            )
                        elif _has_to_tag(raw):
                            asyncio.create_task(
                                self._respond_481_to_request(raw),
                                name=f"unknown-481-{cid[:12]}",
                            )

            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                return
            except Exception:
                log.exception("ext=%s dispatch loop error", self.ext)

    def _wait_for_event(self, *event_codes: str) -> asyncio.Queue:
        """
        Register a one-shot queue that will receive the next message
        matching any of the given event codes (e.g. "200", "401", "180").

        Caller must deregister via _deregister_event_queue() when done.
        """
        q: asyncio.Queue = asyncio.Queue(maxsize=1)
        for code in event_codes:
            self._handlers.setdefault(code, []).append(q)
        return q

    def _deregister_event_queue(self, q: asyncio.Queue, *event_codes: str) -> None:
        for code in event_codes:
            listeners = self._handlers.get(code, [])
            if q in listeners:
                listeners.remove(q)

    def register_wildcard_listener(self) -> asyncio.Queue:
        """Return a queue that receives ALL inbound (event_code, raw) tuples."""
        q: asyncio.Queue = asyncio.Queue()
        self._handlers.setdefault("*", []).append(q)
        return q

    def deregister_wildcard_listener(self, q: asyncio.Queue) -> None:
        self._deregister_event_queue(q, "*")

    # ------------------------------------------------------------------
    # Registration
    # ------------------------------------------------------------------

    async def register(self) -> None:
        """
        Full REGISTER flow using existing register.py build functions:
          1. Build initial REGISTER (no auth)
          2. Send, wait for 401
          3. Extract nonce via authenticate.recv401Unauthorised
          4. Build final REGISTER with Digest auth
          5. Send, wait for 200 OK
        """
        from registration import UARegistration  # existing module

        self._sync_local_port()

        reg_session = UARegistration()
        reg_session.setUserName(self.ext)
        reg_session.setPassword(self.config.sip_password)
        reg_session.setRealm(self.config.domain)
        reg_session.setURI(f"sip:{self.config.domain}")

        reg_msg = _register.buildInitialRegister(
            self.ext,
            self.config.domain,
            self.config.sip_transport,
            self._local_port,
        )
        reg_session.setCurrRegMessage(reg_msg)

        # Register event listeners
        q_401 = self._wait_for_event("401")
        q_200 = self._wait_for_event("200")

        try:
            await self._send(reg_msg)
            log.debug("ext=%s sent initial REGISTER", self.ext)

            # Wait for 401
            raw_401 = await asyncio.wait_for(q_401.get(), timeout=self.config.register_timeout)
            recv401Unauthorised(reg_session, raw_401)
            log.debug("ext=%s got 401, retrying with auth", self.ext)

            self._sync_local_port()
            auth_reg_msg = _register.buildFinalRegister(
                reg_session, self.ext, self.config.domain, self.config.sip_transport
            )
            reg_session.setCurrRegMessage(auth_reg_msg)
            await self._send(auth_reg_msg)

            # Wait for 200 OK
            await asyncio.wait_for(q_200.get(), timeout=self.config.register_timeout)
            log.info("ext=%s registered OK", self.ext)
            self.registered.set()
            self._reg_session = reg_session

        finally:
            self._deregister_event_queue(q_401, "401")
            self._deregister_event_queue(q_200, "200")

    async def unregister(self) -> None:
        """REGISTER with Expires: 0. Handles 401 re-challenge if nonce expired."""
        if self._reg_session is None:
            log.debug("ext=%s not registered, skipping unregister", self.ext)
            return

        self._sync_local_port()
        unreg_msg = _register.buildUnregister(
            self._reg_session, self.ext, self.config.domain, self.config.sip_transport
        )

        q_200 = self._wait_for_event("200")
        q_401 = self._wait_for_event("401")
        try:
            await self._send(unreg_msg)

            done_task = asyncio.create_task(q_200.get(), name=f"unreg-200-{self.ext}")
            auth_task = asyncio.create_task(q_401.get(), name=f"unreg-401-{self.ext}")

            first_done, pending = await asyncio.wait(
                [done_task, auth_task],
                timeout=float(self.config.register_timeout),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            if not first_done:
                log.warning("ext=%s unregister timed out", self.ext)
            elif auth_task in first_done and not auth_task.cancelled():
                raw_401 = auth_task.result()
                recv401Unauthorised(self._reg_session, raw_401)
                retry_msg = _register.buildUnregister(
                    self._reg_session, self.ext, self.config.domain, self.config.sip_transport
                )
                q_200_retry = self._wait_for_event("200")
                try:
                    await self._send(retry_msg)
                    await asyncio.wait_for(q_200_retry.get(), timeout=float(self.config.register_timeout))
                    log.info("ext=%s unregistered (after 401 re-auth)", self.ext)
                    self.registered.clear()
                except asyncio.TimeoutError:
                    log.warning("ext=%s unregister 200 OK timed out (after re-auth)", self.ext)
                finally:
                    self._deregister_event_queue(q_200_retry, "200")
            else:
                log.info("ext=%s unregistered", self.ext)
                self.registered.clear()
        except asyncio.TimeoutError:
            log.warning("ext=%s unregister 200 OK timed out", self.ext)
        finally:
            self._deregister_event_queue(q_200, "200")
            self._deregister_event_queue(q_401, "401")
            self._reg_session = None

    async def flush_register(self) -> None:
        """
        Send REGISTER(Expires:0) from scratch at startup to evict any stale
        binding left by a previous run on a different ephemeral port.

        Flow mirrors register(): initial REGISTER → 401 challenge → auth → 200 OK.
        Accepts 200, 404, 403, 481 as successful outcomes (all mean "no stale binding").
        Never raises — errors are logged and silently swallowed.
        """
        from registration import UARegistration  # existing module

        self._sync_local_port()
        reg_session = UARegistration()
        reg_session.setUserName(self.ext)
        reg_session.setPassword(self.config.sip_password)
        reg_session.setRealm(self.config.domain)
        reg_session.setURI(f"sip:{self.config.domain}")

        # Build initial REGISTER then convert to de-registration:
        # RFC 3261 §10.2.2: Contact: * with Expires: 0 removes ALL bindings.
        # (Using specific Contact with expires=3600 param would NOT work because
        # the per-contact expires param overrides the Expires header.)
        reg_msg = _register.buildInitialRegister(
            self.ext,
            self.config.domain,
            self.config.sip_transport,
            self._local_port,
        )
        reg_msg.replaceHeader("Contact", "*")
        reg_msg.replaceHeader("Expires", "0")
        reg_session.setCurrRegMessage(reg_msg)

        _FLUSH_DONE = ("200", "404", "403", "481")
        q_401 = self._wait_for_event("401")
        q_done = self._wait_for_event(*_FLUSH_DONE)

        try:
            await self._send(reg_msg)
            log.debug("ext=%s sent flush REGISTER(Expires:0)", self.ext)

            # Wait for either a 401 challenge or an immediate final response
            done_task = asyncio.create_task(q_done.get(), name=f"flush-done-{self.ext}")
            auth_task = asyncio.create_task(q_401.get(),  name=f"flush-401-{self.ext}")

            first_done, pending = await asyncio.wait(
                [done_task, auth_task],
                timeout=float(self.config.register_timeout),
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)

            if not first_done:
                log.debug("ext=%s flush REGISTER timed out (no prior registration)", self.ext)
                return

            completed = next(iter(first_done))
            if completed is auth_task and not auth_task.cancelled():
                raw_401 = auth_task.result()
                recv401Unauthorised(reg_session, raw_401)
                self._sync_local_port()
                auth_msg = _register.buildFinalRegister(
                    reg_session, self.ext, self.config.domain, self.config.sip_transport
                )
                auth_msg.replaceHeader("Contact", "*")
                auth_msg.replaceHeader("Expires", "0")
                reg_session.setCurrRegMessage(auth_msg)

                q_done2 = self._wait_for_event(*_FLUSH_DONE)
                try:
                    await self._send(auth_msg)
                    await asyncio.wait_for(q_done2.get(), timeout=float(self.config.register_timeout))
                    log.debug("ext=%s flush REGISTER(auth) done", self.ext)
                except asyncio.TimeoutError:
                    log.debug("ext=%s flush REGISTER(auth) timed out", self.ext)
                finally:
                    self._deregister_event_queue(q_done2, *_FLUSH_DONE)
            else:
                log.debug("ext=%s flush REGISTER done (code accepted)", self.ext)

        except Exception as exc:
            log.debug("ext=%s flush_register error (ignored): %s", self.ext, exc)
        finally:
            self._deregister_event_queue(q_401, "401")
            self._deregister_event_queue(q_done, *_FLUSH_DONE)

    # ------------------------------------------------------------------
    # SUBSCRIBE
    # ------------------------------------------------------------------

    async def subscribe(self) -> None:
        """
        SUBSCRIBE flow: send SUBSCRIBE, on 407 add Proxy-Authorization and retry,
        wait for 200 OK.
        """
        from uasession import UASession  # existing module

        self._sync_local_port()
        ua = UASession()
        ua.setUserName(self.ext)
        ua.setUserDisplayName(self.ext)
        ua.setUserType("EXT")
        ua.setDomain(self.config.domain)
        ua.setTransport(self.config.sip_transport)
        ua.setTargetExtn(self.ext)
        ua.setCallID(_util.createCallID())
        ua.setFromHeader([
            f'<sip:{self.ext}@{self.config.domain}>;tag={_util.createFromTag()}'
        ])
        ua.setToHeader([f'<sip:{self.ext}@{self.config.domain}>'])
        ua.setLocalContact(
            f'<sip:{self.ext}@{self._local_host}:{self._local_port};'
            f'transport={self.config.sip_transport}>'
        )
        ua.setCSeq(0)
        ua.setEvent("dialog")
        ua.setRealm(self.config.domain)
        ua.setURI(f"sip:{self.ext}@{self.config.domain}")

        q_407 = self._wait_for_event("407")
        q_200 = self._wait_for_event("200")
        q_202 = self._wait_for_event("202")

        try:
            sub_msg = _subscribe.buildSubscribe(ua)
            await self._send(sub_msg)
            log.debug("ext=%s sent initial SUBSCRIBE", self.ext)

            async def first_of_407_200_or_202():
                t407 = asyncio.create_task(q_407.get())
                t200 = asyncio.create_task(q_200.get())
                t202 = asyncio.create_task(q_202.get())
                done, pending = await asyncio.wait(
                    [t407, t200, t202], return_when=asyncio.FIRST_COMPLETED
                )
                for p in pending:
                    p.cancel()
                return done.pop().result()

            raw_msg = await asyncio.wait_for(
                first_of_407_200_or_202(),
                timeout=self.config.register_timeout,
            )
            event_code, _ = classify_message(raw_msg)
            log.debug("ext=%s SUBSCRIBE received %s", self.ext, event_code)

            if event_code == "407":
                recv407ProxyAuth(ua, raw_msg)
                ua.setURI(f"sip:{self.ext}@{self.config.domain}")
                sub_msg = _subscribe.buildSubscribe(ua)
                hdr_auth = calcDigestResp(
                    ua, self.ext, self.config.sip_password, "SUBSCRIBE"
                )
                sub_msg.addHeader(SipHeaders.PROXYAUTHORIZATION.value, hdr_auth)
                await self._send(sub_msg)
                log.debug("ext=%s sent SUBSCRIBE with Proxy-Authorization", self.ext)
                # Wait for 200 or 202 (Kamailio returns 202 Accepted)
                async def wait_200_or_202():
                    t2 = asyncio.create_task(q_200.get())
                    t3 = asyncio.create_task(q_202.get())
                    done, _ = await asyncio.wait([t2, t3], return_when=asyncio.FIRST_COMPLETED)
                    for p in (t2, t3):
                        if not p.done():
                            p.cancel()
                    return done.pop().result()
                await asyncio.wait_for(wait_200_or_202(), timeout=self.config.register_timeout)
            elif event_code not in ("200", "202"):
                raise RuntimeError(f"Unexpected SUBSCRIBE response: {event_code}")

            log.info("ext=%s subscribed OK", self.ext)
            self.subscribed.set()
        except asyncio.TimeoutError:
            log.warning("ext=%s SUBSCRIBE 200 OK timed out", self.ext)
            raise
        finally:
            self._deregister_event_queue(q_407, "407")
            self._deregister_event_queue(q_200, "200")
            self._deregister_event_queue(q_202, "202")

    # ------------------------------------------------------------------
    # UAC: Send INVITE
    # ------------------------------------------------------------------

    async def send_invite(self, callee_ext: str, rtp_port: int = 9) -> DialogState:
        """
        Build and send an INVITE (Require: 100rel).
        rtp_port: local UDP port allocated by RtpStream (default 9 = discard).
        Returns a DialogState for tracking the call.
        """
        self._sync_local_port()
        call_id = _util.createCallID()
        local_tag = _util.createFromTag()

        sdp_body = self._build_sdp(rtp_port)

        invite = SipMessage()
        branch = _util.createBranchID()
        invite.setRequestLine(
            f"INVITE sip:{callee_ext}@{self.config.domain} SIP/2.0"
        )
        invite.addHeader(SipHeaders.CALLID.value, call_id)
        invite.addHeader(
            SipHeaders.FROM.value,
            f'<sip:{self.ext}@{self.config.domain}>;tag={local_tag}',
        )
        invite.addHeader(
            SipHeaders.TO.value, f"<sip:{callee_ext}@{self.config.domain}>"
        )
        invite.addHeader(
            SipHeaders.VIA.value,
            f"SIP/2.0/{self.config.sip_transport} "
            f"{self._local_host};branch={branch}",
        )
        invite.addHeader(
            SipHeaders.CONTACT.value,
            f"<sip:{self.ext}@{self._local_host}:{self._local_port};"
            f"transport={self.config.sip_transport}>",
        )
        invite.addHeader(SipHeaders.MAXFORWARDS.value, "70")
        invite.addHeader(SipHeaders.CSEQ.value, "1 INVITE")
        invite.addHeader(SipHeaders.REQUIRE.value, "100rel")
        invite.addHeader(SipHeaders.SUPPORTED.value, "100rel")
        invite.addHeader(SipHeaders.CONTENTTYPE.value, "application/sdp")
        invite.addHeader(SipHeaders.CONTENTLENGTH.value, str(len(sdp_body)))

        dialog = DialogState(
            call_id=call_id,
            local_tag=local_tag,
            local_ext=self.ext,
            remote_ext=callee_ext,
            domain=self.config.domain,
            transport=self.config.sip_transport,
            local_host=self._local_host,
            local_port=self._local_port,
            cseq=1,
            state="INVITE_SENT",
            invite_sent_ms=time.monotonic() * 1000,
            invite_msg=invite,
            is_reliable=True,
        )
        self.active_dialogs[call_id] = dialog

        await self._send(invite, sdp_body)
        log.debug("ext=%s sent INVITE → %s (call_id=%s)", self.ext, callee_ext, call_id)
        return dialog

    # ------------------------------------------------------------------
    # UAC: Send PRACK
    # ------------------------------------------------------------------

    async def send_prack(self, dialog: DialogState) -> None:
        """Send PRACK for a reliable provisional (RFC 3262)."""
        if dialog.prov_msg is None:
            log.warning("ext=%s send_prack: no provisional msg stored", self.ext)
            return

        prov = dialog.prov_msg
        rack_value = f"{dialog.rseq} {dialog.cseq} INVITE"
        dialog.cseq += 1

        prack = SipMessage()
        prack.setRequestLine(
            f"PRACK sip:{dialog.remote_ext}@{self.config.domain} SIP/2.0"
        )
        prack.addHeader(SipHeaders.CALLID.value, dialog.call_id)
        from_hdr = dialog.invite_msg.getHeader(SipHeaders.FROM.value)
        prack.addHeader(SipHeaders.FROM.value, from_hdr[0] if from_hdr else "")
        to_hdr_base = f"<sip:{dialog.remote_ext}@{self.config.domain}>"
        if dialog.remote_tag:
            prack.addHeader(SipHeaders.TO.value, f"{to_hdr_base};tag={dialog.remote_tag}")
        else:
            prack.addHeader(SipHeaders.TO.value, to_hdr_base)
        prack.addHeader(
            SipHeaders.VIA.value,
            f"SIP/2.0/{self.config.sip_transport} "
            f"{self._local_host};branch={_util.createBranchID()}",
        )
        prack.addHeader(
            SipHeaders.CONTACT.value,
            f"<sip:{self.ext}@{self._local_host}:{self._local_port}>",
        )
        prack.addHeader(SipHeaders.MAXFORWARDS.value, "70")
        prack.addHeader(SipHeaders.CSEQ.value, f"{dialog.cseq} PRACK")
        prack.addHeader(SipHeaders.RACK.value, rack_value)
        prack.addHeader(SipHeaders.CONTENTLENGTH.value, "0")

        await self._send(prack)
        log.debug("ext=%s sent PRACK (RAck=%s)", self.ext, rack_value)

    # ------------------------------------------------------------------
    # UAC: Send ACK
    # ------------------------------------------------------------------

    async def send_ack(self, dialog: DialogState) -> None:
        """Send ACK after 200 OK to INVITE."""
        dialog.ack_sent_ms = time.monotonic() * 1000

        ack = SipMessage()
        target = dialog.remote_target or f"sip:{dialog.remote_ext}@{self.config.domain}"
        ack.setRequestLine(f"ACK {target} SIP/2.0")
        ack.addHeader(SipHeaders.CALLID.value, dialog.call_id)
        from_hdr = dialog.invite_msg.getHeader(SipHeaders.FROM.value)
        ack.addHeader(SipHeaders.FROM.value, from_hdr[0] if from_hdr else "")
        ack.addHeader(
            SipHeaders.TO.value,
            f"<sip:{dialog.remote_ext}@{dialog.domain}>;tag={dialog.remote_tag}",
        )
        ack.addHeader(
            SipHeaders.VIA.value,
            f"SIP/2.0/{self.config.sip_transport} "
            f"{self._local_host};branch={_util.createBranchID()}",
        )
        ack.addHeader(SipHeaders.MAXFORWARDS.value, "70")
        ack.addHeader(SipHeaders.CSEQ.value, f"{dialog.cseq} ACK")
        for route in dialog.route_set:
            ack.addHeader(SipHeaders.ROUTE.value, route)
        ack.addHeader(SipHeaders.CONTENTLENGTH.value, "0")

        await self._send(ack)
        dialog.state = "ESTABLISHED"
        log.debug("ext=%s sent ACK (call_id=%s)", self.ext, dialog.call_id)

    async def send_ack_for_failure(self, dialog: DialogState, raw_response: str) -> None:
        """
        Send ACK for a final failure response (4xx, 5xx, 6xx) to INVITE.
        RFC 3261 requires ACK for all final responses to complete the transaction.
        """
        parts = raw_response.split(CRLF + CRLF, 1)
        resp = parseHeaders(parts[0])
        to_hdrs = resp.getHeader(SipHeaders.TO.value)
        to_val = to_hdrs[0] if to_hdrs else f"<sip:{dialog.remote_ext}@{self.config.domain}>"
        cseq_hdrs = resp.getHeader(SipHeaders.CSEQ.value)
        cseq_val = cseq_hdrs[0] if cseq_hdrs else "1 INVITE"
        from_hdrs = dialog.invite_msg.getHeader(SipHeaders.FROM.value)

        ack = SipMessage()
        ack.setRequestLine(f"ACK sip:{dialog.remote_ext}@{self.config.domain} SIP/2.0")
        ack.addHeader(SipHeaders.CALLID.value, dialog.call_id)
        ack.addHeader(SipHeaders.FROM.value, from_hdrs[0] if from_hdrs else "")
        ack.addHeader(SipHeaders.TO.value, to_val)
        ack.addHeader(
            SipHeaders.VIA.value,
            f"SIP/2.0/{self.config.sip_transport} "
            f"{self._local_host};branch={_util.createBranchID()}",
        )
        ack.addHeader(SipHeaders.MAXFORWARDS.value, "70")
        ack.addHeader(SipHeaders.CSEQ.value, cseq_val)
        ack.addHeader(SipHeaders.CONTENTLENGTH.value, "0")

        await self._send(ack)
        log.debug("ext=%s sent ACK for failure response (call_id=%s)", self.ext, dialog.call_id)

    # ------------------------------------------------------------------
    # UAC: Send CANCEL
    # ------------------------------------------------------------------

    async def send_cancel(self, dialog: DialogState) -> None:
        """
        Send CANCEL for a pending INVITE (our Timer B fired, no final response).
        RFC 3261 §9.1: CANCEL MUST reuse the same branch ID as the original
        INVITE Via header so the network can match them to the same transaction.
        Fire-and-forget — caller does not await a response.
        """
        if dialog.invite_msg is None:
            log.warning("ext=%s send_cancel: no invite_msg on dialog (call_id=%s)",
                        self.ext, dialog.call_id)
            return
        try:
            orig_via_hdrs = dialog.invite_msg.getHeader(SipHeaders.VIA.value)
            orig_via = (orig_via_hdrs[0] if orig_via_hdrs else
                        f"SIP/2.0/{self.config.sip_transport} "
                        f"{self._local_host};branch={_util.createBranchID()}")
            from_hdrs = dialog.invite_msg.getHeader(SipHeaders.FROM.value)
            to_base = f"<sip:{dialog.remote_ext}@{dialog.domain}>"
            to_val = (f"{to_base};tag={dialog.remote_tag}"
                      if dialog.remote_tag else to_base)

            cancel = SipMessage()
            cancel.setRequestLine(
                f"CANCEL sip:{dialog.remote_ext}@{self.config.domain} SIP/2.0"
            )
            cancel.addHeader(SipHeaders.CALLID.value, dialog.call_id)
            cancel.addHeader(SipHeaders.FROM.value, from_hdrs[0] if from_hdrs else "")
            cancel.addHeader(SipHeaders.TO.value, to_val)
            cancel.addHeader(SipHeaders.VIA.value, orig_via)
            cancel.addHeader(SipHeaders.MAXFORWARDS.value, "70")
            cancel.addHeader(SipHeaders.CSEQ.value, f"{dialog.cseq} CANCEL")
            cancel.addHeader(SipHeaders.CONTENTLENGTH.value, "0")

            await self._send(cancel)
            log.debug("ext=%s sent CANCEL (call_id=%s)", self.ext, dialog.call_id)
        except Exception:
            log.exception("ext=%s failed to send CANCEL (call_id=%s)",
                          self.ext, dialog.call_id)

    # ------------------------------------------------------------------
    # UAC: Send BYE
    # ------------------------------------------------------------------

    async def send_bye(self, dialog: DialogState) -> None:
        """Send BYE to terminate an established call."""
        dialog.bye_sent_ms = time.monotonic() * 1000
        dialog.state = "BYE_SENT"
        dialog.cseq += 1

        bye = SipMessage()
        target = dialog.remote_target or f"sip:{dialog.remote_ext}@{self.config.domain}"
        bye.setRequestLine(f"BYE {target} SIP/2.0")
        bye.addHeader(SipHeaders.CALLID.value, dialog.call_id)
        from_hdr = dialog.invite_msg.getHeader(SipHeaders.FROM.value)
        bye.addHeader(SipHeaders.FROM.value, from_hdr[0] if from_hdr else "")
        bye.addHeader(
            SipHeaders.TO.value,
            f"<sip:{dialog.remote_ext}@{dialog.domain}>;tag={dialog.remote_tag}",
        )
        bye.addHeader(
            SipHeaders.VIA.value,
            f"SIP/2.0/{self.config.sip_transport} "
            f"{self._local_host};branch={_util.createBranchID()}",
        )
        bye.addHeader(SipHeaders.MAXFORWARDS.value, "70")
        bye.addHeader(SipHeaders.CSEQ.value, f"{dialog.cseq} BYE")
        for route in dialog.route_set:
            bye.addHeader(SipHeaders.ROUTE.value, route)
        bye.addHeader(SipHeaders.CONTENTLENGTH.value, "0")

        await self._send(bye)
        log.debug("ext=%s sent BYE (call_id=%s)", self.ext, dialog.call_id)

    # ------------------------------------------------------------------
    # UAS: Handle inbound INVITE
    # ------------------------------------------------------------------

    async def handle_incoming_invite(self, raw_msg: str) -> DialogState:
        """
        Parse an incoming INVITE and send 100 Trying + 180 Ringing.
        Also extracts remote RTP endpoint from the SDP offer so the
        absorber knows the SBC media address (informational; UAS minimal
        does not send RTP back).
        Returns a DialogState for the new incoming dialog.
        """
        parts  = raw_msg.split(CRLF + CRLF, 1)
        invite = parseHeaders(parts[0])
        call_id = invite.getCallID()
        remote_tag = invite.getFromTag()
        local_tag = _util.createFromTag()
        cseq = invite.getCSeq()

        dialog = DialogState(
            call_id=call_id,
            local_tag=local_tag,
            local_ext=self.ext,
            remote_ext=invite.getReqURIUserPart() or "",
            domain=self.config.domain,
            transport=self.config.sip_transport,
            local_host=self._local_host,
            local_port=self._local_port,
            remote_tag=remote_tag,
            cseq=cseq,
            state="INVITE_RCVD",
            invite_msg=invite,
            is_reliable=True,
        )
        self.active_dialogs[call_id] = dialog

        # Extract remote RTP endpoint from INVITE SDP offer (SBC media address)
        if len(parts) > 1 and parts[1].strip():
            ip, port = _parse_sdp_media(parts[1])
            if ip and port > 0:
                dialog.rtp_remote_ip   = ip
                dialog.rtp_remote_port = port
                log.debug(
                    "ext=%s remote RTP from INVITE SDP: %s:%d",
                    self.ext, ip, port,
                )

        # Send 100 Trying (stateless)
        await self._send_provisional(invite, "100", "Trying", local_tag, include_contact=False)

        # Send 180 Ringing (reliable if Require: 100rel in INVITE)
        rseq = _util.genRSeq()
        dialog.rseq = rseq
        await self._send_provisional(
            invite, "180", "Ringing", local_tag,
            include_contact=True, rseq=rseq
        )
        dialog.state = "PROVRESP_SENT"

        log.debug("ext=%s received INVITE → sent 180 (call_id=%s)", self.ext, call_id)
        return dialog

    async def _send_provisional(
        self,
        invite: SipMessage,
        code: str,
        reason: str,
        local_tag: str,
        include_contact: bool = True,
        rseq: int = 0,
    ) -> None:
        resp = SipMessage()
        resp.setResponseLine(f"SIP/2.0 {code} {reason}")
        via_hdrs = invite.getHeader(SipHeaders.VIA.value) or []
        for v in via_hdrs:
            resp.addHeader(SipHeaders.VIA.value, v)
        from_hdr = invite.getHeader(SipHeaders.FROM.value)
        resp.addHeader(SipHeaders.FROM.value, from_hdr[0] if from_hdr else "")
        to_hdr_base = invite.getHeader(SipHeaders.TO.value)
        to_val = to_hdr_base[0] if to_hdr_base else ""
        resp.addHeader(SipHeaders.TO.value, f"{to_val};tag={local_tag}")
        resp.addHeader(SipHeaders.CALLID.value, invite.getCallID())
        cseq_hdr = invite.getHeader(SipHeaders.CSEQ.value)
        resp.addHeader(SipHeaders.CSEQ.value, cseq_hdr[0] if cseq_hdr else "")
        if include_contact:
            resp.addHeader(
                SipHeaders.CONTACT.value,
                f"<sip:{self.ext}@{self._local_host}:{self._local_port}>",
            )
        if rseq:
            resp.addHeader(SipHeaders.REQUIRE.value, "100rel")
            resp.addHeader(SipHeaders.RSEQ.value, str(rseq))
        resp.addHeader(SipHeaders.CONTENTLENGTH.value, "0")
        await self._send(resp)

    # ------------------------------------------------------------------
    # UAS: Send 200 OK to INVITE
    # ------------------------------------------------------------------

    async def send_200_invite(self, dialog: DialogState, rtp_port: int = 9) -> None:
        """
        Send 200 OK to an incoming INVITE (after PRACK exchange).
        rtp_port: local UDP port allocated by RtpAbsorber (default 9 = discard).
        """
        invite = dialog.invite_msg
        sdp_body = self._build_sdp(rtp_port)

        resp = SipMessage()
        resp.setResponseLine("SIP/2.0 200 OK")
        via_hdrs = invite.getHeader(SipHeaders.VIA.value) or []
        for v in via_hdrs:
            resp.addHeader(SipHeaders.VIA.value, v)
        from_hdr = invite.getHeader(SipHeaders.FROM.value)
        resp.addHeader(SipHeaders.FROM.value, from_hdr[0] if from_hdr else "")
        to_hdr_base = invite.getHeader(SipHeaders.TO.value)
        to_val = to_hdr_base[0] if to_hdr_base else ""
        resp.addHeader(SipHeaders.TO.value, f"{to_val};tag={dialog.local_tag}")
        resp.addHeader(SipHeaders.CALLID.value, dialog.call_id)
        cseq_hdr = invite.getHeader(SipHeaders.CSEQ.value)
        resp.addHeader(SipHeaders.CSEQ.value, cseq_hdr[0] if cseq_hdr else "1 INVITE")
        resp.addHeader(
            SipHeaders.CONTACT.value,
            f"<sip:{self.ext}@{self._local_host}:{self._local_port}>",
        )
        resp.addHeader(SipHeaders.CONTENTTYPE.value, "application/sdp")
        resp.addHeader(SipHeaders.CONTENTLENGTH.value, str(len(sdp_body)))
        dialog.state = "SUCCESSFULRESP_SENT"

        await self._send(resp, sdp_body)
        log.debug("ext=%s sent 200 OK INVITE (call_id=%s)", self.ext, dialog.call_id)

    # ------------------------------------------------------------------
    # UAS: Handle PRACK and reply 200
    # ------------------------------------------------------------------

    async def handle_prack(self, raw_msg: str, dialog: DialogState) -> None:
        """Receive PRACK, send 200 OK to PRACK."""
        prack = parseHeaders(raw_msg.split(CRLF + CRLF)[0])

        resp = SipMessage()
        resp.setResponseLine("SIP/2.0 200 OK")
        via_hdrs = prack.getHeader(SipHeaders.VIA.value) or []
        for v in via_hdrs:
            resp.addHeader(SipHeaders.VIA.value, v)
        from_hdr = prack.getHeader(SipHeaders.FROM.value)
        resp.addHeader(SipHeaders.FROM.value, from_hdr[0] if from_hdr else "")
        to_hdr = prack.getHeader(SipHeaders.TO.value)
        resp.addHeader(SipHeaders.TO.value, to_hdr[0] if to_hdr else "")
        resp.addHeader(SipHeaders.CALLID.value, dialog.call_id)
        cseq_hdr = prack.getHeader(SipHeaders.CSEQ.value)
        resp.addHeader(SipHeaders.CSEQ.value, cseq_hdr[0] if cseq_hdr else "")
        resp.addHeader(SipHeaders.CONTENTLENGTH.value, "0")

        await self._send(resp)
        log.debug("ext=%s sent 200 PRACK (call_id=%s)", self.ext, dialog.call_id)

    # ------------------------------------------------------------------
    # UAS: Handle BYE and reply 200
    # ------------------------------------------------------------------

    async def handle_bye(self, raw_msg: str, dialog: DialogState) -> None:
        """Receive BYE, send 200 OK."""
        bye_msg = parseHeaders(raw_msg.split(CRLF + CRLF)[0])

        resp = SipMessage()
        resp.setResponseLine("SIP/2.0 200 OK")
        via_hdrs = bye_msg.getHeader(SipHeaders.VIA.value) or []
        for v in via_hdrs:
            resp.addHeader(SipHeaders.VIA.value, v)
        from_hdr = bye_msg.getHeader(SipHeaders.FROM.value)
        resp.addHeader(SipHeaders.FROM.value, from_hdr[0] if from_hdr else "")
        to_hdr = bye_msg.getHeader(SipHeaders.TO.value)
        resp.addHeader(SipHeaders.TO.value, to_hdr[0] if to_hdr else "")
        resp.addHeader(SipHeaders.CALLID.value, dialog.call_id)
        cseq_hdr = bye_msg.getHeader(SipHeaders.CSEQ.value)
        resp.addHeader(SipHeaders.CSEQ.value, cseq_hdr[0] if cseq_hdr else "")
        resp.addHeader(SipHeaders.CONTENTLENGTH.value, "0")

        await self._send(resp)
        dialog.state = "COMPLETE"
        self.active_dialogs.pop(dialog.call_id, None)
        log.debug("ext=%s handled BYE → 200 (call_id=%s)", self.ext, dialog.call_id)

    # ------------------------------------------------------------------
    # SDP builder — real UDP port when RTP is active, 9 (discard) otherwise
    # ------------------------------------------------------------------

    def _build_sdp(self, rtp_port: int = 9) -> str:
        """
        Build a G.711 audio SDP.

        rtp_port: OS-assigned local UDP port from RtpStream / RtpAbsorber.
                  Defaults to 9 (RFC 4566 discard) so legacy call paths
                  that omit the argument are still safe.

        a=ptime:20 matches CM Codec Set (Frames Per Pkt=2, Packet Size=20ms).
        """
        return (
            "v=0\r\n"
            f"o=- 0 0 IN IP4 {self._local_host}\r\n"
            "s=-\r\n"
            f"c=IN IP4 {self._local_host}\r\n"
            "t=0 0\r\n"
            f"m=audio {rtp_port} RTP/AVP 0 8 101\r\n"
            "a=rtpmap:0 PCMU/8000\r\n"
            "a=rtpmap:8 PCMA/8000\r\n"
            "a=rtpmap:101 telephone-event/8000\r\n"
            "a=fmtp:101 0-15\r\n"
            "a=ptime:20\r\n"
            "a=sendrecv\r\n"
        )

    # ------------------------------------------------------------------
    # Inbound response parsing helpers
    # ------------------------------------------------------------------

    def parse_prov_response(self, raw_msg: str, dialog: DialogState) -> None:
        """
        Parse 180/183 provisional response.
        Extracts remote tag, RSeq (for PRACK), and Record-Route.
        """
        prov = parseHeaders(raw_msg.split(CRLF + CRLF)[0])
        dialog.remote_tag = prov.getToTag()
        if dialog.ringing_recv_ms == 0.0:
            dialog.ringing_recv_ms = time.monotonic() * 1000
        try:
            dialog.rseq = prov.getRSeq()
        except Exception:
            pass
        dialog.prov_msg = prov
        dialog.state = "PROVRESP_RCVD"

    def parse_200_invite(self, raw_msg: str, dialog: DialogState) -> None:
        """
        Parse 200 OK to INVITE.
        Extracts remote tag, remote Contact (for BYE), Route set,
        and remote RTP endpoint (ip:port) from the SDP answer body.
        """
        parts = raw_msg.split(CRLF + CRLF, 1)
        resp = parseHeaders(parts[0])
        dialog.remote_tag = resp.getToTag()
        contact_hdrs = resp.getHeader(SipHeaders.CONTACT.value)
        if contact_hdrs:
            raw_contact = contact_hdrs[0]
            # Extract URI from angle brackets if present
            if "<" in raw_contact and ">" in raw_contact:
                dialog.remote_target = raw_contact[
                    raw_contact.index("<") + 1: raw_contact.index(">")
                ]
            else:
                dialog.remote_target = raw_contact.split(";")[0].strip()
        dialog.record_routes = resp.getRecordRoutes(True) or []
        dialog.route_set = list(reversed(dialog.record_routes))
        dialog.state = "SUCCESSFULRESP_RCVD"

        # Extract remote RTP endpoint from SDP answer (SBC/CM media address)
        if len(parts) > 1 and parts[1].strip():
            ip, port = _parse_sdp_media(parts[1])
            if ip and port > 0:
                dialog.rtp_remote_ip   = ip
                dialog.rtp_remote_port = port
                log.debug(
                    "ext=%s remote RTP from 200 OK SDP: %s:%d",
                    self.ext, ip, port,
                )
