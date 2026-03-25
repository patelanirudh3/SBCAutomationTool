"""
traffic/call_engine.py
======================
CPS-controlled asynchronous call orchestrator.

UAC mode:
  - Token-bucket rate controller fires INVITEs at config.cps calls/sec
  - Linear ramp-up over config.ramp_up_seconds before hitting full CPS
  - execute_call() coroutine: INVITE → 100 → 180 → PRACK → 200 → ACK
                              → RTP 3-phase (hold_time) → BYE → 200 BYE
  - Extension pairs cycle sequentially — no 1:1 binding

UAS mode:
  - All agents run auto-answer loops listening for inbound INVITEs
  - On INVITE: 100 → 180 → wait PRACK → 200 PRACK → 200 OK → wait ACK
                         → RTP 3-phase (until BYE) → 200 BYE

RTP — bidirectional 3-phase heartbeat (G.711 PCMU, 20 ms ptime):
  Both sides allocate a real UDP port, send BURST_START → KEEPALIVE →
  BURST_END, and count received packets via _CountingProtocol.
  UAC: run(duration=hold_time) then BYE; reads stats for verification.
  UAS: run_until_cancelled(); BYE cancels the task; reads stats.
  If RTP socket allocation fails, call continues with port 9 (no media).

Talk-path verification events:
  MEDIA_VERIFIED  — rtp_rx_pkts > 0 on this side
  MEDIA_FAILED    — rtp_rx_pkts == 0 on this side
  MEDIA_PARTIAL   — rx > 0 but duration < 50% of hold_time

All structured logging uses JSON events for call_id, ext, event, sip_code, ts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .extension_agent import ExtensionAgent, DialogState
from .config import VMConfig
from .sip_engine import classify_message
from .rtp_stream import RtpEndpoint, RtpStats

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Structured JSON call event logger
# ---------------------------------------------------------------------------

def _log_call_event(
    call_id: str,
    ext: str,
    event: str,
    sip_code: Optional[str] = None,
    **extra,
) -> None:
    """Emit a structured JSON log line for every significant call event."""
    record = {
        "call_id": call_id,
        "ext": ext,
        "event": event,
        "timestamp_ms": round(time.monotonic() * 1000),
    }
    if sip_code:
        record["sip_code"] = sip_code
    record.update(extra)
    log.info("CALL_EVENT %s", json.dumps(record))


def _classify_media(stats: RtpStats, hold_seconds: float) -> str:
    """
    Determine talk-path verification event from RTP receive stats.
      MEDIA_VERIFIED — rx > 0 and duration covers >= 50% of hold_time
      MEDIA_PARTIAL  — rx > 0 but duration < 50% of hold_time
      MEDIA_FAILED   — rx == 0
    """
    if stats.rtp_rx_pkts == 0:
        return "MEDIA_FAILED"
    if (stats.last_rx_ms is not None and stats.first_rx_ms is not None
            and stats.last_rx_ms > 0 and stats.first_rx_ms > 0):
        rx_duration_s = (stats.last_rx_ms - stats.first_rx_ms) / 1000.0
        if rx_duration_s < hold_seconds * 0.5:
            return "MEDIA_PARTIAL"
    return "MEDIA_VERIFIED"


# ---------------------------------------------------------------------------
# SIP milestone timestamps (ms offsets from call start, monotonic clock)
# ---------------------------------------------------------------------------

@dataclass
class SipMilestones:
    # UAC side
    invite_sent_ms: float = 0.0
    trying_100_ms: float = 0.0
    ringing_180_ms: float = 0.0
    prack_sent_ms: float = 0.0
    prack_200_ms: float = 0.0
    ok_200_ms: float = 0.0
    ack_sent_ms: float = 0.0
    rtp_start_ms: float = 0.0
    rtp_end_ms: float = 0.0
    bye_sent_ms: float = 0.0
    bye_200_ms: float = 0.0
    media_verified_ms: float = 0.0
    invite_ts_utc: str = ""
    # UAS side
    invite_received_ms: float = 0.0
    trying_100_sent_ms: float = 0.0
    ringing_180_sent_ms: float = 0.0
    prack_received_ms: float = 0.0
    prack_200_sent_ms: float = 0.0
    ok_200_sent_ms: float = 0.0
    ack_received_ms: float = 0.0
    bye_received_ms: float = 0.0
    bye_200_sent_ms: float = 0.0
    uas_invite_ts_utc: str = ""


# ---------------------------------------------------------------------------
# Call result (fed into metrics)
# ---------------------------------------------------------------------------

@dataclass
class CallResult:
    call_id: str
    caller: str
    callee: str
    success: bool
    failure_reason: str = ""
    pdd_ms: float = 0.0        # INVITE → first 180/183
    hold_ms: float = 0.0       # ACK → BYE
    total_ms: float = 0.0      # INVITE → 200 BYE
    rtp_tx_pkts: int = 0
    rtp_rx_pkts: int = 0
    media_verified: bool = False
    rtp_local_port: int = 0    # UDP port used for RTP (0 if none)
    pool_wrap_index: int = 0   # which pool wrap (0-based)
    # Phase 2 enrichment
    peer_ext: str = ""
    ts_utc: str = ""
    direction: str = "uac"
    sbc_rtp_relay_ip: str = ""
    sbc_rtp_relay_port: int = 0
    sip_milestones: SipMilestones = field(default_factory=SipMilestones)
    rtp_rx_from_sbc_pkts: int = 0
    rtp_rx_other_pkts: int = 0
    rtcp_rx_pkts: int = 0
    rtp_asymmetry_flag: str = ""
    markers_sent: int = 0
    markers_received: int = 0
    scenario: str = "basic_call"
    scenario_assertions: dict = field(default_factory=dict)


# ---------------------------------------------------------------------------
# UAC CallEngine
# ---------------------------------------------------------------------------

class CallEngine:
    """
    UAC-side call engine.

    Usage:
        engine = CallEngine(uac_agents, config, metrics_collector)
        await engine.run()
    """

    def __init__(
        self,
        uac_agents: dict[str, ExtensionAgent],
        config: VMConfig,
        on_call_complete=None,
        on_call_attempt=None,
        max_calls: int = 0,
        metrics=None,
    ) -> None:
        """
        Args:
            uac_agents:         ext_str → ExtensionAgent for UAC extensions.
            config:             VMConfig.
            on_call_complete:   Optional async callable(CallResult) for metrics.
            on_call_attempt:    Optional sync callable() invoked at each call launch (for CPS).
            max_calls:          Stop after this many calls attempted (0 = unlimited).
            metrics:            Optional MetricsCollector for raw event recording.
        """
        self._agents = uac_agents
        self._config = config
        self._on_complete = on_call_complete
        self._on_attempt = on_call_attempt
        self._max_calls = max_calls
        self._metrics = metrics
        self._index = 0
        self.stop_event = asyncio.Event()
        self._active_calls: set[str] = set()   # call_ids currently in-flight
        self._calls_attempted = 0
        self._first_call_launch_time: float = 0.0  # legacy: kept for metrics/logging
        self._current_wrap_start_time: float = 0.0  # pool wrap delay: start of current wrap
        self._peak_active_calls = 0
        self._calls_completed = 0
        self._calls_failed = 0

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def active_call_count(self) -> int:
        return len(self._active_calls)

    @property
    def calls_attempted(self) -> int:
        return self._calls_attempted

    @property
    def calls_completed(self) -> int:
        return self._calls_completed

    @property
    def calls_failed(self) -> int:
        return self._calls_failed

    async def run(self) -> None:
        """
        Main UAC loop. Fires calls at CPS rate with linear ramp-up.
        Respects max_concurrent_calls ceiling.
        """
        cfg = self._config
        full_interval = 1.0 / cfg.cps
        ramp_steps = max(cfg.ramp_up_seconds * cfg.cps, 1)
        step = 0

        log.info(
            "CallEngine starting: %d CPS, %ds ramp-up, %ds hold, max_concurrent=%d%s",
            cfg.cps, cfg.ramp_up_seconds, cfg.hold_time_seconds,
            cfg.effective_max_concurrent,
            f", max_calls={self._max_calls}" if self._max_calls else "",
        )

        while not self.stop_event.is_set():
            # Hard call limit (0 = unlimited)
            if self._max_calls > 0 and self._calls_attempted >= self._max_calls:
                log.info(
                    "max_calls=%d reached — waiting for %d in-flight call(s) to finish…",
                    self._max_calls, len(self._active_calls),
                )
                # Drain: wait up to (hold_time + register_timeout) for active calls
                drain_timeout = float(self._config.hold_time_seconds + self._config.register_timeout * 2 + 5)
                deadline = asyncio.get_event_loop().time() + drain_timeout
                while self._active_calls and asyncio.get_event_loop().time() < deadline:
                    await asyncio.sleep(0.2)
                if self._active_calls:
                    log.warning("max_calls drain timed out — %d calls still active", len(self._active_calls))
                log.info("max_calls=%d reached — stopping engine", self._max_calls)
                self.stop_event.set()
                break

            # Rate limiting: respect max concurrent ceiling
            max_cc = cfg.effective_max_concurrent
            if max_cc > 0 and len(self._active_calls) >= max_cc:
                await asyncio.sleep(0.05)
                continue

            # WRAP DELAY FORMULA
            #
            # At each wrap boundary ext #1 from the current wrap may still
            # be on a call.  We must not reuse it until:
            #   hold_time + SIP_BYE_BUFFER  seconds have elapsed since this
            #   wrap started (_current_wrap_start_time).
            #
            # sleep_for = max(0, hold_time + SIP_BYE_BUFFER + extra_margin - elapsed)
            #
            # Always computed — handles all cases in one formula:
            #   wrap_time >> hold_time → elapsed >> target → sleep_for ≤ 0 (natural)
            #   wrap_time == hold_time → sleep_for ≈ SIP_BYE_BUFFER (boundary safe)
            #   wrap_time <  hold_time → sleep_for > 0 (computed delay)
            #   ramp_up slowed wrap   → elapsed is large → sleep_for ≤ 0 (natural)
            #
            # SIP_BYE_BUFFER = 2.0s — BYE RTT + SBC dialog cleanup.
            #   Internal constant, never user-configurable.
            # pool_wrap_delay_seconds = optional extra safety margin.
            #   Default 0. Only needed if SBC is slow to release dialogs.
            SIP_BYE_BUFFER = 2.0

            pool_count = cfg.pool_wrap_count
            if pool_count > 0 and self._calls_attempted > 0 and self._calls_attempted % pool_count == 0:
                wrap_time    = pool_count / max(cfg.cps, 0.001)
                hold_time    = cfg.hold_time_seconds
                extra_margin = getattr(cfg, 'pool_wrap_delay_seconds', 0) or 0
                natural      = wrap_time >= hold_time + SIP_BYE_BUFFER

                elapsed   = time.monotonic() - self._current_wrap_start_time
                sleep_for = max(0.0, hold_time + SIP_BYE_BUFFER + extra_margin - elapsed)

                if sleep_for > 0:
                    log.info(
                        "Pool wrap delay: sleeping %.1fs before wrap %d "
                        "(wrap_time=%.1fs, hold=%ds, natural=%s)",
                        sleep_for,
                        (self._calls_attempted // pool_count) + 1,
                        wrap_time, hold_time,
                        'yes' if natural else 'no',
                    )
                    await asyncio.sleep(sleep_for)
                elif not natural:
                    log.debug(
                        "Pool wrap boundary %d: no sleep needed "
                        "(elapsed=%.1fs already covers hold=%ds+%.1fs buffer)",
                        (self._calls_attempted // pool_count) + 1,
                        elapsed, hold_time, SIP_BYE_BUFFER,
                    )

                self._current_wrap_start_time = time.monotonic()

            # Linear ramp-up: interval decreases from full_interval×10 → full_interval
            if step < ramp_steps:
                ramp_factor = 1.0 + 9.0 * (1.0 - step / ramp_steps)
                interval = full_interval * ramp_factor
                step += 1
            else:
                interval = full_interval

            caller, callee = self._next_pair()
            agent = self._agents.get(str(caller))
            if agent is None:
                log.error("No agent for extension %s", caller)
                await asyncio.sleep(interval)
                continue

            if self._calls_attempted == 0:
                self._first_call_launch_time = time.monotonic()
                self._current_wrap_start_time = time.monotonic()
            self._calls_attempted += 1
            if self._on_attempt:
                self._on_attempt()
            pool_count = cfg.pool_wrap_count
            wrap_idx = (self._calls_attempted - 1) // pool_count if pool_count else 0
            task = asyncio.create_task(
                self._execute_call(agent, str(callee), wrap_idx),
                name=f"call-{caller}-{callee}-{self._calls_attempted}",
            )
            task.add_done_callback(lambda t: None)  # suppress "never awaited" warning

            await asyncio.sleep(interval)

        log.info(
            "CallEngine stopped: attempted=%d completed=%d failed=%d",
            self._calls_attempted, self._calls_completed, self._calls_failed,
        )

    def stop(self) -> None:
        """Signal the run loop to stop firing new calls."""
        self.stop_event.set()

    def _emit_call_event(self, call_id: str, ext: str, event: str,
                         direction: str = "uac", peer_ext: str = "",
                         sip_code: int = 0, milestone_ms: float = 0.0,
                         **extra) -> None:
        ts_utc = datetime.now(timezone.utc).isoformat()
        ts_mono = time.monotonic() * 1000
        payload = {
            "call_id": call_id,
            "ext": ext,
            "peer_ext": peer_ext,
            "event": event,
            "direction": direction,
            "ts_utc": ts_utc,
            "ts_mono_ms": round(ts_mono, 3),
            "milestone_ms": round(milestone_ms, 3),
        }
        if sip_code:
            payload["sip_code"] = sip_code
        payload.update(extra)
        log.info("CALL_EVENT %s", json.dumps(payload))
        if self._metrics:
            self._metrics.record_raw_event(payload)

    def _compute_rtp_asymmetry_flag(self, tx_pkts: int, rx_from_sbc: int,
                                     rx_total: int) -> str:
        """
        Compute asymmetry using filtered (SBC-only) rx count.
        Falls back to all-rx if expected_src was never set (rx_from_sbc == 0 but rx > 0).
        """
        if tx_pkts == 0:
            return "OK"
        if rx_from_sbc == 0 and rx_total > 0:
            effective_rx = rx_total
        else:
            effective_rx = rx_from_sbc
        delta_pct = abs(tx_pkts - effective_rx) / tx_pkts * 100
        if delta_pct <= 5:
            return "OK"
        if delta_pct <= 15:
            return "WARNING"
        return "CRITICAL"

    # ------------------------------------------------------------------
    # Extension pairing
    # ------------------------------------------------------------------

    def _next_pair(self) -> tuple[int, int]:
        """
        Return (caller_ext, callee_ext).
        UAC pool and UAS pool cycle independently — no 1:1 binding.

        Call #1 → uac_start+0 calls uas_start+0
        Call #2 → uac_start+1 calls uas_start+1
        Call #N → wraps independently for each pool
        """
        cfg = self._config
        uac_count = cfg.uac_ext_count
        uas_count = cfg.uas_ext_count
        caller = cfg.uac_ext_start + (self._index % uac_count)
        callee = cfg.uas_ext_start + (self._index % uas_count)
        self._index += 1
        return caller, callee

    # ------------------------------------------------------------------
    # Full SIP call sequence (UAC)
    # ------------------------------------------------------------------

    async def _execute_call(self, agent: ExtensionAgent, callee: str, pool_wrap_index: int = 0) -> None:
        """
        Single call coroutine:
          INVITE → 100 Trying → 180 Ringing (reliable) → PRACK → 200 PRACK
                → 200 OK INVITE → ACK → RTP 3-phase (hold_time) → BYE → 200 BYE

        Handles:
          - 407 Proxy-Auth at INVITE (re-sends with credentials)
          - Timeouts at each step (marks call as failed)
          - RTP socket allocation failures (degrades to port-9 / no media)
          - Talk-path verification via RtpEndpoint.stats
          - Structured JSON logging at every event
        """
        call_start = time.monotonic()
        dialog: Optional[DialogState] = None
        call_id = "pending"
        rtp_ep: Optional[RtpEndpoint] = None
        milestones = SipMilestones()
        invite_ts_utc = ""

        try:
            # ── Allocate RTP endpoint (port goes into SDP offer) ──────
            if self._config.media_enabled:
                try:
                    rtp_ep = await RtpEndpoint.create(agent._local_host, ptime_ms=self._config.rtp_ptime)
                except Exception as exc:
                    log.warning(
                        "ext=%s RTP socket alloc failed (%s) — using port 9 (no media)",
                        agent.ext, exc,
                    )
            rtp_port = rtp_ep.local_port if rtp_ep else 9

            # ── INVITE ────────────────────────────────────────────────
            dialog = await agent.send_invite(callee, rtp_port=rtp_port)
            call_id = dialog.call_id
            self._active_calls.add(call_id)
            if len(self._active_calls) > self._peak_active_calls:
                self._peak_active_calls = len(self._active_calls)
            invite_ts_utc = datetime.now(timezone.utc).isoformat()
            milestones.invite_sent_ms = 0.0
            milestones.invite_ts_utc = invite_ts_utc
            self._emit_call_event(call_id, agent.ext, "INVITE_SENT",
                                  peer_ext=callee, milestone_ms=0.0, callee=callee)

            timeout = float(self._config.register_timeout * 2)

            # ── Wait for provisional + handle 407 + handle final failures
            _FINAL_FAIL = (
                "400", "401", "403", "404", "405", "406", "408",
                "410", "413", "414", "415", "416", "420", "421", "422", "423",
                "480", "481", "482", "483", "484", "485", "486", "487", "488",
                "489", "491", "493", "494",
                "500", "501", "502", "503", "504", "505",
                "600", "603", "604", "606",
            )
            prov_q = agent._wait_for_event("100", "180", "183", "407", *_FINAL_FAIL)
            try:
                got_180 = False
                while not got_180:
                    raw = await asyncio.wait_for(prov_q.get(), timeout=timeout)
                    event_code, _ = classify_message(raw)

                    if event_code == "100":
                        milestones.trying_100_ms = (time.monotonic() - call_start) * 1000
                        self._emit_call_event(call_id, agent.ext, "TRYING_100",
                                              peer_ext=callee, sip_code=100,
                                              milestone_ms=milestones.trying_100_ms)

                    elif event_code in ("180", "183"):
                        agent.parse_prov_response(raw, dialog)
                        pdd = dialog.ringing_recv_ms - dialog.invite_sent_ms
                        milestones.ringing_180_ms = (time.monotonic() - call_start) * 1000
                        self._emit_call_event(
                            call_id, agent.ext, "RINGING_180", peer_ext=callee,
                            sip_code=int(event_code),
                            milestone_ms=milestones.ringing_180_ms,
                            pdd_ms=round(pdd, 2),
                        )
                        got_180 = True

                    elif event_code == "407":
                        self._emit_call_event(call_id, agent.ext, "AUTH_407",
                                              peer_ext=callee, sip_code=407)
                        await self._handle_407_invite(agent, dialog, raw)

                    elif event_code in _FINAL_FAIL or (
                        event_code.isdigit() and len(event_code) == 3
                        and event_code[0] in ("4", "5", "6")
                    ):
                        await agent.send_ack_for_failure(dialog, raw)
                        self._emit_call_event(
                            call_id, agent.ext, "CALL_FAILED", peer_ext=callee,
                            sip_code=int(event_code) if event_code.isdigit() else 0,
                            reason="final failure",
                        )
                        raise _CallFailed(f"Rejected with {event_code}")

            finally:
                agent._deregister_event_queue(prov_q, "100", "180", "183", "407", *_FINAL_FAIL)

            # ── PRACK (if 100rel) ─────────────────────────────────────
            if dialog.is_reliable and dialog.rseq:
                await agent.send_prack(dialog)
                milestones.prack_sent_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "PRACK_SENT",
                                      peer_ext=callee,
                                      milestone_ms=milestones.prack_sent_ms)

                prack_200_q = agent._wait_for_event("200_PRACK")
                try:
                    await asyncio.wait_for(prack_200_q.get(), timeout=timeout)
                    milestones.prack_200_ms = (time.monotonic() - call_start) * 1000
                    self._emit_call_event(call_id, agent.ext, "PRACK_200",
                                          peer_ext=callee, sip_code=200,
                                          milestone_ms=milestones.prack_200_ms)
                finally:
                    agent._deregister_event_queue(prack_200_q, "200_PRACK")

            # ── Wait for 200 OK to INVITE ─────────────────────────────
            inv_200_q = agent._wait_for_event("200_INVITE")
            try:
                raw_200 = await asyncio.wait_for(inv_200_q.get(), timeout=timeout)
                agent.parse_200_invite(raw_200, dialog)
                milestones.ok_200_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "OK_200_INVITE",
                                      peer_ext=callee, sip_code=200,
                                      milestone_ms=milestones.ok_200_ms)
            finally:
                agent._deregister_event_queue(inv_200_q, "200_INVITE")

            if rtp_ep and dialog.rtp_remote_ip:
                rtp_ep.set_remote_rtp_addr(dialog.rtp_remote_ip, dialog.rtp_remote_port)

            # ── ACK ───────────────────────────────────────────────────
            await agent.send_ack(dialog)
            milestones.ack_sent_ms = (time.monotonic() - call_start) * 1000
            self._emit_call_event(call_id, agent.ext, "ACK_SENT",
                                  peer_ext=callee,
                                  milestone_ms=milestones.ack_sent_ms)

            # ── RTP send (3-phase or continuous) ─────────────────────
            cfg = self._config
            is_continuous = cfg.rtp_mode == "continuous"
            if rtp_ep:
                milestones.rtp_start_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext,
                                      "RTP_CONTINUOUS_START" if is_continuous else "RTP_BURST_START",
                                      peer_ext=callee,
                                      milestone_ms=milestones.rtp_start_ms)
                await rtp_ep.run(
                    dialog.rtp_remote_ip,
                    dialog.rtp_remote_port,
                    float(cfg.hold_time_seconds),
                    burst_seconds=float(cfg.rtp_burst_seconds),
                    burst_pps=cfg.rtp_burst_pps,
                    keepalive_interval=float(cfg.rtp_keepalive_interval),
                    continuous=is_continuous,
                )
                milestones.rtp_end_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext,
                                      "RTP_CONTINUOUS_END" if is_continuous else "RTP_BURST_END",
                                      peer_ext=callee,
                                      milestone_ms=milestones.rtp_end_ms)
            else:
                await asyncio.sleep(cfg.hold_time_seconds)
            hold_ms = (time.monotonic() * 1000) - dialog.ack_sent_ms

            # ── BYE ───────────────────────────────────────────────────
            await agent.send_bye(dialog)
            milestones.bye_sent_ms = (time.monotonic() - call_start) * 1000
            self._emit_call_event(call_id, agent.ext, "BYE_SENT",
                                  peer_ext=callee,
                                  milestone_ms=milestones.bye_sent_ms)

            bye_200_q = agent._wait_for_event("200")
            try:
                await asyncio.wait_for(bye_200_q.get(), timeout=timeout)
                milestones.bye_200_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "BYE_200",
                                      peer_ext=callee, sip_code=200,
                                      milestone_ms=milestones.bye_200_ms)
            finally:
                agent._deregister_event_queue(bye_200_q, "200")

            # ── Talk-path verification ────────────────────────────────
            rtp_tx = 0
            rtp_rx = 0
            rtp_rx_from_sbc = 0
            rtp_rx_other = 0
            rtcp_rx = 0
            markers_sent_val = 0
            markers_received_val = 0
            media_ok = False
            if rtp_ep:
                st = rtp_ep.stats
                rtp_tx = rtp_ep.tx_pkts
                rtp_rx = st.rtp_rx_pkts
                rtp_rx_from_sbc = st.rtp_rx_from_sbc
                rtp_rx_other = st.rtp_rx_other
                rtcp_rx = st.rtcp_rx_pkts
                markers_sent_val = rtp_ep.markers_sent
                markers_received_val = st.markers_received
                media_ok = rtp_rx > 0
                media_event = _classify_media(st, float(cfg.hold_time_seconds))
                milestones.media_verified_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(
                    call_id, agent.ext, media_event, peer_ext=callee,
                    rtp_tx_pkts=rtp_tx, rtp_rx_pkts=rtp_rx,
                    rtp_rx_from_sbc_pkts=rtp_rx_from_sbc,
                    rtp_rx_other_pkts=rtp_rx_other,
                    rtcp_rx_pkts=rtcp_rx,
                    markers_sent=markers_sent_val,
                    markers_received=markers_received_val,
                    direction="uac",
                    milestone_ms=milestones.media_verified_ms,
                )

            if not cfg.media_enabled:
                self._emit_call_event(call_id, agent.ext, "MEDIA_DISABLED",
                                      direction="uac", peer_ext=callee)

            # ── Call complete ─────────────────────────────────────────
            total_ms = (time.monotonic() - call_start) * 1000
            pdd_ms = (dialog.ringing_recv_ms - dialog.invite_sent_ms) if dialog else 0
            result = CallResult(
                call_id=call_id,
                caller=agent.ext,
                callee=callee,
                success=True,
                pdd_ms=pdd_ms,
                hold_ms=hold_ms,
                total_ms=total_ms,
                rtp_tx_pkts=rtp_tx,
                rtp_rx_pkts=rtp_rx,
                media_verified=media_ok,
                rtp_local_port=rtp_ep.local_port if rtp_ep else 0,
                pool_wrap_index=pool_wrap_index,
                peer_ext=callee,
                ts_utc=invite_ts_utc,
                direction="uac",
                sbc_rtp_relay_ip=dialog.rtp_remote_ip if dialog else "",
                sbc_rtp_relay_port=dialog.rtp_remote_port if dialog else 0,
                sip_milestones=milestones,
                rtp_rx_from_sbc_pkts=rtp_rx_from_sbc,
                rtp_rx_other_pkts=rtp_rx_other,
                rtcp_rx_pkts=rtcp_rx,
                rtp_asymmetry_flag=self._compute_rtp_asymmetry_flag(rtp_tx, rtp_rx_from_sbc, rtp_rx),
                markers_sent=markers_sent_val,
                markers_received=markers_received_val,
            )
            self._calls_completed += 1
            self._emit_call_event(
                call_id, agent.ext, "CALL_COMPLETE", peer_ext=callee,
                pdd_ms=round(pdd_ms, 2),
                hold_ms=round(hold_ms, 2),
                total_ms=round(total_ms, 2),
            )

        except _CallFailed as exc:
            result = CallResult(
                call_id=call_id, caller=agent.ext, callee=callee,
                success=False, failure_reason=str(exc),
                total_ms=(time.monotonic() - call_start) * 1000,
                rtp_local_port=rtp_ep.local_port if rtp_ep else 0,
                pool_wrap_index=pool_wrap_index,
                peer_ext=callee, ts_utc=invite_ts_utc, direction="uac",
                sip_milestones=milestones,
            )
            self._calls_failed += 1
            self._emit_call_event(call_id, agent.ext, "CALL_FAILED",
                                  peer_ext=callee, reason=str(exc))

        except asyncio.TimeoutError:
            result = CallResult(
                call_id=call_id, caller=agent.ext if agent else "?", callee=callee,
                success=False, failure_reason="timeout",
                total_ms=(time.monotonic() - call_start) * 1000,
                rtp_local_port=rtp_ep.local_port if rtp_ep else 0,
                pool_wrap_index=pool_wrap_index,
                peer_ext=callee, ts_utc=invite_ts_utc, direction="uac",
                sip_milestones=milestones,
            )
            self._calls_failed += 1
            self._emit_call_event(call_id, agent.ext if agent else "?",
                                  "CALL_TIMEOUT", peer_ext=callee)

        except asyncio.CancelledError:
            if dialog and dialog.state == "ESTABLISHED":
                try:
                    await asyncio.wait_for(agent.send_bye(dialog), timeout=5.0)
                except Exception:
                    pass
            self._calls_failed += 1
            return

        except Exception as exc:
            log.exception("Unexpected error in execute_call ext=%s callee=%s", agent.ext, callee)
            result = CallResult(
                call_id=call_id, caller=agent.ext if agent else "?", callee=callee,
                success=False, failure_reason=f"exception: {exc}",
                total_ms=(time.monotonic() - call_start) * 1000,
                rtp_local_port=rtp_ep.local_port if rtp_ep else 0,
                pool_wrap_index=pool_wrap_index,
                peer_ext=callee, ts_utc=invite_ts_utc, direction="uac",
                sip_milestones=milestones,
            )
            self._calls_failed += 1

        finally:
            if rtp_ep:
                await rtp_ep.close()
            if call_id in self._active_calls:
                self._active_calls.discard(call_id)
            if dialog and dialog.call_id in agent.active_dialogs:
                agent.active_dialogs.pop(dialog.call_id, None)

        if self._on_complete:
            try:
                await self._on_complete(result)
            except Exception:
                log.exception("on_call_complete callback error")

    # ------------------------------------------------------------------
    # 407 Proxy Authentication handling
    # ------------------------------------------------------------------

    async def _handle_407_invite(
        self,
        agent: ExtensionAgent,
        dialog: DialogState,
        raw_407: str,
    ) -> None:
        """Re-send INVITE with Proxy-Authorization after 407."""
        import sys, os
        _repo = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "useragent", "json", "linoxiderepo")
        )
        if _repo not in sys.path:
            sys.path.insert(0, _repo)

        from authenticate import calcDigestResp
        from parserandbuilder import parseHeaders
        from sipconstants import SipHeaders
        import util as _util

        # Parse 407 to extract Proxy-Authenticate
        msg_407 = parseHeaders(raw_407.split("\r\n\r\n")[0])
        proxy_auth_hdr = msg_407.getHeader(SipHeaders.PROXYAUTHENTICATE.value)
        if not proxy_auth_hdr:
            log.warning("ext=%s 407 has no Proxy-Authenticate header", agent.ext)
            return

        # Build a minimal object for calcDigestResp
        class _AuthObj:
            def __init__(self):
                self.nonce = ""
                self.cnonce = ""
                self.opaque = ""
                self.realm = ""
                self.qop = ""
                self.response = ""
                self.ncAuth = 1

            def setNonce(self, v): self.nonce = v
            def setCNonce(self, v): self.cnonce = v
            def setOpaque(self, v): self.opaque = v
            def setRealm(self, v): self.realm = v
            def setQOP(self, v): self.qop = v
            def setResponse(self, v): self.response = v
            def getNonce(self): return self.nonce
            def getCNonce(self): return self.cnonce
            def getOpaque(self): return self.opaque
            def getRealm(self): return self.realm
            def getQOP(self): return self.qop
            def getResponse(self): return self.response
            def getNCAuth(self): return self.ncAuth

        auth_obj = _AuthObj()
        # Parse Proxy-Authenticate header
        pa = proxy_auth_hdr[0]
        for part in pa.split(","):
            part = part.strip()
            if part.startswith("nonce"):
                auth_obj.nonce = part.split("=", 1)[1].strip().strip('"')
            elif part.startswith("realm"):
                auth_obj.realm = part.split("=", 1)[1].strip().strip('"')
            elif part.startswith("opaque"):
                auth_obj.opaque = part.split("=", 1)[1].strip().strip('"')
            elif part.startswith("qop"):
                auth_obj.qop = part.split("=", 1)[1].strip().strip('"')

        proxy_auth_value = calcDigestResp(
            auth_obj, agent.ext, self._config.sip_password, "INVITE"
        )

        # Resend INVITE with Proxy-Authorization
        if dialog.invite_msg:
            dialog.cseq += 1
            dialog.invite_msg.replaceHeader(SipHeaders.CSEQ.value, f"{dialog.cseq} INVITE")
            dialog.invite_msg.replaceHeader(
                SipHeaders.PROXYAUTHORIZATION.value, proxy_auth_value
            )
            dialog.invite_msg.addHeader(
                SipHeaders.VIA.value,
                f"SIP/2.0/{self._config.sip_transport} "
                f"{agent._local_host};branch={_util.createBranchID()}",
            )
            from parserandbuilder import buildMessage
            sdp = agent._build_sdp()
            raw = buildMessage(dialog.invite_msg, sdp)
            await agent._transport.send(raw)
            self._emit_call_event(dialog.call_id, agent.ext, "INVITE_AUTH_RESENT",
                                  peer_ext=dialog.remote_ext)

    # ------------------------------------------------------------------
    # Graceful shutdown: send BYE to all active calls
    # ------------------------------------------------------------------

    async def drain_active_calls(self, timeout: float = 10.0) -> None:
        """
        For all currently active dialogs across all agents, send BYE.
        Called during SIGTERM shutdown.
        """
        bye_tasks = []
        for agent in self._agents.values():
            for dialog in list(agent.active_dialogs.values()):
                if dialog.state == "ESTABLISHED":
                    bye_tasks.append(
                        asyncio.create_task(agent.send_bye(dialog))
                    )

        if bye_tasks:
            log.info("Draining %d active calls (BYE)…", len(bye_tasks))
            try:
                await asyncio.wait_for(asyncio.gather(*bye_tasks), timeout=timeout)
            except asyncio.TimeoutError:
                log.warning("Some BYEs timed out during drain")


# ---------------------------------------------------------------------------
# UAS AutoAnswer engine
# ---------------------------------------------------------------------------

class UasAutoAnswer:
    """
    UAS-side engine. Each ExtensionAgent runs an auto-answer loop.
    On any inbound INVITE: 100 → 180 → wait PRACK → 200 PRACK → 200 OK
                         → wait ACK → RTP 3-phase (until BYE) → 200 BYE

    RTP is bidirectional: UAS sends (BURST_START → KEEPALIVE) and receives
    (counted via _CountingProtocol).  No INVITE is ever fired from UAS side.
    """

    def __init__(
        self,
        uas_agents: dict[str, ExtensionAgent],
        config: VMConfig,
        on_call_complete=None,
        metrics=None,
    ) -> None:
        self._agents = uas_agents
        self._config = config
        self._on_complete = on_call_complete
        self._metrics = metrics
        self._tasks: list[asyncio.Task] = []
        self.stop_event = asyncio.Event()

    async def start(self) -> None:
        """Start auto-answer loops for all UAS agents."""
        for agent in self._agents.values():
            t = asyncio.create_task(
                self._uas_loop(agent),
                name=f"uas-{agent.ext}",
            )
            self._tasks.append(t)
        log.info("UAS auto-answer started for %d extensions", len(self._agents))

    async def stop(self) -> None:
        """Cancel all UAS loops."""
        self.stop_event.set()
        for t in self._tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def _emit_call_event(self, call_id: str, ext: str, event: str,
                         direction: str = "uas", peer_ext: str = "",
                         sip_code: int = 0, milestone_ms: float = 0.0,
                         **extra) -> None:
        ts_utc = datetime.now(timezone.utc).isoformat()
        ts_mono = time.monotonic() * 1000
        payload = {
            "call_id": call_id,
            "ext": ext,
            "peer_ext": peer_ext,
            "event": event,
            "direction": direction,
            "ts_utc": ts_utc,
            "ts_mono_ms": round(ts_mono, 3),
            "milestone_ms": round(milestone_ms, 3),
        }
        if sip_code:
            payload["sip_code"] = sip_code
        payload.update(extra)
        log.info("CALL_EVENT %s", json.dumps(payload))
        if self._metrics:
            self._metrics.record_raw_event(payload)

    def _compute_rtp_asymmetry_flag(self, tx_pkts: int, rx_from_sbc: int,
                                     rx_total: int) -> str:
        if tx_pkts == 0:
            return "OK"
        if rx_from_sbc == 0 and rx_total > 0:
            effective_rx = rx_total
        else:
            effective_rx = rx_from_sbc
        delta_pct = abs(tx_pkts - effective_rx) / tx_pkts * 100
        if delta_pct <= 5:
            return "OK"
        if delta_pct <= 15:
            return "WARNING"
        return "CRITICAL"

    async def _uas_loop(self, agent: ExtensionAgent) -> None:
        """
        Infinite loop for one UAS extension.
        Listens on the wildcard queue for INVITE events.
        """
        wq = agent.register_wildcard_listener()
        try:
            while not self.stop_event.is_set():
                try:
                    item = await asyncio.wait_for(wq.get(), timeout=1.0)
                    event_code, raw_msg = item

                    if event_code == "INVITE":
                        asyncio.create_task(
                            self._handle_call(agent, raw_msg),
                            name=f"uas-call-{agent.ext}",
                        )
                except asyncio.TimeoutError:
                    continue
                except asyncio.CancelledError:
                    return
        finally:
            agent.deregister_wildcard_listener(wq)

    async def _handle_call(self, agent: ExtensionAgent, raw_invite: str) -> None:
        """
        Full UAS call sequence for one inbound call.
        INVITE → 100+180 → wait PRACK → 200 PRACK → 200 OK (with real RTP port)
               → wait ACK → RTP 3-phase (until BYE) → 200 BYE
        """
        call_start = time.monotonic()
        dialog: Optional[DialogState] = None
        call_id = "pending"
        timeout = float(self._config.register_timeout * 4)
        rtp_ep: Optional[RtpEndpoint] = None
        rtp_task: Optional[asyncio.Task] = None
        result: Optional[CallResult] = None
        milestones = SipMilestones()
        uas_invite_ts_utc = ""
        caller_ext = ""

        try:
            # ── Allocate RTP endpoint before 200 OK (port goes in SDP) ──
            if self._config.media_enabled:
                try:
                    rtp_ep = await RtpEndpoint.create(agent._local_host, ptime_ms=self._config.rtp_ptime)
                except Exception as exc:
                    log.warning(
                        "ext=%s RTP endpoint alloc failed (%s) — using port 9 (no media)",
                        agent.ext, exc,
                    )
            rtp_port = rtp_ep.local_port if rtp_ep else 9

            # ── Handle INVITE: sends 100 + 180 ───────────────────────
            dialog = await agent.handle_incoming_invite(raw_invite)
            call_id = dialog.call_id
            for _line in raw_invite.split("\r\n"):
                if _line.lower().startswith("from:") and "sip:" in _line:
                    caller_ext = _line[_line.index("sip:") + 4:].split("@")[0]
                    break
            uas_invite_ts_utc = datetime.now(timezone.utc).isoformat()
            milestones.invite_received_ms = 0.0
            milestones.uas_invite_ts_utc = uas_invite_ts_utc
            _offset = (time.monotonic() - call_start) * 1000
            milestones.trying_100_sent_ms = _offset
            milestones.ringing_180_sent_ms = _offset
            self._emit_call_event(call_id, agent.ext, "UAS_INVITE_RECEIVED",
                                  peer_ext=caller_ext, milestone_ms=0.0)
            self._emit_call_event(call_id, agent.ext, "UAS_TRYING_100_SENT",
                                  peer_ext=caller_ext, sip_code=100,
                                  milestone_ms=milestones.trying_100_sent_ms)
            self._emit_call_event(call_id, agent.ext, "UAS_RINGING_180_SENT",
                                  peer_ext=caller_ext, sip_code=180,
                                  milestone_ms=milestones.ringing_180_sent_ms)

            if rtp_ep and dialog.rtp_remote_ip:
                rtp_ep.set_remote_rtp_addr(dialog.rtp_remote_ip, dialog.rtp_remote_port)

            # ── Wait for PRACK ────────────────────────────────────────
            prack_q = agent._wait_for_event("PRACK")
            try:
                raw_prack = await asyncio.wait_for(prack_q.get(), timeout=timeout)
                milestones.prack_received_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "UAS_PRACK_RECEIVED",
                                      peer_ext=caller_ext,
                                      milestone_ms=milestones.prack_received_ms)
                await agent.handle_prack(raw_prack, dialog)
                milestones.prack_200_sent_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "UAS_200_PRACK_SENT",
                                      peer_ext=caller_ext, sip_code=200,
                                      milestone_ms=milestones.prack_200_sent_ms)
            finally:
                agent._deregister_event_queue(prack_q, "PRACK")

            # ── Send 200 OK to INVITE (with real RTP port in SDP) ─────
            await agent.send_200_invite(dialog, rtp_port=rtp_port)
            milestones.ok_200_sent_ms = (time.monotonic() - call_start) * 1000
            self._emit_call_event(call_id, agent.ext, "UAS_200_OK_SENT",
                                  peer_ext=caller_ext, sip_code=200,
                                  milestone_ms=milestones.ok_200_sent_ms)

            # ── Wait for ACK ──────────────────────────────────────────
            ack_q = agent._wait_for_event("ACK")
            try:
                await asyncio.wait_for(ack_q.get(), timeout=timeout)
                dialog.state = "ESTABLISHED"
                milestones.ack_received_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "UAS_ACK_RECEIVED",
                                      peer_ext=caller_ext,
                                      milestone_ms=milestones.ack_received_ms)
            finally:
                agent._deregister_event_queue(ack_q, "ACK")

            # ── Start RTP endpoint (bidirectional: send + receive) ────
            cfg = self._config
            if rtp_ep:
                rtp_task = asyncio.create_task(
                    rtp_ep.run_until_cancelled(
                        dialog.rtp_remote_ip,
                        dialog.rtp_remote_port,
                        burst_seconds=float(cfg.rtp_burst_seconds),
                        burst_pps=cfg.rtp_burst_pps,
                        keepalive_interval=float(cfg.rtp_keepalive_interval),
                        continuous=(cfg.rtp_mode == "continuous"),
                    ),
                    name=f"rtp-uas-{call_id}",
                )

            # ── Wait for BYE ──────────────────────────────────────────
            bye_q = agent._wait_for_event("BYE")
            try:
                hold_timeout = float(cfg.hold_time_seconds + 60)
                raw_bye = await asyncio.wait_for(bye_q.get(), timeout=hold_timeout)
                milestones.bye_received_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "UAS_BYE_RECEIVED",
                                      peer_ext=caller_ext,
                                      milestone_ms=milestones.bye_received_ms)
                await agent.handle_bye(raw_bye, dialog)
                milestones.bye_200_sent_ms = (time.monotonic() - call_start) * 1000
                self._emit_call_event(call_id, agent.ext, "UAS_200_BYE_SENT",
                                      peer_ext=caller_ext, sip_code=200,
                                      milestone_ms=milestones.bye_200_sent_ms)
            finally:
                agent._deregister_event_queue(bye_q, "BYE")

            # ── Cancel RTP task and collect stats ─────────────────────
            rtp_tx = 0
            rtp_rx = 0
            rtp_rx_from_sbc = 0
            rtp_rx_other = 0
            rtcp_rx = 0
            markers_sent_val = 0
            markers_received_val = 0
            media_ok = False
            if rtp_task and not rtp_task.done():
                rtp_task.cancel()
                await asyncio.gather(rtp_task, return_exceptions=True)
            if rtp_ep:
                st = rtp_ep.stats
                rtp_tx = rtp_ep.tx_pkts
                rtp_rx = st.rtp_rx_pkts
                rtp_rx_from_sbc = st.rtp_rx_from_sbc
                rtp_rx_other = st.rtp_rx_other
                rtcp_rx = st.rtcp_rx_pkts
                markers_sent_val = rtp_ep.markers_sent
                markers_received_val = st.markers_received
                media_ok = rtp_rx > 0
                media_event = _classify_media(st, float(cfg.hold_time_seconds))
                self._emit_call_event(
                    call_id, agent.ext, media_event, peer_ext=caller_ext,
                    rtp_tx_pkts=rtp_tx, rtp_rx_pkts=rtp_rx,
                    rtp_rx_from_sbc_pkts=rtp_rx_from_sbc,
                    rtp_rx_other_pkts=rtp_rx_other,
                    rtcp_rx_pkts=rtcp_rx,
                    markers_sent=markers_sent_val,
                    markers_received=markers_received_val,
                    direction="uas",
                )

            if not cfg.media_enabled:
                self._emit_call_event(call_id, agent.ext, "MEDIA_DISABLED",
                                      direction="uas", peer_ext=caller_ext)

            total_ms = (time.monotonic() - call_start) * 1000
            result = CallResult(
                call_id=call_id, caller=caller_ext or "remote", callee=agent.ext,
                success=True, total_ms=total_ms,
                rtp_tx_pkts=rtp_tx, rtp_rx_pkts=rtp_rx,
                media_verified=media_ok,
                rtp_local_port=rtp_ep.local_port if rtp_ep else 0,
                peer_ext=caller_ext,
                ts_utc=uas_invite_ts_utc,
                direction="uas",
                sbc_rtp_relay_ip=dialog.rtp_remote_ip if dialog else "",
                sbc_rtp_relay_port=dialog.rtp_remote_port if dialog else 0,
                sip_milestones=milestones,
                rtp_rx_from_sbc_pkts=rtp_rx_from_sbc,
                rtp_rx_other_pkts=rtp_rx_other,
                rtcp_rx_pkts=rtcp_rx,
                rtp_asymmetry_flag=self._compute_rtp_asymmetry_flag(rtp_tx, rtp_rx_from_sbc, rtp_rx),
                markers_sent=markers_sent_val,
                markers_received=markers_received_val,
            )
            self._emit_call_event(call_id, agent.ext, "UAS_CALL_COMPLETE",
                                  peer_ext=caller_ext,
                                  total_ms=round(total_ms, 2))

        except asyncio.TimeoutError:
            self._emit_call_event(call_id, agent.ext, "UAS_CALL_TIMEOUT",
                                  peer_ext=caller_ext)
            if dialog and dialog.call_id in agent.active_dialogs:
                agent.active_dialogs.pop(dialog.call_id, None)
            result = CallResult(
                call_id=call_id, caller=caller_ext or "remote", callee=agent.ext,
                success=False, failure_reason="timeout",
                total_ms=(time.monotonic() - call_start) * 1000,
                rtp_local_port=rtp_ep.local_port if rtp_ep else 0,
                peer_ext=caller_ext, ts_utc=uas_invite_ts_utc, direction="uas",
                sip_milestones=milestones,
            )

        except asyncio.CancelledError:
            return

        except Exception as exc:
            log.exception("UAS call error ext=%s call_id=%s", agent.ext, call_id)
            if dialog and dialog.call_id in agent.active_dialogs:
                agent.active_dialogs.pop(dialog.call_id, None)
            result = CallResult(
                call_id=call_id, caller=caller_ext or "remote", callee=agent.ext,
                success=False, failure_reason=str(exc),
                total_ms=(time.monotonic() - call_start) * 1000,
                rtp_local_port=rtp_ep.local_port if rtp_ep else 0,
                peer_ext=caller_ext, ts_utc=uas_invite_ts_utc, direction="uas",
                sip_milestones=milestones,
            )

        finally:
            if rtp_task and not rtp_task.done():
                rtp_task.cancel()
                await asyncio.gather(rtp_task, return_exceptions=True)
            if rtp_ep:
                await rtp_ep.close()

        if result and self._on_complete:
            try:
                await self._on_complete(result)
            except Exception:
                log.exception("UAS on_call_complete callback error")


# ---------------------------------------------------------------------------
# Internal exception
# ---------------------------------------------------------------------------

class _CallFailed(Exception):
    """Raised inside _execute_call when a call is cleanly rejected."""
