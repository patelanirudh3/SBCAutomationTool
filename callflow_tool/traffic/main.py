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
import logging
import os
import signal
import sys
import time

# ---------------------------------------------------------------------------
# Configure structured logging before any imports
# ---------------------------------------------------------------------------

def _setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)-8s %(name)-30s %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S",
    )

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

async def run(config: VMConfig, skip_subscribe: bool = False) -> int:
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

    # ── Start metrics HTTP server ─────────────────────────────────────────
    server_task = await start_server(
        collector, config, stop_callback=lambda: stop_event.set()
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
        await _shutdown(agents, None, None, collector, server_task, config)
        return 1

    collector.update_counts(
        sockets=len(agents),
        registered=pre_result.registered,
        subscribed=pre_result.subscribed,
    )

    # ── TRAFFIC PHASE ─────────────────────────────────────────────────────
    collector.set_phase("TRAFFIC")
    collector.set_running(True)
    engine = None
    uas_engine = None

    if config.is_uac:
        engine = CallEngine(agents, config, on_call_complete=collector.record_call)
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

    await _shutdown(agents, engine, uas_engine, collector, server_task, config)

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

    # 4. Unregister all extensions
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
    _setup_logging(args.log_level)

    log.info("=" * 60)
    log.info("SBC Traffic Engine — Phase 1")
    log.info("=" * 60)

    # Load config
    try:
        config = load_config(yaml_path=args.config or None)
    except (ValueError, FileNotFoundError) as exc:
        log.critical("Config error: %s", exc)
        sys.exit(1)

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

    # Run
    try:
        exit_code = asyncio.run(run(config, skip_subscribe=args.skip_subscribe))
    except KeyboardInterrupt:
        log.info("Interrupted by user")
        exit_code = 0

    sys.exit(exit_code)


if __name__ == "__main__":
    main()
