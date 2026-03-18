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


# ---------------------------------------------------------------------------
# ProcessContext — shared mutable state for GUI-driven (--api-only) mode
# ---------------------------------------------------------------------------

class ProcessContext:
    """
    Holds mutable state shared between the FastAPI endpoints and the
    traffic lifecycle when running in GUI-driven (--api-only) mode.
    """

    def __init__(
        self,
        collector: "MetricsCollector",
        stop_event: "asyncio.Event",
        port: int,
    ) -> None:
        self.collector = collector
        self.stop_event = stop_event              # signals traffic lifecycle to stop
        self.process_exit_event = asyncio.Event() # signals process to exit (Ctrl+C, /api/shutdown)
        self.port = port
        self.config: Optional[Any] = None        # set by PUT /api/config
        self.state: str = "IDLE"                  # IDLE → CONFIGURED → RUNNING → COMPLETE / FAILED
        self.yaml_path: Optional[str] = None      # path to generated yaml
        self.log_level: str = "INFO"
        self.run_id: str = ""                     # set by POST /api/test/start body
        self.pair_id: str = ""                    # set by POST /api/test/start body
        self._lifecycle_task: Optional[asyncio.Task] = None
        self._start_func: Optional[Callable] = None   # injected by main.py

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
    cps_actual: float         = 0.0            # calls launched in last interval / interval (true throughput rate)
    concurrent_calls: int     = 0              # active calls in-flight (GUI label: "Active Calls")
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

        # Windowed (last interval) for CPS calculation — counts launches, not completions
        self._window_start = time.monotonic()
        self._window_attempts = 0

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

    def record_attempt(self) -> None:
        """Called at the moment a call is launched (before it completes). Used for CPS display."""
        self._window_attempts += 1

    async def record_call(self, result) -> None:
        """
        Accept a CallResult from call_engine and update metrics.
        `result` has: success, pdd_ms, hold_ms, total_ms attributes.
        """
        async with self._lock:
            self._call_results.append(result)
            self._calls_attempted += 1
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

        # CPS: calls launched (attempted) in last window / window duration
        cps_actual = self._window_attempts / window_elapsed if window_elapsed > 0 else 0.0

        # Reset window
        self._window_start = now
        self._window_attempts = 0

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

    async def reset(self) -> None:
        """Clear all accumulated metrics state so a new run starts from zero."""
        async with self._lock:
            self._calls_attempted = 0
            self._calls_completed = 0
            self._calls_failed = 0
            self._pdd_samples.clear()
            self._hold_samples.clear()
            self._total_samples.clear()
            self._window_start = time.monotonic()
            self._window_attempts = 0
            self._concurrent_calls = 0
            self._socket_count = 0
            self._registered_count = 0
            self._subscribed_count = 0
            self._phase = "IDLE"
            self._run_start = 0.0
            self._running = False
            self._call_results.clear()
            self._concurrent_provider = None
            self._vm_id = "unconfigured"
            self._latest = TrafficMetrics(vm_id="unconfigured")


# ---------------------------------------------------------------------------
# FastAPI app factory
# ---------------------------------------------------------------------------

