"""
traffic/main.py
===============
Entrypoint for the SIP traffic engine.

Usage:
  python -m callflow_tool.traffic.main [--config config.yaml]

  All settings can also be supplied via environment variables.
  ENV VARS override YAML values.
  See config.py for the full variable list.

Startup sequence:
  1. Load VMConfig (env → yaml → defaults)
  2. Resolve local IP
  3. Create ExtensionAgent instances (one per extension)
  4. Start all transports
  5. Start metrics server (FastAPI on config.metrics_port)
  6. Run pre-phase: REGISTER + SUBSCRIBE (barriers)
  7. If UAC: start CallEngine.run()
     If UAS: start UasAutoAnswer.start()
  8. Block until SIGTERM/SIGINT or stop event
  9. Graceful shutdown:
       a. Stop call engine (no new INVITEs)
       b. Drain active calls (BYE + 200 OK, 5s timeout)
       c. Unregister all extensions
       d. Close all transports
       e. Flush final metrics
       f. Exit 0
"""

from __future__ import annotations

import argparse
import asyncio
import datetime
import logging
import logging.handlers
import math
import os
import signal
import sys
import time
from urllib.parse import urlparse, urlunparse

try:
    import requests
    _REQUESTS_AVAILABLE = True
except ImportError:
    _REQUESTS_AVAILABLE = False

# ---------------------------------------------------------------------------
# Configure structured logging: console + rotating file
# ---------------------------------------------------------------------------

_LOG_FMT  = "%(asctime)s %(levelname)-8s %(name)-35s %(message)s"
_DATE_FMT = "%Y-%m-%dT%H:%M:%S"


