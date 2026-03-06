"""
traffic/pre_phase.py
====================
Pre-phase: Bulk REGISTER + SUBSCRIBE for all extensions before any INVITE.

Rules (per Phase 1 spec):
  - Max 50 REGISTER/sec (configurable via VMConfig.register_rate)
  - Retry up to VMConfig.register_retry times on timeout
  - asyncio.gather() barrier: ALL extensions must register before continuing
  - Same pattern for SUBSCRIBE
  - Log "ALL EXTENSIONS READY" only when both barriers clear

No INVITE is fired until this module completes successfully.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

from .extension_agent import ExtensionAgent
from .config import VMConfig

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Result tracking
# ---------------------------------------------------------------------------

@dataclass
class PrePhaseResult:
    total: int
    registered: int
    subscribed: int
    failed_register: list[str]    # extension numbers that failed
    failed_subscribe: list[str]
    duration_seconds: float

    @property
    def register_success_rate(self) -> float:
        return (self.registered / self.total * 100) if self.total > 0 else 0.0

    @property
    def all_ready(self) -> bool:
        return len(self.failed_register) == 0 and len(self.failed_subscribe) == 0


# ---------------------------------------------------------------------------
# Phase 1: Bulk REGISTER
# ---------------------------------------------------------------------------

async def register_all(
    agents: list[ExtensionAgent],
    config: VMConfig,
    progress_callback=None,
) -> list[str]:
    """
    Register all extensions at max config.register_rate/sec.

    Args:
        agents:             List of ExtensionAgent instances to register.
        config:             VMConfig (for register_rate, retry, timeout).
        progress_callback:  Optional async callable(done, total) for progress.

    Returns:
        List of extension numbers that FAILED to register.

    Raises:
        RuntimeError if any extension fails after all retries.
    """
    total = len(agents)
    failed: list[str] = []
    done = 0

    # Semaphore enforces max register_rate concurrent REGISTERs
    semaphore = asyncio.Semaphore(config.register_rate)

    async def throttled_register(agent: ExtensionAgent) -> None:
        nonlocal done
        async with semaphore:
            for attempt in range(1, config.register_retry + 1):
                try:
                    await asyncio.wait_for(
                        agent.register(),
                        timeout=float(config.register_timeout),
                    )
                    done += 1
                    if progress_callback:
                        await progress_callback(done, total)
                    return
                except asyncio.TimeoutError:
                    log.warning(
                        "ext=%s REGISTER attempt %d/%d timed out",
                        agent.ext, attempt, config.register_retry,
                    )
                except Exception as exc:
                    log.error(
                        "ext=%s REGISTER attempt %d/%d error: %s",
                        agent.ext, attempt, config.register_retry, exc,
                    )
                # Exponential backoff between retries
                if attempt < config.register_retry:
                    await asyncio.sleep(0.5 * attempt)

            log.error(
                "ext=%s failed to register after %d attempts",
                agent.ext, config.register_retry,
            )
            failed.append(agent.ext)

    log.info("Pre-phase: registering %d extensions at max %d/sec…", total, config.register_rate)
    start = time.monotonic()

    await asyncio.gather(*[throttled_register(a) for a in agents])

    elapsed = time.monotonic() - start
    success = total - len(failed)
    log.info(
        "REGISTER complete: %d/%d OK, %d failed, %.1fs elapsed",
        success, total, len(failed), elapsed,
    )
    return failed


# ---------------------------------------------------------------------------
# Phase 2: Bulk SUBSCRIBE
# ---------------------------------------------------------------------------

async def subscribe_all(
    agents: list[ExtensionAgent],
    config: VMConfig,
    progress_callback=None,
) -> list[str]:
    """
    Subscribe all extensions at max config.register_rate/sec.

    Args:
        agents:             List of ExtensionAgent instances to subscribe.
        config:             VMConfig.
        progress_callback:  Optional async callable(done, total).

    Returns:
        List of extension numbers that FAILED to subscribe.
    """
    total = len(agents)
    failed: list[str] = []
    done = 0

    semaphore = asyncio.Semaphore(config.register_rate)

    async def throttled_subscribe(agent: ExtensionAgent) -> None:
        nonlocal done
        async with semaphore:
            for attempt in range(1, config.register_retry + 1):
                try:
                    await asyncio.wait_for(
                        agent.subscribe(),
                        timeout=float(config.register_timeout),
                    )
                    done += 1
                    if progress_callback:
                        await progress_callback(done, total)
                    return
                except asyncio.TimeoutError:
                    log.warning(
                        "ext=%s SUBSCRIBE attempt %d/%d timed out",
                        agent.ext, attempt, config.register_retry,
                    )
                except Exception as exc:
                    log.error(
                        "ext=%s SUBSCRIBE attempt %d/%d error: %s",
                        agent.ext, attempt, config.register_retry, exc,
                    )
                if attempt < config.register_retry:
                    await asyncio.sleep(0.5 * attempt)

            log.error(
                "ext=%s failed to subscribe after %d attempts",
                agent.ext, config.register_retry,
            )
            failed.append(agent.ext)

    log.info("Pre-phase: subscribing %d extensions…", total)
    start = time.monotonic()

    await asyncio.gather(*[throttled_subscribe(a) for a in agents])

    elapsed = time.monotonic() - start
    success = total - len(failed)
    log.info(
        "SUBSCRIBE complete: %d/%d OK, %d failed, %.1fs elapsed",
        success, total, len(failed), elapsed,
    )
    return failed


# ---------------------------------------------------------------------------
# Barrier: wait for all registered events
# ---------------------------------------------------------------------------

async def wait_all_registered(agents: list[ExtensionAgent], timeout: float = 120.0) -> None:
    """Block until every agent's registered event is set, or raise on timeout."""
    await asyncio.wait_for(
        asyncio.gather(*[a.registered.wait() for a in agents]),
        timeout=timeout,
    )


