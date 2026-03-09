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
import json
import logging
import time
from dataclasses import dataclass, field, asdict
from typing import Optional, Callable, Any

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

        snap = TrafficMetrics(
            timestamp=time.time(),
            vm_id=self._vm_id,
            phase=self._phase,
            cps_actual=round(cps_actual, 3),
            concurrent_calls=self._concurrent_calls,
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
                    "Metrics port %d is in use, trying %d", port, port + 1
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