def build_app(
    collector: MetricsCollector,
    config,                    # VMConfig — may be None in api-only mode
    stop_callback: Optional[Callable] = None,
    process_ctx: Optional["ProcessContext"] = None,
) -> Any:
    """
    Build and return the FastAPI application.

    Args:
        collector:      MetricsCollector instance.
        config:         VMConfig (for vm_id, role, ext ranges, etc.).
                        May be None when started in --api-only mode (GUI-driven).
        stop_callback:  Async callable() to trigger graceful shutdown.
        process_ctx:    ProcessContext for GUI-driven mode (--api-only).
                        When set, PUT /api/config and POST /api/test/start are live.
    """
    if not _FASTAPI_AVAILABLE:
        raise ImportError("fastapi and uvicorn must be installed")

    app = FastAPI(
        title="SBC Traffic Engine",
        description="Real-time SIP traffic metrics and control",
        version="1.0.0",
    )

    from fastapi.middleware.cors import CORSMiddleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["*"],
    )

    def _effective_config():
        """Return the current config — from process_ctx (GUI-driven) or startup config (CLI)."""
        if process_ctx and process_ctx.config:
            return process_ctx.config
        return config

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

    # ── GET /api/ping ─────────────────────────────────────────────────────
    @app.get("/api/ping")
    async def ping():
        """
        Lightweight health check used by the GUI reachability indicator.
        Returns role:'unconfigured' when started with --api-only and no config pushed yet.
        """
        cfg = _effective_config()
        if cfg:
            return {
                "reachable": True,
                "vm_id": cfg.vm_id,
                "role": cfg.vm_role,
                "phase": collector.latest.phase,
                "state": process_ctx.state if process_ctx else "CLI",
            }
        return {
            "reachable": True,
            "vm_id": "unconfigured",
            "role": "unconfigured",
            "phase": collector.latest.phase,
            "state": process_ctx.state if process_ctx else "IDLE",
        }

    # ── GET /api/test/status ─────────────────────────────────────────────
    @app.get("/api/test/status")
    async def test_status():
        snap = collector.latest
        cfg = _effective_config()
        return {
            "phase": snap.phase,
            "running": snap.running,
            "elapsed_seconds": snap.run_elapsed_seconds,
            "vm_id": cfg.vm_id if cfg else "unconfigured",
            "state": process_ctx.state if process_ctx else "CLI",
        }

    # ── PUT /api/config ──────────────────────────────────────────────────
    @app.put("/api/config")
    async def put_config(body: dict):
        """
        Receive VM config from the GUI, validate it, write a YAML file,
        and store it on the ProcessContext.  Does NOT create agents or
        start transports — that happens on POST /api/test/start.
        """
        if not process_ctx:
            return JSONResponse(
                status_code=400,
                content={"error": "Config push not supported in CLI mode — use YAML files"},
            )

        if process_ctx.state == "RUNNING":
            return JSONResponse(
                status_code=409,
                content={"error": "Cannot push config while traffic is running"},
            )

        from .config import config_from_dict, write_config_yaml

        try:
            cfg = config_from_dict(body)
        except (ValueError, TypeError) as exc:
            return JSONResponse(status_code=422, content={"error": str(exc)})

        yaml_filename = f"{cfg.vm_role.lower()}.yaml"
        try:
            yaml_path = write_config_yaml(cfg, yaml_filename)
        except Exception as exc:
            return JSONResponse(status_code=500, content={"error": f"Failed to write YAML: {exc}"})

        process_ctx.config = cfg
        process_ctx.yaml_path = yaml_path
        process_ctx.state = "CONFIGURED"

        collector._vm_id = cfg.vm_id
        # Apply the configured push cadence immediately — run_push_loop re-reads
        # self._interval on each iteration, so this takes effect on the next tick.
        collector._interval = cfg.metrics_interval
        collector._latest = collector._build_snapshot()

        log.info(
            "Config received from GUI: role=%s vm_id=%s ext=%d-%d → %s",
            cfg.vm_role, cfg.vm_id,
            cfg.uac_ext_start if cfg.is_uac else cfg.uas_ext_start,
            cfg.uac_ext_end if cfg.is_uac else cfg.uas_ext_end,
            yaml_path,
        )

        return {
            "status": "configured",
            "vm_id": cfg.vm_id,
            "role": cfg.vm_role,
            "yaml_path": yaml_path,
        }

    # ── POST /api/test/start ─────────────────────────────────────────────
    @app.post("/api/test/start")
    async def test_start(body: dict | None = None):
        """
        Trigger the full traffic lifecycle (agents → pre-phase → traffic)
        as a background asyncio task.  Returns 202 immediately.
        Body must include run_id and pair_id (required for log file naming).
        """
        if process_ctx:
            payload = body or {}
            run_id = payload.get("run_id")
            pair_id = payload.get("pair_id")
            if not run_id or not pair_id:
                return JSONResponse(
                    status_code=400,
                    content={
                        "error": "run_id and pair_id are required in request body",
                        "example": {"run_id": "run-20260318_113204", "pair_id": "pair-1"},
                    },
                )
            if process_ctx.state == "RUNNING":
                return JSONResponse(
                    status_code=409,
                    content={"error": "Traffic is already running"},
                )
            if process_ctx.state != "CONFIGURED":
                return JSONResponse(
                    status_code=400,
                    content={"error": f"Cannot start: state is '{process_ctx.state}', expected 'CONFIGURED'. Push config first via PUT /api/config."},
                )
            if not process_ctx._start_func:
                return JSONResponse(
                    status_code=500,
                    content={"error": "Lifecycle starter not registered — internal error"},
                )

            process_ctx.run_id = run_id
            process_ctx.pair_id = pair_id
            process_ctx.state = "RUNNING"
            await process_ctx._start_func()
            log.info("Traffic lifecycle started via API for %s (run_id=%s)", process_ctx.config.vm_id, run_id)
            return JSONResponse(
                status_code=202,
                content={"status": "started", "vm_id": process_ctx.config.vm_id},
            )

        # CLI mode fallback (existing behavior)
        return {"status": "accepted", "message": "Traffic engine controlled via CLI/env vars"}

    # ── POST /api/test/stop ──────────────────────────────────────────────
    @app.post("/api/test/stop")
    async def test_stop():
        """
        Stop the traffic lifecycle (SIP cleanup) but keep the process alive.
        The metrics server continues serving so the GUI can fetch final data
        and a new run can be started via /api/test/reset + /api/test/start.
        """
        if process_ctx:
            cfg = _effective_config()
            if cfg and cfg.is_uas:
                log.info("Received API signal to stop from UAC — stopping traffic lifecycle")
            process_ctx.stop_event.set()
            return {"status": "stopping", "state": process_ctx.state}

        # CLI mode — stop_callback triggers full shutdown (original behavior)
        if stop_callback:
            asyncio.create_task(stop_callback())
            return {"status": "stopping"}
        return {"status": "no_stop_callback_registered"}

    # ── POST /api/test/reset ────────────────────────────────────────────
    @app.post("/api/test/reset")
    async def test_reset():
        """
        Reset state from COMPLETE/FAILED → IDLE so a new run can begin.
        Clears metrics, config, and the stop event.  The process stays alive.
        """
        if not process_ctx:
            return JSONResponse(
                status_code=400,
                content={"error": "Reset not supported in CLI mode"},
            )
        if process_ctx.state == "RUNNING":
            return JSONResponse(
                status_code=409,
                content={"error": "Cannot reset while traffic is running — stop first"},
            )
        if process_ctx.state not in ("COMPLETE", "FAILED", "CONFIGURED"):
            return JSONResponse(
                status_code=400,
                content={"error": f"Nothing to reset: state is '{process_ctx.state}'"},
            )

        process_ctx.state = "IDLE"
        process_ctx.config = None
        process_ctx.yaml_path = None
        process_ctx._lifecycle_task = None
        process_ctx.stop_event.clear()

        await collector.reset()

        log.info("State reset to IDLE — ready for new config push")
        return {"status": "reset", "state": "IDLE"}

    # ── POST /api/shutdown ────────────────────────────────────────────
    @app.post("/api/shutdown")
    async def shutdown():
        """
        Gracefully shut down the entire process: stop traffic (if running),
        drain, then exit.  Use Ctrl+C for the same effect from the terminal.
        """
        if process_ctx:
            log.info("Shutdown requested via API — stopping traffic and exiting process")
            process_ctx.stop_event.set()
            process_ctx.process_exit_event.set()
            return JSONResponse(
                status_code=202,
                content={"status": "shutting_down", "state": process_ctx.state},
            )

        # CLI mode
        if stop_callback:
            asyncio.create_task(stop_callback())
            return JSONResponse(status_code=202, content={"status": "shutting_down"})
        return JSONResponse(status_code=400, content={"error": "Shutdown not supported"})

    # ── GET /api/calls ────────────────────────────────────────────────────
    @app.get("/api/calls")
    async def get_calls():
        """Return call results collected so far as a JSON array matching the
        GUI CallEvent type.  Available from the moment the first call completes
        and keeps growing until the process exits."""
        import datetime as _dt

        results = getattr(collector, "_call_results", getattr(collector, "call_results", []))
        out = []
        for i, r in enumerate(results):
            media = "NO_MEDIA"
            if getattr(r, "media_verified", False):
                media = "MEDIA_VERIFIED"
            elif getattr(r, "rtp_tx_pkts", 0) > 0 or getattr(r, "rtp_rx_pkts", 0) > 0:
                media = "MEDIA_PARTIAL"

            ts_raw = getattr(r, "timestamp", getattr(r, "end_time", None))
            if hasattr(ts_raw, "isoformat"):
                ts = ts_raw.isoformat()
            elif ts_raw:
                ts = str(ts_raw)
            else:
                ts = _dt.datetime.now().isoformat()

            out.append({
                "call_id": getattr(r, "call_id", f"call-{i:04d}"),
                "uac_ext": str(getattr(r, "caller", getattr(r, "uac_ext", ""))),
                "uas_ext": str(getattr(r, "callee", getattr(r, "uas_ext", ""))),
                "result": "COMPLETED" if getattr(r, "success", False) else "FAILED",
                "failure_reason": getattr(r, "failure_reason", None) or None,
                "pdd_ms": float(getattr(r, "pdd_ms", 0) or 0),
                "hold_ms": float(getattr(r, "hold_ms", 0) or 0),
                "media_status": media,
                "rtp_tx_pkts": getattr(r, "rtp_tx_pkts", None),
                "rtp_rx_pkts": getattr(r, "rtp_rx_pkts", None),
                "timestamp": ts,
            })
        return out

    # ── GET /api/vms ─────────────────────────────────────────────────────
    @app.get("/api/vms")
    async def list_vms():
        snap = collector.latest
        cfg = _effective_config()
        if not cfg:
            return [{"vm_id": "unconfigured", "role": "unconfigured", "status": snap.phase}]
        return [
            {
                "vm_id": cfg.vm_id,
                "role": cfg.vm_role,
                "ext_range": (
                    f"{cfg.uac_ext_start}-{cfg.uac_ext_end}"
                    if cfg.is_uac
                    else f"{cfg.uas_ext_start}-{cfg.uas_ext_end}"
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
    # uvicorn 0.30+ installs its own SIGINT/SIGTERM handlers inside serve() via
    # a capture_signals() context manager.  On Windows this overrides our lambda
    # (set in main.py) so uvicorn's handle_exit fires on Ctrl+C instead of ours,
    # shuts the server down, and server_task.done() is True by the time the
    # GUI-drain window check runs — skipping the drain entirely.
    # Replacing capture_signals with contextlib.nullcontext keeps our asyncio
    # signal handlers in full control; we cancel server_task explicitly after
    # the drain window instead.
    import contextlib as _contextlib
    server.capture_signals = _contextlib.nullcontext  # type: ignore[method-assign]

    server_task = asyncio.create_task(
        _serve_nofail(server),
        name="metrics-http-server",
    )

    log.info(
        "Metrics server starting on http://0.0.0.0:%d "
        "| GET /metrics | GET /api/ping | WS /metrics/stream",
        port,
    )

    return server_task


# ---------------------------------------------------------------------------
# API-only server startup (GUI-driven mode — no VMConfig at startup)
# ---------------------------------------------------------------------------

async def start_api_only_server(
    ctx: "ProcessContext",
    stop_callback: Optional[Callable] = None,
) -> "asyncio.Task | None":
    """
    Start FastAPI server for --api-only mode.  No VMConfig is needed at
    startup — config arrives later via PUT /api/config.
    """
    if not _FASTAPI_AVAILABLE:
        log.warning("Metrics server not started: fastapi/uvicorn not installed")
        return None

    import socket as _socket

    port = ctx.port
    for _ in range(10):
        with _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM) as _s:
            _s.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 1)
            try:
                _s.bind(("0.0.0.0", port))
                break
            except OSError:
                log.warning("Port %d in use, trying %d", port, port + 1)
                port += 1
    else:
        log.warning("Could not find a free port near %d", ctx.port)
        return None

    ctx.port = port

    app = build_app(
        ctx.collector, config=None,
        stop_callback=stop_callback,
        process_ctx=ctx,
    )

    asyncio.create_task(ctx.collector.run_push_loop(), name="metrics-push-loop")

    server_config = uvicorn.Config(
        app=app, host="0.0.0.0", port=port,
        log_level="warning", loop="none",
    )
    server = uvicorn.Server(server_config)
    # Same rationale as start_server: replace uvicorn's capture_signals() with a
    # no-op so our asyncio signal handlers stay in control and the GUI-drain
    # window runs reliably after Ctrl+C on both Linux and Windows.
    import contextlib as _contextlib
    server.capture_signals = _contextlib.nullcontext  # type: ignore[method-assign]
    server_task = asyncio.create_task(_serve_nofail(server), name="metrics-http-server")

    log.info(
        "API-only server on http://0.0.0.0:%d "
        "| PUT /api/config | POST /api/test/start | GET /api/ping",
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
    run_id: str = "",
    pair_id: str = "",
    engine=None,
    uas_engine=None,
    agents: Optional[dict[str, "ExtensionAgent"]] = None,
) -> str:
    """
    Write a summary of the traffic run to logs/traffic_summary_<run_id>_<pair_id>_<vm_id>.log.
    Returns the path of the written file.
    """
    vm_id = config.vm_id
    path = os.path.join(log_dir, f"traffic_summary_{run_id}_{pair_id}_{vm_id}.log")
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