async def wait_all_subscribed(agents: list[ExtensionAgent], timeout: float = 120.0) -> None:
    """Block until every agent's subscribed event is set, or raise on timeout."""
    await asyncio.wait_for(
        asyncio.gather(*[a.subscribed.wait() for a in agents]),
        timeout=timeout,
    )


# ---------------------------------------------------------------------------
# Top-level runner
# ---------------------------------------------------------------------------

async def run_pre_phase(
    agents: list[ExtensionAgent],
    config: VMConfig,
    skip_subscribe: bool = False,
) -> PrePhaseResult:
    """
    Full pre-phase pipeline:
      1. Register all extensions (barrier)
      2. Subscribe all extensions (barrier, unless skip_subscribe=True)
      3. Log "ALL EXTENSIONS READY"

    Args:
        agents:           All ExtensionAgent instances for this VM.
        config:           VMConfig.
        skip_subscribe:   If True, skip SUBSCRIBE phase (for pure traffic testing).

    Returns:
        PrePhaseResult with success/failure counts.

    Raises:
        RuntimeError if any extension fails and strict mode is enabled.
    """
    total = len(agents)
    start = time.monotonic()

    # ── Phase 1: REGISTER ────────────────────────────────────────────────
    log.info("=" * 60)
    log.info("PRE-PHASE 1/2 — REGISTER (%d extensions)", total)
    log.info("=" * 60)

    failed_reg = await register_all(agents, config)

    if failed_reg:
        log.error(
            "PRE-PHASE REGISTER failed for %d extension(s): %s",
            len(failed_reg), failed_reg,
        )
        raise RuntimeError(
            f"Pre-phase REGISTER failed for {len(failed_reg)} extension(s): "
            f"{failed_reg}. Aborting — no INVITE will be sent."
        )

    # Confirm all registered events are set
    await wait_all_registered(agents, timeout=30.0)

    # ── Phase 2: SUBSCRIBE ───────────────────────────────────────────────
    failed_sub: list[str] = []

    if skip_subscribe:
        log.info("PRE-PHASE 2/2 — SUBSCRIBE skipped")
        for a in agents:
            a.subscribed.set()  # mark done so barriers don't block
    else:
        log.info("=" * 60)
        log.info("PRE-PHASE 2/2 — SUBSCRIBE (%d extensions)", total)
        log.info("=" * 60)

        failed_sub = await subscribe_all(agents, config)

        if failed_sub:
            log.error(
                "PRE-PHASE SUBSCRIBE failed for %d extension(s): %s",
                len(failed_sub), failed_sub,
            )
            raise RuntimeError(
                f"Pre-phase SUBSCRIBE failed for {len(failed_sub)} extension(s): "
                f"{failed_sub}. Aborting."
            )

        await wait_all_subscribed(agents, timeout=30.0)

    # ── Done ─────────────────────────────────────────────────────────────
    elapsed = time.monotonic() - start
    registered_count = total - len(failed_reg)
    subscribed_count = total - len(failed_sub)

    result = PrePhaseResult(
        total=total,
        registered=registered_count,
        subscribed=subscribed_count,
        failed_register=failed_reg,
        failed_subscribe=failed_sub,
        duration_seconds=elapsed,
    )

    log.info("=" * 60)
    log.info(
        "ALL EXTENSIONS READY — %d registered, %d subscribed in %.1fs",
        registered_count, subscribed_count, elapsed,
    )
    log.info("=" * 60)

    return result
