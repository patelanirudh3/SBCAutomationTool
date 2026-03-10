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
import os
import signal
import sys
import time

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
from .metrics import MetricsCollector, start_server


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
        help="Stop UAC after N call attempts (0 = unlimited or derived from --pool-wraps)",
    )
    p.add_argument(
        "--pool-wraps",
        type=int,
        default=int(os.environ.get("POOL_WRAPS", "0")),
        metavar="N",
        help="Derive max_calls = N × LCM(uac_count, uas_count). Overrides --max-calls when > 0.",
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
) -> int:
    """
    Full lifecycle coroutine. Returns exit code (0 = success).
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
            # Windows doesn't support add_signal_handler for all signals
            signal.signal(sig, lambda s, f: stop_event.set())

    # ── Metrics collector ─────────────────────────────────────────────────
    collector = MetricsCollector(config.vm_id, config.metrics_interval)
    collector.set_phase("INIT")

    async def _stop_callback() -> None:
        stop_event.set()

    # ── Start metrics HTTP server ─────────────────────────────────────────
    server_task = await start_server(
        collector, config, stop_callback=_stop_callback
    )

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
        engine_finished_first = engine_task in done
        for t in pending:
            t.cancel()
        await asyncio.gather(*pending, return_exceptions=True)

        # UAC finished naturally (max_calls): signal UAS to stop via peer_stop_url
        if engine_finished_first:
            peer_url = getattr(config, "peer_stop_url", "") or ""
            if peer_url and _REQUESTS_AVAILABLE:
                try:
                    log.info("Traffic complete — POST %s to signal UAS shutdown", peer_url)
                    await asyncio.to_thread(requests.post, peer_url, timeout=5)
                except Exception as exc:
                    log.warning("POST %s failed: %s (UAS may need manual stop)", peer_url, exc)

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

    return 0


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
      1. Stop call engine (no new INVITEs)
      2. Drain active calls (BYE, 5s timeout)
      3. Stop UAS auto-answer loops
      4. Unregister all extensions
      5. Close all transports
      6. Flush final metrics snapshot
      7. Cancel metrics server
    """
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

    # 6. Final metrics flush
    collector.set_phase("DONE")
    async with collector._lock:
        snap = collector._build_snapshot()
    log.info("Final metrics: %s", snap.to_dict())

    # 7. Cancel metrics server
    if server_task and not server_task.done():
        server_task.cancel()
        try:
            await asyncio.wait_for(server_task, timeout=3.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass

    log.info("Shutdown complete")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    args = _parse_args()
    _setup_logging(args.log_level)   # console only until vm_id is known

    log.info("=" * 60)
    log.info("SBC Traffic Engine — Phase 1")
    log.info("=" * 60)

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

    # Derive max_calls from pool_wraps when set (UAC only); else use --max-calls
    max_calls = args.max_calls
    if args.pool_wraps > 0 and config.is_uac:
        pool_wrap = config.pool_wrap_count
        max_calls = args.pool_wraps * pool_wrap
        log.info(
            "pool_wraps=%d x LCM(uac=%d, uas=%d)=%d -> max_calls=%d",
            args.pool_wraps, config.uac_ext_count, config.uas_ext_count,
            pool_wrap, max_calls,
        )

    # Run
    try:
        exit_code = asyncio.run(run(
            config,
            skip_subscribe=args.skip_subscribe,
            max_calls=max_calls,
            pre_phase_only=args.pre_phase_only,
            no_unregister=args.no_unregister,
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
