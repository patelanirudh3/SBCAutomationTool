"""
traffic/metrics.py
==================
Real-time metrics collector + FastAPI HTTP/WebSocket server.

Metrics are collected from CallResult objects pushed by call_engine.py
and exposed via:
  GET  /metrics           → latest TrafficMetrics snapshot (JSON)
  WS   /metrics/stream    → push every config.metrics_interval seconds
  GET  /api/test/status   → { phase, running, elapsed_seconds }
  POST /api/test/start    → accepts VMConfig dict, stored for inspection
  POST /api/test/stop     → triggers graceful shutdown via injected callback
  GET  /api/vms           → [{ vm_id, role, ext_range, status, cps, concurrent }]

The FastAPI app runs in-process alongside the traffic engine using
asyncio, so it shares the same event loop — no subprocess needed.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import logging
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Optional, Callable, Any, TYPE_CHECKING

ConcurrentProvider = Callable[[], int]

if TYPE_CHECKING:
    from .config import VMConfig
    from .extension_agent import ExtensionAgent

log = logging.getLogger(__name__)

# FastAPI / uvicorn are optional at import time so that the engine can
# start even if the web server fails. They're imported lazily in start_server().
try:
    from fastapi import FastAPI, WebSocket, WebSocketDisconnect
    from fastapi.responses import JSONResponse
    import uvicorn
    _FASTAPI_AVAILABLE = True
except ImportError:
    _FASTAPI_AVAILABLE = False
    log.warning(
        "fastapi/uvicorn not installed. Metrics HTTP server will not start. "
        "Install with: pip install fastapi uvicorn[standard]"
    )


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class TrafficMetrics:
    """Snapshot of traffic metrics for one VM at one point in time."""
    timestamp: float          = field(default_factory=time.time)
    vm_id: str                = ""
    phase: str                = "IDLE"         # PRE_REGISTER | PRE_SUBSCRIBE | TRAFFIC | STOPPING | DONE

    # Rate / volume
    cps_actual: float         = 0.0            # calls fired in last interval / interval
    concurrent_calls: int     = 0
    calls_attempted: int      = 0
    calls_completed: int      = 0
    calls_failed: int         = 0
    asr: float                = 0.0            # calls_completed / calls_attempted × 100

    # Latency (milliseconds)
    avg_pdd_ms: float         = 0.0            # INVITE → 180 Ringing
    min_pdd_ms: float         = 0.0
    max_pdd_ms: float         = 0.0
    avg_hold_ms: float        = 0.0            # ACK → BYE
    avg_total_ms: float       = 0.0

    # Health
    socket_count: int         = 0              # must equal extension count
    registered_count: int     = 0
    subscribed_count: int     = 0

    # Run metadata
    run_elapsed_seconds: float = 0.0
    running: bool             = False

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Collector
# ---------------------------------------------------------------------------

class MetricsCollector:
    """
    Accumulates CallResult objects and produces TrafficMetrics snapshots.
    Thread/task-safe via asyncio.Lock.
    """

    def __init__(self, vm_id: str, metrics_interval: int = 10) -> None:
        self._vm_id = vm_id
        self._interval = metrics_interval
        self._lock = asyncio.Lock()

        # Running totals
        self._calls_attempted = 0
        self._calls_completed = 0
        self._calls_failed = 0
        self._pdd_samples: list[float] = []
        self._hold_samples: list[float] = []
        self._total_samples: list[float] = []

        # Windowed (last interval) for CPS calculation
        self._window_start = time.monotonic()
        self._window_calls = 0

        # Latest snapshot (updated every interval)
        self._latest = TrafficMetrics(vm_id=vm_id)

        # External state
        self._concurrent_calls = 0
        self._socket_count = 0
        self._registered_count = 0
        self._subscribed_count = 0
        self._phase = "IDLE"
        self._run_start: float = 0.0
        self._running = False

        self._subscribers: list[asyncio.Queue] = []  # WebSocket push queues
        self._call_results: list = []  # raw CallResult for summary
        self._concurrent_provider: Optional[ConcurrentProvider] = None

    def set_concurrent_provider(self, provider: Optional[ConcurrentProvider]) -> None:
        """Set callable that returns current active call count (UAC only). Used for real-time /metrics."""
        self._concurrent_provider = provider

    # ------------------------------------------------------------------
    # State setters (called by main.py as phases progress)
    # ------------------------------------------------------------------

    def set_phase(self, phase: str) -> None:
        self._phase = phase

    def set_running(self, running: bool) -> None:
        self._running = running
        if running:
            self._run_start = time.monotonic()

    def update_counts(
        self,
        concurrent: int = 0,
        sockets: int = 0,
        registered: int = 0,
        subscribed: int = 0,
    ) -> None:
        self._concurrent_calls = concurrent
        self._socket_count = sockets
        self._registered_count = registered
        self._subscribed_count = subscribed

    # ------------------------------------------------------------------
    # Call result ingestion
    # ------------------------------------------------------------------

    async def record_call(self, result) -> None:
        """
        Accept a CallResult from call_engine and update metrics.
        `result` has: success, pdd_ms, hold_ms, total_ms attributes.
        """
        async with self._lock:
            self._call_results.append(result)
            self._calls_attempted += 1
            self._window_calls += 1
            if result.success:
                self._calls_completed += 1
                if result.pdd_ms:
                    self._pdd_samples.append(result.pdd_ms)
                if result.hold_ms:
                    self._hold_samples.append(result.hold_ms)
                if result.total_ms:
                    self._total_samples.append(result.total_ms)
            else:
                self._calls_failed += 1

    # ------------------------------------------------------------------
    # Snapshot builder
    # ------------------------------------------------------------------

    def _build_snapshot(self) -> TrafficMetrics:
        now = time.monotonic()
        window_elapsed = now - self._window_start

        # CPS: calls fired in last window / window duration
        cps_actual = self._window_calls / window_elapsed if window_elapsed > 0 else 0.0

        # Reset window
        self._window_start = now
        self._window_calls = 0

        # ASR
        asr = 0.0
        if self._calls_attempted > 0:
            asr = (self._calls_completed / self._calls_attempted) * 100

        def _avg(lst):
            return sum(lst) / len(lst) if lst else 0.0

        # Real-time concurrent from engine (UAC) when provider is set
        concurrent = (
            self._concurrent_provider()
            if self._concurrent_provider else self._concurrent_calls
        )

        snap = TrafficMetrics(
            timestamp=time.time(),
            vm_id=self._vm_id,
            phase=self._phase,
            cps_actual=round(cps_actual, 3),
            concurrent_calls=concurrent,
            calls_attempted=self._calls_attempted,
            calls_completed=self._calls_completed,
            calls_failed=self._calls_failed,
            asr=round(asr, 2),
            avg_pdd_ms=round(_avg(self._pdd_samples), 2),
            min_pdd_ms=round(min(self._pdd_samples, default=0.0), 2),
            max_pdd_ms=round(max(self._pdd_samples, default=0.0), 2),
            avg_hold_ms=round(_avg(self._hold_samples), 2),
            avg_total_ms=round(_avg(self._total_samples), 2),
            socket_count=self._socket_count,
            registered_count=self._registered_count,
            subscribed_count=self._subscribed_count,
            run_elapsed_seconds=round(now - self._run_start, 1) if self._run_start else 0.0,
            running=self._running,
        )
        self._latest = snap
        return snap

    @property
    def latest(self) -> TrafficMetrics:
        return self._latest

    # ------------------------------------------------------------------
    # Periodic push task
    # ------------------------------------------------------------------

    async def run_push_loop(self) -> None:
        """
        Background task: rebuild snapshot every interval and push to all
        WebSocket subscribers.
        """
        while True:
            await asyncio.sleep(self._interval)
            async with self._lock:
                snap = self._build_snapshot()

            payload = json.dumps(snap.to_dict())
            dead = []
            for q in self._subscribers:
                try:
                    q.put_nowait(payload)
                except asyncio.QueueFull:
                    dead.append(q)
            for q in dead:
                self._subscribers.remove(q)

            log.debug(
                "Metrics: cps=%.2f concurrent=%d attempted=%d completed=%d failed=%d asr=%.1f%%",
                snap.cps_actual, snap.concurrent_calls,
                snap.calls_attempted, snap.calls_completed,
                snap.calls_failed, snap.asr,
            )

    def subscribe_ws(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=10)
        self._subscribers.append(q)
        return q

    def unsubscribe_ws(self, q: asyncio.Queue) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)


# ---------------------------------------------------------------------------
# FastAPI app factory
# ---------------------------------------------------------------------------

def build_app(
    collector: MetricsCollector,
    config,                    # VMConfig
    stop_callback: Optional[Callable] = None,
) -> Any:
    """
    Build and return the FastAPI application.

    Args:
        collector:      MetricsCollector instance.
        config:         VMConfig (for vm_id, role, ext ranges, etc.).
        stop_callback:  Async callable() to trigger graceful shutdown.
    """
    if not _FASTAPI_AVAILABLE:
        raise ImportError("fastapi and uvicorn must be installed")

    app = FastAPI(
        title="SBC Traffic Engine",
        description="Real-time SIP traffic metrics and control",
        version="1.0.0",
    )

    # ── GET /metrics ─────────────────────────────────────────────────────
    @app.get("/metrics")
    async def get_metrics():
        async with collector._lock:
            snap = collector._build_snapshot()
        return JSONResponse(content=snap.to_dict())

    # ── WS /metrics/stream ───────────────────────────────────────────────
    @app.websocket("/metrics/stream")
    async def metrics_stream(websocket: WebSocket):
        await websocket.accept()
        q = collector.subscribe_ws()
        try:
            while True:
                payload = await asyncio.wait_for(q.get(), timeout=30.0)
                await websocket.send_text(payload)
        except (WebSocketDisconnect, asyncio.TimeoutError):
            pass
        except Exception:
            log.exception("WebSocket error")
        finally:
            collector.unsubscribe_ws(q)

    # ── GET /api/test/status ─────────────────────────────────────────────
    @app.get("/api/test/status")
    async def test_status():
        snap = collector.latest
        return {
            "phase": snap.phase,
            "running": snap.running,
            "elapsed_seconds": snap.run_elapsed_seconds,
            "vm_id": snap.vm_id,
        }

    # ── POST /api/test/start ─────────────────────────────────────────────
    @app.post("/api/test/start")
    async def test_start(body: dict):
        # Config is read at startup from env/yaml. This endpoint is for
        # the GUI coordinator to push config overrides in future phases.
        return {"status": "accepted", "message": "Traffic engine controlled via CLI/env vars"}

    # ── POST /api/test/stop ──────────────────────────────────────────────
    @app.post("/api/test/stop")
    async def test_stop():
        if config.is_uas:
            log.info("Received API signal to stop from UAC — initiating graceful shutdown")
        if stop_callback:
            asyncio.create_task(stop_callback())
            return {"status": "stopping"}
        return {"status": "no_stop_callback_registered"}

    # ── GET /api/vms ─────────────────────────────────────────────────────
    @app.get("/api/vms")
    async def list_vms():
        snap = collector.latest
        return [
            {
                "vm_id": config.vm_id,
                "role": config.vm_role,
                "ext_range": (
                    f"{config.uac_ext_start}-{config.uac_ext_end}"
                    if config.is_uac
                    else f"{config.uas_ext_start}-{config.uas_ext_end}"
                ),
                "status": snap.phase,
                "cps": snap.cps_actual,
                "concurrent": snap.concurrent_calls,
                "registered": snap.registered_count,
                "asr": snap.asr,
            }
        ]

    return app


# ---------------------------------------------------------------------------
# Server startup helper
# ---------------------------------------------------------------------------

async def _serve_nofail(server: "uvicorn.Server") -> None:
    """
    Wrapper around server.serve() that converts SystemExit / OSError into a
    logged warning instead of crashing the entire process.
    """
    try:
        await server.serve()
    except (SystemExit, OSError) as exc:
        log.warning("Metrics HTTP server stopped unexpectedly: %s", exc)


async def start_server(
    collector: MetricsCollector,
    config,
    stop_callback: Optional[Callable] = None,
) -> "asyncio.Task | None":
    """
    Start the FastAPI/uvicorn server as an asyncio task.
    Returns the server task (or None if unavailable / port already in use).

    Tries config.metrics_port first, then auto-selects the next free port so
    that running two instances on the same machine never crashes either one.
    """
    if not _FASTAPI_AVAILABLE:
        log.warning("Metrics server not started: fastapi/uvicorn not installed")
        return None

    import socket as _socket

    # Find an available port starting from config.metrics_port
    port = config.metrics_port
    for _ in range(10):
        with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as _s:
            _s.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
            try:
                _s.bind(("0.0.0.0", port))
                break          # port is free
            except OSError:
                log.warning(
                    "Metrics port %d is in use (leftover process?), trying %d — "
                    "kill any stale traffic process to free the port",
                    port, port + 1,
                )
                port += 1
    else:
        log.warning(
            "Could not find a free metrics port near %d — metrics HTTP server disabled",
            config.metrics_port,
        )
        return None

    app = build_app(collector, config, stop_callback)

    # Push loop: send metrics to WebSocket subscribers every interval
    asyncio.create_task(
        collector.run_push_loop(),
        name="metrics-push-loop",
    )

    # Uvicorn server
    server_config = uvicorn.Config(
        app=app,
        host="0.0.0.0",
        port=port,
        log_level="warning",
        loop="none",   # use the existing asyncio event loop
    )
    server = uvicorn.Server(server_config)

    server_task = asyncio.create_task(
        _serve_nofail(server),
        name="metrics-http-server",
    )

    log.info(
        "Metrics server starting on http://0.0.0.0:%d "
        "| WS /metrics/stream | GET /metrics",
        port,
    )

    return server_task


# ---------------------------------------------------------------------------
# Traffic run summary (written to logs/ after run completes)
# ---------------------------------------------------------------------------

def write_traffic_summary(
    collector: MetricsCollector,
    config: "VMConfig",
    log_dir: str = "logs",
    engine=None,
    uas_engine=None,
    agents: Optional[dict[str, "ExtensionAgent"]] = None,
) -> str:
    """
    Write a summary of the traffic run to logs/traffic_summary_<vm_id>_<ts>.log.
    Returns the path of the written file.
    """
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    vm_id = config.vm_id
    path = os.path.join(log_dir, f"traffic_summary_{vm_id}_{ts}.log")
    os.makedirs(log_dir, exist_ok=True)

    results = getattr(collector, "_call_results", [])
    snap = collector.latest

    # SIP ephemeral ports (one per extension)
    sip_ports_used: list[int] = []
    sip_ports_by_ext: dict[str, int] = {}
    if agents:
        for ext, agent in agents.items():
            tp = getattr(agent, "_transport", None)
            port = tp.local_port if tp else getattr(agent, "_local_port", 0)
            if port:
                sip_ports_used.append(port)
                sip_ports_by_ext[ext] = port

    # RTP UDP ports (per call, created and closed)
    rtp_ports_used: list[int] = []
    rtp_ports_by_call: list[tuple[str, str, int]] = []  # (caller, callee, port)
    for r in results:
        port = getattr(r, "rtp_local_port", 0)
        if port and port != 9:
            rtp_ports_used.append(port)
            rtp_ports_by_call.append((getattr(r, "caller", "?"), getattr(r, "callee", "?"), port))

    # RTP media verification
    successful = [r for r in results if r.success]
    media_verified = sum(1 for r in successful if getattr(r, "media_verified", False))
    media_failed = sum(1 for r in successful if not getattr(r, "media_verified", False))
    media_total = len(successful)

    # Peak concurrent (UAC only)
    peak_concurrent = 0
    if engine and hasattr(engine, "_peak_active_calls"):
        peak_concurrent = engine._peak_active_calls

    # UAC-to-UAS pairings per pool wrap
    pairings_by_wrap: dict[int, list[tuple[str, str]]] = {}
    for r in results:
        wrap = getattr(r, "pool_wrap_index", 0)
        caller = getattr(r, "caller", "?")
        callee = getattr(r, "callee", "?")
        if caller != "remote":  # UAC-initiated
            pairings_by_wrap.setdefault(wrap, []).append((caller, callee))

    lines: list[str] = []
    lines.append("=" * 70)
    lines.append(f"TRAFFIC RUN SUMMARY — {vm_id} — {config.vm_role}")
    lines.append(f"Timestamp: {datetime.datetime.now().isoformat()}")
    lines.append("=" * 70)
    lines.append("")
    lines.append("--- Overall metrics ---")
    lines.append(f"  calls_attempted:  {snap.calls_attempted}")
    lines.append(f"  calls_completed:  {snap.calls_completed}")
    lines.append(f"  calls_failed:     {snap.calls_failed}")
    lines.append(f"  ASR:              {snap.asr:.1f}%")
    lines.append(f"  avg_pdd_ms:       {snap.avg_pdd_ms:.2f}")
    lines.append(f"  avg_hold_ms:      {snap.avg_hold_ms:.2f}")
    lines.append(f"  avg_total_ms:     {snap.avg_total_ms:.2f}")
    if peak_concurrent > 0:
        lines.append(f"  peak_concurrent:  {peak_concurrent}")
    lines.append("")
    lines.append("--- RTP media verification ---")
    lines.append(f"  MEDIA_VERIFIED:   {media_verified} / {media_total} successful calls")
    if media_failed > 0:
        lines.append(f"  MEDIA_FAILED:     {media_failed}")
    lines.append("")
    lines.append("--- Ephemeral SIP ports (used and closed by extensions) ---")
    if sip_ports_by_ext:
        for ext, port in sorted(sip_ports_by_ext.items(), key=lambda x: int(x[0])):
            lines.append(f"  ext {ext}: port {port}")
    else:
        lines.append("  (none recorded)")
    lines.append("")
    lines.append("--- UDP RTP ports (created and closed per call) ---")
    if rtp_ports_by_call:
        for caller, callee, port in rtp_ports_by_call[:50]:  # limit for readability
            lines.append(f"  {caller} -> {callee}: port {port}")
        if len(rtp_ports_by_call) > 50:
            lines.append(f"  ... and {len(rtp_ports_by_call) - 50} more")
    else:
        lines.append("  (none recorded)")
    lines.append("")
    if pairings_by_wrap:
        lines.append("--- UAC-to-UAS call pairings by pool wrap ---")
        for wrap in sorted(pairings_by_wrap.keys()):
            lines.append(f"  Wrap {wrap + 1}:")
            for caller, callee in pairings_by_wrap[wrap]:
                lines.append(f"    {caller} -> {callee}")
    lines.append("")
    lines.append("--- Config ---")
    lines.append(f"  cps: {config.cps}  hold_time_seconds: {config.hold_time_seconds}")
    lines.append(f"  uac_ext: {config.uac_ext_start}-{config.uac_ext_end}")
    lines.append(f"  uas_ext: {config.uas_ext_start}-{config.uas_ext_end}")
    lines.append("=" * 70)

    content = "\n".join(lines)
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        log.info("Traffic summary written to %s", path)
    except OSError as exc:
        log.warning("Could not write traffic summary: %s", exc)

    return path