def _setup_logging(level: str = "INFO", log_file: str = "") -> None:
    """
    Configure root logger with:
      - StreamHandler (console) at the requested level
      - RotatingFileHandler (file) at DEBUG — captures everything for post-run analysis
    If log_file is empty no file handler is added (e.g. during pre-config startup).
    """
    numeric = getattr(logging, level.upper(), logging.INFO)
    root = logging.getLogger()
    root.setLevel(logging.DEBUG)          # root must pass DEBUG; handlers filter

    # Remove any handlers added by a previous call (e.g. early bootstrap call)
    for h in list(root.handlers):
        root.removeHandler(h)
        h.close()

    console = logging.StreamHandler(sys.stdout)
    console.setLevel(numeric)
    console.setFormatter(logging.Formatter(_LOG_FMT, datefmt=_DATE_FMT))
    root.addHandler(console)

    if log_file:
        log_dir = os.path.dirname(log_file)
        if log_dir:
            os.makedirs(log_dir, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(
            log_file,
            maxBytes=20 * 1024 * 1024,   # 20 MB per file
            backupCount=5,
            encoding="utf-8",
        )
        fh.setLevel(logging.DEBUG)        # file always captures DEBUG+
        fh.setFormatter(logging.Formatter(_LOG_FMT, datefmt=_DATE_FMT))
        root.addHandler(fh)
        logging.getLogger("traffic.main").info(
            "Log file: %s (DEBUG+)", log_file
        )


def _auto_log_file(vm_id: str, log_dir: str = "logs") -> str:
    """Generate a timestamped log file path: logs/traffic_<vm_id>_YYYYMMDD_HHMMSS.log"""
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    return os.path.join(log_dir, f"traffic_{vm_id}_{ts}.log")


# Bootstrap console-only logging until config (and vm_id) are available.
_setup_logging(os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger("traffic.main")

# ---------------------------------------------------------------------------
# Local imports
# ---------------------------------------------------------------------------

from .config import load_config, VMConfig
from .extension_agent import ExtensionAgent
from .pre_phase import run_pre_phase
from .call_engine import CallEngine, UasAutoAnswer
from .metrics import (
    MetricsCollector, start_server, start_api_only_server,
    write_traffic_summary, ProcessContext,
)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="python -m callflow_tool.traffic.main",
        description="SBC SIP Traffic Engine — asyncio-native CPS load generator",
    )
    p.add_argument(
        "--config", "-c",
        metavar="PATH",
        default=os.environ.get("TRAFFIC_CONFIG", ""),
        help="Path to YAML config file (default: $TRAFFIC_CONFIG or none)",
    )
    p.add_argument(
        "--log-level",
        default=os.environ.get("LOG_LEVEL", "INFO"),
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging verbosity",
    )
    p.add_argument(
        "--skip-subscribe",
        action="store_true",
        default=os.environ.get("SKIP_SUBSCRIBE", "").lower() in ("1", "true", "yes"),
        help="Skip SUBSCRIBE pre-phase (use for environments without dialog subscription)",
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Load config and validate, then exit without starting traffic",
    )
    p.add_argument(
        "--log-file",
        metavar="PATH",
        default=os.environ.get("LOG_FILE", ""),
        help=(
            "Write logs to this file (DEBUG level). "
            "Auto-generated as logs/traffic_<vm_id>_<timestamp>.log if not set."
        ),
    )
    p.add_argument(
        "--log-dir",
        metavar="DIR",
        default=os.environ.get("LOG_DIR", "logs"),
        help="Directory for auto-generated log files (default: logs/)",
    )
    p.add_argument(
        "--max-calls",
        type=int,
        default=int(os.environ.get("MAX_CALLS", "0")),
        metavar="N",
        help=(
            "CLI override: stop UAC after exactly N call attempts. "
            "Takes priority over traffic_mode in the YAML config. "
            "0 = derive from YAML traffic_mode (smoke/timed) or run unlimited."
        ),
    )
    p.add_argument(
        "--pre-phase-only",
        action="store_true",
        default=os.environ.get("PRE_PHASE_ONLY", "").lower() in ("1", "true", "yes"),
        help="Run REGISTER + SUBSCRIBE only, then wait for Ctrl+C (no calls sent)",
    )
    p.add_argument(
        "--no-unregister",
        action="store_true",
        default=os.environ.get("NO_UNREGISTER", "").lower() in ("1", "true", "yes"),
        help="Skip REGISTER(Expires:0) unregistration on shutdown (leave extensions registered)",
    )
    p.add_argument(
        "--api-only",
        action="store_true",
        default=os.environ.get("API_ONLY", "").lower() in ("1", "true", "yes"),
        help=(
            "Start the FastAPI metrics server only — no SIP agents, no REGISTER, no traffic. "
            "When used without --config, the server waits for config via PUT /api/config "
            "and traffic start via POST /api/test/start (GUI-driven mode). "
            "When used with --config, starts the server for health-check only."
        ),
    )
    p.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("API_PORT", "0")),
        metavar="PORT",
        help=(
            "Port for the FastAPI server when running --api-only without --config. "
            "E.g. --api-only --port 8081 for UAS, --api-only --port 8082 for UAC."
        ),
    )
    p.add_argument(
        "--gui-drain-seconds",
        type=int,
        default=int(os.environ.get("GUI_DRAIN_SECONDS", "15")),
        metavar="N",
        help=(
            "After SIP cleanup, keep the metrics HTTP server alive for N seconds "
            "so the GUI can fetch final metrics and call events. "
            "Set to 0 for headless/CI runs where no GUI is attached. (default: 15)"
        ),
    )
    return p.parse_args()


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------

def _create_agents(config: VMConfig) -> dict[str, ExtensionAgent]:
    """
    Create one ExtensionAgent per extension in this VM's range.

    UAC VM: creates agents for uac_ext_start..uac_ext_end
    UAS VM: creates agents for uas_ext_start..uas_ext_end
    """
    agents: dict[str, ExtensionAgent] = {}

    if config.is_uac:
        ext_range = range(config.uac_ext_start, config.uac_ext_end + 1)
        log.info(
            "Creating %d UAC agents (ext %d–%d)",
            len(ext_range), config.uac_ext_start, config.uac_ext_end,
        )
    else:
        ext_range = range(config.uas_ext_start, config.uas_ext_end + 1)
        log.info(
            "Creating %d UAS agents (ext %d–%d)",
            len(ext_range), config.uas_ext_start, config.uas_ext_end,
        )

    for ext_num in ext_range:
        ext = str(ext_num)
        agents[ext] = ExtensionAgent(ext, config)

    return agents


# ---------------------------------------------------------------------------
# Main coroutine
# ---------------------------------------------------------------------------

async def run(
    config: VMConfig,
    skip_subscribe: bool = False,
    max_calls: int = 0,
    pre_phase_only: bool = False,
    no_unregister: bool = False,
    api_only: bool = False,
    gui_drain_seconds: int = 15,
) -> int:
    """
    Full lifecycle coroutine. Returns exit code (0 = success).

    When api_only=True the FastAPI server is started and the process waits
    for SIGTERM/SIGINT.  No SIP sockets, REGISTER, or traffic are created.
    This lets the GUI health-check (GET /api/ping) confirm the backend is
    reachable before the operator starts the real traffic run.

    gui_drain_seconds:  After SIP cleanup completes, keep the metrics HTTP
        server alive for this many seconds so the GUI can fetch final
        metrics, call events, and status.  Set to 0 for headless/CI runs.
    """
    overall_start = time.monotonic()
    stop_event = asyncio.Event()

    # ── Signal handlers ───────────────────────────────────────────────────
    loop = asyncio.get_event_loop()

    def _handle_signal(sig):
        log.info("Received signal %s, initiating graceful shutdown…", sig.name)
        stop_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handle_signal, sig)
        except NotImplementedError:
            # Windows: loop.add_signal_handler is not available; use signal.signal
            # with call_soon_threadsafe so _handle_signal is invoked safely inside
            # the running event loop (enabling the log message and reliable wakeup).
            signal.signal(sig, lambda s, f, _sig=sig: loop.call_soon_threadsafe(_handle_signal, _sig))

    # ── Metrics collector ─────────────────────────────────────────────────
    collector = MetricsCollector(config.vm_id, config.metrics_interval)
    collector.set_phase("INIT")

    async def _stop_callback() -> None:
        stop_event.set()

    # ── Start metrics HTTP server ─────────────────────────────────────────
    server_task = await start_server(
        collector, config, stop_callback=_stop_callback
    )

    # ── API-ONLY mode: server is up, skip all SIP work ────────────────────
    if api_only:
        role = "UAC" if config.is_uac else "UAS"
        log.info("=" * 60)
        log.info(
            "API-ONLY mode (%s) — FastAPI server running on :%d",
            role, config.metrics_port,
        )
        log.info("GET /api/ping  → { reachable: true }")
        log.info("No SIP agents, REGISTER, or traffic will be started.")
        log.info("Press Ctrl+C or POST /api/test/stop to exit.")
        log.info("=" * 60)
        await stop_event.wait()
        if server_task and not server_task.done():
            server_task.cancel()
            try:
                await asyncio.wait_for(server_task, timeout=3.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass
        log.info("API-ONLY shutdown complete")
        return 0

    # ── Create agents ─────────────────────────────────────────────────────
    agents = _create_agents(config)
    log.info("Starting %d extension agent transports…", len(agents))

    # Start all transports concurrently
    await asyncio.gather(*[a.start() for a in agents.values()])
    collector.update_counts(sockets=len(agents))
    log.info("All transports connected")

    # ── PRE-PHASE: REGISTER + SUBSCRIBE ──────────────────────────────────
    collector.set_phase("PRE_REGISTER")

    try:
        pre_result = await run_pre_phase(
            list(agents.values()),
            config,
            skip_subscribe=skip_subscribe,
        )
    except RuntimeError as exc:
        log.critical("Pre-phase failed: %s", exc)
        await _shutdown(agents, None, None, collector, server_task, config, no_unregister=no_unregister)
        await _cancel_server(server_task)
        return 1

    collector.update_counts(
        sockets=len(agents),
        registered=pre_result.registered,
        subscribed=pre_result.subscribed,
    )

    # ── PRE-PHASE-ONLY: stop here, keep registrations alive ──────────────
    if pre_phase_only:
        role = "UAC" if config.is_uac else "UAS"
        log.info("=" * 60)
        log.info(
            "PRE-PHASE-ONLY mode (%s) — REGISTER + SUBSCRIBE complete. "
            "Extensions are registered and subscribed. Press Ctrl+C to unregister and exit.",
            role,
        )
        log.info("=" * 60)
        collector.set_phase("READY_PRE_PHASE_ONLY")
        await stop_event.wait()
        await _shutdown(agents, None, None, collector, server_task, config, no_unregister=no_unregister)
        await _cancel_server(server_task)
        return 0

    # ── TRAFFIC PHASE ─────────────────────────────────────────────────────
    collector.set_phase("TRAFFIC")
    collector.set_running(True)
    engine = None
    uas_engine = None

    if config.is_uac:
        engine = CallEngine(
            agents, config,
            on_call_complete=collector.record_call,
            max_calls=max_calls,
        )
        collector.set_concurrent_provider(lambda: engine.active_call_count)
        log.info(
            "UAC mode | %d CPS | %ds hold | ~%d concurrent | ramp=%ds",
            config.cps, config.hold_time_seconds,
            config.effective_max_concurrent, config.ramp_up_seconds,
        )

        # Run engine until stop_event or KeyboardInterrupt
        engine_task = asyncio.create_task(engine.run(), name="call-engine")
        stop_waiter = asyncio.create_task(stop_event.wait(), name="stop-waiter")

        done, pending = await asyncio.wait(
            [engine_task, stop_waiter],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

    else:
        # UAS mode: start auto-answer on all agents
        uas_engine = UasAutoAnswer(
            agents, config, on_call_complete=collector.record_call
        )
        await uas_engine.start()
        log.info("UAS auto-answer mode active on %d extensions", len(agents))

        # Wait for stop signal
        await stop_event.wait()

    # ── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────
    collector.set_phase("STOPPING")
    collector.set_running(False)
    log.info("Initiating graceful shutdown…")

    await _shutdown(agents, engine, uas_engine, collector, server_task, config, no_unregister=no_unregister)

    elapsed = time.monotonic() - overall_start
    snap = collector.latest
    log.info(
        "=" * 60 + "\nRUN COMPLETE in %.1fs | attempted=%d completed=%d failed=%d ASR=%.1f%%\n" + "=" * 60,
        elapsed, snap.calls_attempted, snap.calls_completed, snap.calls_failed, snap.asr,
    )

    # ── GUI DRAIN DELAY ──────────────────────────────────────────────────
    # Keep the metrics HTTP server alive so the GUI can fetch final data:
    #   GET /metrics       → final snapshot (10/10 calls, ASR, etc.)
    #   GET /api/calls     → all call event detail rows
    #   GET /api/test/status → phase=DONE
    # Second Ctrl+C during the delay → immediate exit.
    if gui_drain_seconds > 0 and server_task and not server_task.done():
        log.info(
            "GUI drain: keeping metrics server alive for %ds "
            "(phase=DONE, all endpoints serving final data)…",
            gui_drain_seconds,
        )
        try:
            await asyncio.sleep(gui_drain_seconds)
        except asyncio.CancelledError:
            log.info("GUI drain interrupted — exiting immediately")

    # ── Cancel metrics server ─────────────────────────────────────────────
    if server_task and not server_task.done():
        server_task.cancel()
        try:
            await asyncio.wait_for(server_task, timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    return 0


def _post_peer_stop(peer_url: str, fallback_ports: tuple[int, ...] = (8081, 8082, 8083)) -> None:
    """
    POST to peer_stop_url to signal UAS shutdown.
    Tries configured port first, then 8081, 8082, 8083 (UAS may have bound to a different port if configured port was in use).
    """
    parsed = urlparse(peer_url)
    try:
        port = int(parsed.port or 8081)
    except (TypeError, ValueError):
        port = 8081
    # Build list: [configured_port] + fallbacks (avoid duplicates, preserve order)
    seen = {port}
    ports_to_try = [port]
    for p in fallback_ports:
        if p not in seen:
            seen.add(p)
            ports_to_try.append(p)
    for p in ports_to_try:
        url = urlunparse(parsed._replace(netloc=f"{parsed.hostname or 'localhost'}:{p}"))
        try:
            log.info("Signaling UAS shutdown — POST %s", url)
            requests.post(url, timeout=3)
            return  # one success is enough
        except Exception as exc:
            log.debug("POST %s failed: %s", url, exc)
    log.warning("POST to peer_stop_url failed on all ports %s (UAS may need manual stop)", ports_to_try)


async def _cancel_server(server_task) -> None:
    """Cancel the metrics HTTP server task (used for early-exit paths)."""
    if server_task and not server_task.done():
        server_task.cancel()
        try:
            await asyncio.wait_for(server_task, timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass


async def _shutdown(
    agents: dict[str, ExtensionAgent],
    engine: "CallEngine | None",
    uas_engine: "UasAutoAnswer | None",
    collector: MetricsCollector,
    server_task,
    config: VMConfig,
    no_unregister: bool = False,
) -> None:
    """
    Graceful shutdown sequence:
      0. UAC: signal UAS to stop via peer_stop_url (on every shutdown: success, failure, Ctrl+C)
      1. Stop call engine (no new INVITEs)
      2. Drain active calls (BYE, 5s timeout)
      3. Stop UAS auto-answer loops
      4. Unregister all extensions
      5. Close all transports
      6. Flush final metrics snapshot
      7. Cancel metrics server
    """
    # 0. UAC: signal UAS to stop (ensures UAS unregisters on pre-phase failure, Ctrl+C, or normal completion)
    # Try configured port + fallbacks (8082, 8083) — UAS may have bound to a different port if 8081 was in use
    if config.is_uac:
        peer_url = getattr(config, "peer_stop_url", "") or ""
        if peer_url and _REQUESTS_AVAILABLE:
            await asyncio.to_thread(_post_peer_stop, peer_url)

    # 1. Stop new calls
    if engine:
        engine.stop()

    # 2. Drain active calls
    if engine:
        log.info("Draining active calls (sending BYE)…")
        await engine.drain_active_calls(timeout=10.0)

    # 3. Stop UAS loops
    if uas_engine:
        await uas_engine.stop()

    # 4. Unregister all extensions (skip if --no-unregister)
    if no_unregister:
        log.info("--no-unregister set: skipping REGISTER(Expires:0) — extensions remain registered on server")
    else:
        log.info("Unregistering %d extensions…", len(agents))
        unrg_tasks = [
            asyncio.create_task(a.unregister(), name=f"unreg-{a.ext}")
            for a in agents.values()
        ]
        try:
            await asyncio.wait_for(
                asyncio.gather(*unrg_tasks, return_exceptions=True),
                timeout=float(config.register_timeout * 2),
            )
        except asyncio.TimeoutError:
            log.warning("Some unregistrations timed out")

    # 5. Close all transports
    log.info("Closing transports…")
    close_tasks = [
        asyncio.create_task(a.close(), name=f"close-{a.ext}")
        for a in agents.values()
    ]
    await asyncio.gather(*close_tasks, return_exceptions=True)

    # 6. Final metrics flush + traffic summary
    collector.set_phase("DONE")
    async with collector._lock:
        snap = collector._build_snapshot()
    log.info("Final metrics: %s", snap.to_dict())

    write_traffic_summary(
        collector, config, log_dir="logs",
        engine=engine, uas_engine=uas_engine, agents=agents,
    )

    # 7. Metrics server is intentionally NOT cancelled here.
    #    The caller holds the server open for gui_drain_seconds so the GUI
    #    can fetch final metrics, call events, and phase=DONE before exit.

    log.info("SIP cleanup complete — metrics server still serving")


# ---------------------------------------------------------------------------
# GUI-driven lifecycle (triggered by POST /api/test/start)
# ---------------------------------------------------------------------------

async def _run_traffic_lifecycle(ctx: ProcessContext) -> None:
    """
    Run the full traffic lifecycle (agents → pre-phase → traffic → shutdown)
    as a background task inside the --api-only process.

    This executes the same code path as the CLI ``run()`` function but is
    triggered by the GUI via POST /api/test/start instead of process startup.
    """
    config: VMConfig = ctx.config
    collector = ctx.collector
    stop_event = ctx.stop_event

    # Setup file logging now that we have a vm_id
    log_file = _auto_log_file(config.vm_id)
    _setup_logging(ctx.log_level, log_file=log_file)

    # Derive max_calls the same way the CLI does
    max_calls = 0
    if config.is_uac:
        if config.traffic_mode == "smoke":
            max_calls = config.call_count
        elif config.traffic_mode == "timed":
            max_calls = int(config.cps * config.duration_hours * 3600)

    if max_calls > 0 and config.pool_wrap_count > 0:
        pool_wraps = math.ceil(max_calls / config.pool_wrap_count)
        log.info(
            "traffic_mode=%s max_calls=%d | LCM(%d,%d)=%d -> pool_wraps=%d (internal)",
            config.traffic_mode, max_calls,
            config.uac_ext_count, config.uas_ext_count,
            config.pool_wrap_count, pool_wraps,
        )
    elif max_calls == 0:
        log.info("traffic_mode=%s -> unlimited (run until stopped)", config.traffic_mode)

    engine = None
    uas_engine = None
    agents: dict[str, ExtensionAgent] = {}

    try:
        # ── Create agents ─────────────────────────────────────────────
        agents = _create_agents(config)
        log.info("Starting %d extension agent transports…", len(agents))
        await asyncio.gather(*[a.start() for a in agents.values()])
        collector.update_counts(sockets=len(agents))
        log.info("All transports connected")

        # ── PRE-PHASE: REGISTER + SUBSCRIBE ───────────────────────────
        collector.set_phase("PRE_REGISTER")

        try:
            pre_result = await run_pre_phase(list(agents.values()), config)
        except RuntimeError as exc:
            log.critical("Pre-phase failed: %s", exc)
            collector.set_phase("FAILED")
            ctx.state = "FAILED"
            await _shutdown(agents, None, None, collector, None, config)
            return

        collector.update_counts(
            sockets=len(agents),
            registered=pre_result.registered,
            subscribed=pre_result.subscribed,
        )

        # ── TRAFFIC PHASE ─────────────────────────────────────────────
        collector.set_phase("TRAFFIC")
        collector.set_running(True)

        if config.is_uac:
            engine = CallEngine(
                agents, config,
                on_call_complete=collector.record_call,
                max_calls=max_calls,
            )
            collector.set_concurrent_provider(lambda: engine.active_call_count)
            log.info(
                "UAC mode | %d CPS | %ds hold | ~%d concurrent | ramp=%ds",
                config.cps, config.hold_time_seconds,
                config.effective_max_concurrent, config.ramp_up_seconds,
            )

            engine_task = asyncio.create_task(engine.run(), name="call-engine")
            stop_waiter = asyncio.create_task(stop_event.wait(), name="stop-waiter")

            done, pending = await asyncio.wait(
                [engine_task, stop_waiter],
                return_when=asyncio.FIRST_COMPLETED,
            )
            for t in pending:
                t.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
        else:
            uas_engine = UasAutoAnswer(
                agents, config, on_call_complete=collector.record_call,
            )
            await uas_engine.start()
            log.info("UAS auto-answer mode active on %d extensions", len(agents))
            await stop_event.wait()

        # ── GRACEFUL SHUTDOWN ─────────────────────────────────────────
        collector.set_phase("STOPPING")
        collector.set_running(False)
        log.info("Initiating graceful shutdown…")

        await _shutdown(agents, engine, uas_engine, collector, None, config)

        snap = collector.latest
        log.info(
            "=" * 60 + "\nRUN COMPLETE | attempted=%d completed=%d failed=%d ASR=%.1f%%\n" + "=" * 60,
            snap.calls_attempted, snap.calls_completed, snap.calls_failed, snap.asr,
        )
        ctx.state = "COMPLETE"

    except Exception:
        log.exception("Traffic lifecycle failed unexpectedly")
        collector.set_phase("FAILED")
        ctx.state = "FAILED"
        if agents:
            await _shutdown(agents, engine, uas_engine, collector, None, config)
    finally:
        # Revert to console-only logging so the RotatingFileHandler releases
        # the log file.  The process survives in COMPLETE state — without this
        # the file stays locked until Ctrl+C / shutdown.
        _setup_logging(ctx.log_level)
        log.info("Log file released — process ready for new run or shutdown")


# ---------------------------------------------------------------------------
# API-only mode — bare FastAPI server waiting for GUI commands
# ---------------------------------------------------------------------------

async def run_api_only(port: int, log_level: str = "INFO", gui_drain_seconds: int = 15) -> int:
    """
    Start a bare FastAPI server that waits for:
      1. PUT /api/config      → receive and write VM config
      2. POST /api/test/start → trigger the full traffic lifecycle
      3. POST /api/test/reset → reset state for a new run
      4. POST /api/shutdown   → exit the process

    Traffic stop (/api/test/stop) only stops the SIP lifecycle — the process
    stays alive so the GUI can fetch final data and start new runs.
    Only Ctrl+C, SIGTERM, or POST /api/shutdown exits the process.
    """
    stop_event = asyncio.Event()          # stops traffic lifecycle
    process_exit_event = asyncio.Event()  # exits the entire process
    loop = asyncio.get_event_loop()

    def _handle_signal(sig):
        log.info("Received signal %s, initiating shutdown…", sig.name)
        stop_event.set()
        process_exit_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _handle_signal, sig)
        except NotImplementedError:
            signal.signal(sig, lambda s, f, _sig=sig: loop.call_soon_threadsafe(_handle_signal, _sig))

    collector = MetricsCollector("unconfigured", metrics_interval=10)
    collector.set_phase("IDLE")

    ctx = ProcessContext(collector=collector, stop_event=stop_event, port=port)
    ctx.process_exit_event = process_exit_event
    ctx.log_level = log_level

    async def _do_start():
        ctx._lifecycle_task = asyncio.create_task(
            _run_traffic_lifecycle(ctx),
            name="traffic-lifecycle",
        )
    ctx._start_func = _do_start

    async def _stop_callback():
        stop_event.set()

    server_task = await start_api_only_server(ctx, stop_callback=_stop_callback)

    log.info("=" * 60)
    log.info("GUI-DRIVEN mode — FastAPI server on :%d", ctx.port)
    log.info("  1. GUI pushes config:  PUT  /api/config")
    log.info("  2. GUI triggers start: POST /api/test/start")
    log.info("  3. GUI monitors:       GET  /api/test/status  |  WS /metrics/stream")
    log.info("  4. New run:            POST /api/test/reset")
    log.info("  5. Exit process:       POST /api/shutdown  |  Ctrl+C")
    log.info("=" * 60)

    # Wait for explicit process exit (Ctrl+C, SIGTERM, or POST /api/shutdown).
    # Traffic stop (/api/test/stop) does NOT set this event — the process
    # stays alive in COMPLETE state so the GUI can fetch final data and
    # the operator can start new runs without restarting processes.
    await process_exit_event.wait()

    # If lifecycle is still running, ensure it gets the stop signal and wait
    if ctx._lifecycle_task and not ctx._lifecycle_task.done():
        log.info("Waiting for traffic lifecycle to complete shutdown…")
        stop_event.set()
        try:
            await asyncio.wait_for(ctx._lifecycle_task, timeout=60.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            log.warning("Lifecycle task did not finish in time")

    # Brief drain so GUI can fetch last data before process dies
    if gui_drain_seconds > 0 and server_task and not server_task.done():
        log.info("GUI drain: keeping server alive for %ds…", gui_drain_seconds)
        try:
            await asyncio.sleep(gui_drain_seconds)
        except asyncio.CancelledError:
            pass

    if server_task and not server_task.done():
        server_task.cancel()
        try:
            await asyncio.wait_for(server_task, timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    log.info("API-only shutdown complete")
    return 0


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    args = _parse_args()
    _setup_logging(args.log_level)   # console only until vm_id is known

    log.info("=" * 60)
    log.info("SBC Traffic Engine — Phase 1")
    log.info("=" * 60)

    # ── GUI-driven mode: --api-only without --config ─────────────────────
    if args.api_only and not args.config:
        if not args.port:
            log.critical("--api-only without --config requires --port (e.g. --port 8081)")
            sys.exit(1)
        try:
            exit_code = asyncio.run(
                run_api_only(args.port, args.log_level, args.gui_drain_seconds)
            )
        except KeyboardInterrupt:
            log.info("Interrupted by user")
            exit_code = 0
        log.info("Process PID %d exiting (code %d)", os.getpid(), exit_code)
        os._exit(exit_code)
        return

    # ── CLI mode: load config from yaml/env (existing path) ──────────────
    # Load config
    try:
        config = load_config(yaml_path=args.config or None)
    except (ValueError, FileNotFoundError) as exc:
        log.critical("Config error: %s", exc)
        sys.exit(1)

    # Re-configure logging now that vm_id is known — add file handler
    log_file = args.log_file or _auto_log_file(config.vm_id, args.log_dir)
    _setup_logging(args.log_level, log_file=log_file)

    # Dry run: validate and exit
    if args.dry_run:
        log.info("Dry run — config valid, exiting")
        log.info(
            "UAC ext: %d–%d (%d), UAS ext: %d–%d (%d)",
            config.uac_ext_start, config.uac_ext_end, config.uac_ext_count,
            config.uas_ext_start, config.uas_ext_end, config.uas_ext_count,
        )
        log.info(
            "CPS=%d hold=%ds → %d concurrent, ramp=%ds",
            config.cps, config.hold_time_seconds,
            config.effective_max_concurrent, config.ramp_up_seconds,
        )
        sys.exit(0)

    # ── Derive max_calls (UAC only) ───────────────────────────────────────────
    # Priority:
    #   1. --max-calls N  (CLI, always overrides — quick dev/smoke override)
    #   2. traffic_mode=smoke   → max_calls = call_count             (YAML/GUI)
    #   3. traffic_mode=timed   → max_calls = CPS × duration_hours × 3600  (YAML/GUI)
    #   4. traffic_mode=unlimited or nothing  → max_calls = 0  (run until stopped)
    max_calls = args.max_calls   # 0 if not provided at CLI

    if max_calls == 0 and config.is_uac:
        if config.traffic_mode == "smoke":
            max_calls = config.call_count
        elif config.traffic_mode == "timed":
            max_calls = int(config.cps * config.duration_hours * 3600)

    # Log the resolved values for observability; pool_wraps is internal-only
    if max_calls > 0 and config.pool_wrap_count > 0:
        pool_wraps = math.ceil(max_calls / config.pool_wrap_count)
        log.info(
            "traffic_mode=%s max_calls=%d | LCM(%d,%d)=%d -> pool_wraps=%d (internal)",
            config.traffic_mode, max_calls,
            config.uac_ext_count, config.uas_ext_count,
            config.pool_wrap_count, pool_wraps,
        )
    elif max_calls == 0:
        log.info("traffic_mode=%s -> unlimited (run until stopped)", config.traffic_mode)

    # Run
    try:
        exit_code = asyncio.run(run(
            config,
            skip_subscribe=args.skip_subscribe,
            max_calls=max_calls,
            pre_phase_only=args.pre_phase_only,
            no_unregister=args.no_unregister,
            api_only=args.api_only,
            gui_drain_seconds=args.gui_drain_seconds,
        ))
    except KeyboardInterrupt:
        log.info("Interrupted by user")
        exit_code = 0

    # Hard-kill this process so uvicorn/asyncio background threads cannot hold
    # ports open after shutdown. os._exit() bypasses Python atexit handlers and
    # thread cleanup — exactly what we want here to ensure the metrics port is
    # released immediately for the next run.
    log.info("Process PID %d exiting (code %d)", os.getpid(), exit_code)
    os._exit(exit_code)


if __name__ == "__main__":
    main()
