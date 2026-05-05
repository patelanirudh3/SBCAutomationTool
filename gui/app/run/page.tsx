'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff, Loader2, AlertOctagon, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

import { Navbar } from '@/components/layout/Navbar'
import { StepIndicator } from '@/components/layout/StepIndicator'
import { HomeGuardButton } from '@/components/shared/HomeGuardButton'
import { ChatPanel } from '@/components/agent/ChatPanel'
import { ASRGauge } from '@/components/dashboard/ASRGauge'
import { RunTimer } from '@/components/dashboard/RunTimer'
import { VMMetricsCard } from '@/components/dashboard/VMMetricsCard'
import { LiveChart } from '@/components/dashboard/LiveChart'
import { ConcurrentCallsBar } from '@/components/dashboard/ConcurrentCallsBar'
import { AggregatePanel } from '@/components/dashboard/AggregatePanel'
import { PrePhaseReport } from '@/components/dashboard/PrePhaseReport'
import { PrePhaseSummaryModal } from '@/components/dashboard/PrePhaseSummaryModal'
import { FailedCallsTable } from '@/components/dashboard/FailedCallsTable'
import { MediaQosPanel } from '@/components/dashboard/MediaQosPanel'
import { FinalReport } from '@/components/postrun/FinalReport'

import { useTrafficStore } from '@/store/traffic'
import type { CallEvent } from '@/types'
import { useMetricsStream } from '@/lib/ws'
import { vmWsUrl, getMetricsFor, getCallsFor, getCallSpinesFor, buildAggregate, gracefulStopFor, interruptStopFor, startCleanupFor, resetTestFor } from '@/lib/api'
import { mapBackendPhase as sharedMapBackendPhase } from '@/lib/phase'
import {
  MOCK_UAC_METRICS,
  MOCK_CALL_EVENTS,
  MOCK_AGGREGATE,
  simulateMetricsTick,
} from '@/lib/mock-data'
import type { TrafficMetrics, RunPhase } from '@/types'

const IS_MOCK = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'

// ---------------------------------------------------------------------------
// Backend-phase → UI RunPhase combinator
// Both VM statuses are consulted; UAC drives the primary state
// ---------------------------------------------------------------------------

// Re-export the shared mapper so existing call-sites in this file keep
// working unchanged. The shared module is the single source of truth and
// is also used by the Zustand store on every WS push.
const mapBackendPhase = sharedMapBackendPhase

// ---------------------------------------------------------------------------
// Live Dashboard — Screen 3
// ---------------------------------------------------------------------------

function LiveDashboard({
  stopping,
  onGracefulStop,
  onInterruptStop,
}: {
  stopping: boolean
  onGracefulStop: () => void
  onInterruptStop: () => void
}) {
  const phase = useTrafficStore((s) => s.phase)
  const uacMetrics = useTrafficStore((s) => s.uacMetrics)
  const idleCount   = useTrafficStore((s) => s.idleCount)
  const nonIdleCount= useTrafficStore((s) => s.nonIdleCount)
  const regOnlyCount= useTrafficStore((s) => s.regOnlyCount)
  const callEvents  = useTrafficStore((s) => s.callEvents) as CallEvent[]
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  const pair = pairs[activePairIndex]
  const configuredCps = pair?.uac.cps ?? 2

  const extensionCeiling =
    pair
      ? ((pair.uac.ext_end ?? 0) - (pair.uac.ext_start ?? 0) + 1)
      : 10

  if (!uacMetrics) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="font-mono text-sm text-muted-foreground animate-pulse">
          Waiting for metrics…
        </p>
      </div>
    )
  }

  const isTrafficPhase = phase === 'TRAFFIC'
  const isStopping     = phase === 'STOPPING'

  return (
    <div className="flex flex-col gap-4 p-4 max-w-6xl mx-auto w-full">
      {/* Row 1 — Hero: ASR + RunTimer + Stop buttons */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-6">
        <ASRGauge asr={uacMetrics.asr} className="flex-1 min-w-0" />
        <RunTimer elapsed={uacMetrics.run_elapsed_seconds} />

        {/* Stop controls — shown during active traffic */}
        {(isTrafficPhase || isStopping) && (
          <div className="flex shrink-0 flex-col gap-2">
            {/* Graceful Stop */}
            <button
              onClick={onGracefulStop}
              disabled={stopping || isStopping}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-3 py-1.5',
                'border-amber-500/40 bg-amber-500/10 text-amber-300 text-xs font-semibold',
                'hover:bg-amber-500/20 hover:text-amber-200 transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {stopping && !isStopping ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <CheckCircle2 className="size-3" />
              )}
              Graceful Stop
            </button>
            {/* Force Stop (interrupt) */}
            <button
              onClick={onInterruptStop}
              disabled={stopping}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-3 py-1.5',
                'border-rose-500/40 bg-rose-500/10 text-rose-300 text-xs font-semibold',
                'hover:bg-rose-500/20 hover:text-rose-200 transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              <AlertOctagon className="size-3" />
              Force Stop
            </button>
          </div>
        )}

      </div>

      {/* Pool counts row — shown whenever we have non-zero counts */}
      {(idleCount > 0 || nonIdleCount > 0 || regOnlyCount > 0) && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-center">
            <p className="text-2xl font-bold font-mono text-emerald-400">{idleCount}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Idle (available)</p>
          </div>
          <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-3 text-center">
            <p className="text-2xl font-bold font-mono text-blue-400">{nonIdleCount}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Active (in call)</p>
          </div>
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-center">
            <p className="text-2xl font-bold font-mono text-amber-400">{regOnlyCount}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Reg-only</p>
          </div>
        </div>
      )}

      {/* Aggregate totals bar */}
      <AggregatePanel uacMetrics={uacMetrics} />

      {/* Row 2 — VM Metrics Card (single engine) */}
      <div className="grid grid-cols-1 gap-4">
        <VMMetricsCard
          role="UAC"
          metrics={uacMetrics}
          configuredCps={configuredCps}
        />
      </div>

      {/* Row 3 — Charts */}
      <div className="grid grid-cols-3 gap-4">
        <LiveChart className="col-span-2" />
        <div className="rounded-lg border border-border bg-card p-4 flex flex-col justify-center">
          <ConcurrentCallsBar
            concurrent={uacMetrics.concurrent_calls}
            ceiling={extensionCeiling}
          />
        </div>
      </div>

      {/* Row 4 — Live call stats: successful / completed / failed */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3 text-center">
          <p className="text-2xl font-bold font-mono text-sky-400">
            {uacMetrics.concurrent_calls.toLocaleString()}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">In-Call (INV/200/ACK)</p>
        </div>
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-center">
          <p className="text-2xl font-bold font-mono text-emerald-400">
            {uacMetrics.calls_completed.toLocaleString()}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Completed (BYE/200)</p>
        </div>
        <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-center">
          <p className="text-2xl font-bold font-mono text-rose-400">
            {uacMetrics.calls_failed.toLocaleString()}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Failed</p>
        </div>
      </div>

      {/* Row 5 — Failed calls table */}
      <FailedCallsTable events={callEvents} />

      {/* Row 6 — Media / QoS metrics (Phase 1) */}
      <MediaQosPanel
        jitterMs={uacMetrics.avg_jitter_ms ?? null}
        mosEstimate={uacMetrics.avg_mos_score ?? null}
        qosScore={(() => {
          const c = uacMetrics.media_quality_counts
          if (!c) return null
          const tracked = c.OK + c.WARNING + c.CRITICAL
          return tracked > 0 ? (c.OK / tracked) * 100 : null
        })()}
      />
    </div>
  )
}


// ---------------------------------------------------------------------------
// Reconnect banner
// ---------------------------------------------------------------------------

function ReconnectBanner({ visible }: { visible: boolean }) {
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="overflow-hidden"
        >
          <div className="flex items-center gap-2 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2">
            <WifiOff className="size-3.5 text-amber-400 shrink-0" />
            <span className="text-xs text-amber-300">
              Reconnecting to metrics stream… Charts frozen until connection restores.
            </span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

// ---------------------------------------------------------------------------
// Build aggregate metrics from last known UAC + UAS metrics snapshots
// ---------------------------------------------------------------------------

function buildAggregateFromStore(): void {
  const { uacMetrics, setAggregate, pairs, activePairIndex, currentRunId } =
    useTrafficStore.getState()

  if (!uacMetrics) return

  const pair = pairs[activePairIndex]
  const runId = currentRunId || `run-${pair?.uac.vm_id ?? 'local'}-${Date.now()}`

  setAggregate({
    total_attempted: uacMetrics.calls_attempted,
    total_answered: uacMetrics.calls_answered,
    total_completed: uacMetrics.calls_completed,
    total_failed: uacMetrics.calls_failed,
    aggregate_asr: uacMetrics.asr,
    run_id: runId,
    started_at: new Date(
      Date.now() - (uacMetrics.run_elapsed_seconds ?? 0) * 1000
    ).toISOString(),
    ended_at: new Date().toISOString(),
  })
}

// ---------------------------------------------------------------------------
// Fetch call events from both VMs, merge, store in Zustand.
// When isFinal=true, also builds aggregate from the call events (more
// accurate than the metrics snapshot which may be stale).
// ---------------------------------------------------------------------------

async function fetchAndStoreCallEvents(
  livePair: { uac: { vm_ip: string; metrics_port: number; vm_id?: string } },
  isFinal = false
): Promise<boolean> {
  const uacCalls = await getCallsFor(livePair.uac.vm_ip, livePair.uac.metrics_port)

  const allEvents = [...uacCalls]
  allEvents.sort((a, b) =>
    new Date(a.ts_utc ?? a.timestamp ?? 0).getTime() -
    new Date(b.ts_utc ?? b.timestamp ?? 0).getTime()
  )

  const { setCallEvents, setAggregate, uacMetrics, callEvents: existing } =
    useTrafficStore.getState()

  // Only update the store when the backend returned at least as many events
  // as we already have. This prevents a transient empty/short response (e.g.
  // engine restart, brief network blip) from clobbering a previously-fetched
  // list — which used to leave `callEvents` stale relative to the metric
  // counters and FailedCallsTable.
  if (allEvents.length >= existing.length) {
    setCallEvents(allEvents)
  }

  if (isFinal) {
    const { currentRunId, setCallSpines, callEvents: latest } =
      useTrafficStore.getState()
    const runId = currentRunId || `run-${livePair.uac.vm_id ?? 'local'}-${Date.now()}`
    const startedAt = uacMetrics?.run_elapsed_seconds
      ? new Date(Date.now() - uacMetrics.run_elapsed_seconds * 1000).toISOString()
      : new Date().toISOString()

    if (latest.length > 0) {
      setAggregate(buildAggregate(latest, [], runId, startedAt))
    }

    const spines = await getCallSpinesFor(livePair.uac.vm_ip, livePair.uac.metrics_port)
    setCallSpines(spines)
  }

  return allEvents.length > 0
}

// Final-fetch wrapper with retries: when the engine has finished but the
// /api/calls list looks short relative to calls_attempted, retry a few
// times with a small delay so we don't fall back to metric counters
// just because the engine is briefly slow to flush results.
async function finalFetchCallEventsWithRetry(
  livePair: { uac: { vm_ip: string; metrics_port: number; vm_id?: string } },
  retries = 4,
  delayMs = 750
): Promise<boolean> {
  let gotEvents = false
  for (let attempt = 0; attempt <= retries; attempt++) {
    gotEvents = await fetchAndStoreCallEvents(livePair, true)
    const { callEvents, uacMetrics } = useTrafficStore.getState()
    const expected = uacMetrics?.calls_attempted ?? 0
    // Done if we have at least as many events as the engine reported
    // attempts, or we hit the retry budget.
    if (callEvents.length >= expected || attempt === retries) {
      return gotEvents
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return gotEvents
}

// ---------------------------------------------------------------------------
// Root page — orchestrator
// ---------------------------------------------------------------------------

export default function RunPage() {
  const router = useRouter()
  const phase = useTrafficStore((s) => s.phase)
  const wsStatus = useTrafficStore((s) => s.wsStatus)
  const pair = useTrafficStore((s) => s.pairs[s.activePairIndex])
  const uacMetrics = useTrafficStore((s) => s.uacMetrics)
  const { setPhase, updateUACMetrics, setWsStatus, setCallEvents, setAggregate, setCleanupStatus, reset } =
    useTrafficStore()

  const [stopping, setStopping] = useState(false)
  const [reRunning, setReRunning] = useState(false)
  // Elapsed seconds frozen at the moment traffic stops (set once, never overwritten)
  const [frozenElapsed, setFrozenElapsed] = useState<number | null>(null)
  // Wall-clock start of the unregister phase (used to freeze
  // cleanupStatus.elapsed_seconds at completion)
  const cleanupStartedAtRef = useRef<number | null>(null)

  const mockTickRef = useRef(0)
  const mockUacRef = useRef<TrafficMetrics>(MOCK_UAC_METRICS)

  // ------------------------------------------------------------------
  // MOCK_MODE: simulate live metrics + auto-transition to COMPLETE
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!IS_MOCK) return

    if (phase === 'IDLE' || phase === 'PRE_PHASE' || phase === 'TRAFFIC_READY') {
      setPhase('TRAFFIC')
    }

    setWsStatus('uac', 'connected')

    updateUACMetrics(mockUacRef.current)

    const interval = setInterval(() => {
      mockTickRef.current += 1
      const tick = mockTickRef.current
      const totalAttempted = Math.min(tick * 2, 20)
      const totalFailed = tick >= 8 ? (tick >= 10 ? 2 : 1) : 0
      const totalCompleted = totalAttempted - totalFailed

      mockUacRef.current = simulateMetricsTick(
        mockUacRef.current,
        totalAttempted,
        totalCompleted,
        totalFailed
      )

      updateUACMetrics(mockUacRef.current)

      if (tick >= 20) {
        clearInterval(interval)
        setCallEvents(MOCK_CALL_EVENTS)
        const runId = useTrafficStore.getState().currentRunId || MOCK_AGGREGATE.run_id
        setAggregate({
          ...MOCK_AGGREGATE,
          run_id: runId,
          total_attempted: totalAttempted,
          total_answered: MOCK_CALL_EVENTS.filter((e) => e.answered === true).length,
          total_completed: totalCompleted,
          total_failed: totalFailed,
          aggregate_asr:
            totalAttempted > 0
              ? Math.round((totalCompleted / totalAttempted) * 1000) / 10
              : 0,
          ended_at: new Date().toISOString(),
        })
        setPhase('COMPLETE')
      }
    }, 2000)

    return () => {
      clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------------
  // Stop Traffic handlers (new phase-gated model)
  // ------------------------------------------------------------------

  // Capture the elapsed time once traffic stops; never overwrite so it stays accurate
  const prevPhaseRef = useRef<string>('')
  useEffect(() => {
    const prev = prevPhaseRef.current
    prevPhaseRef.current = phase
    const trafficPhases = new Set(['TRAFFIC', 'STOPPING'])
    const postTrafficPhases = new Set(['CLEANUP_READY', 'CLEANING_UP', 'COMPLETE', 'FAILED'])
    if (trafficPhases.has(prev) && postTrafficPhases.has(phase) && frozenElapsed === null) {
      const secs = uacMetrics?.run_elapsed_seconds ?? null
      setFrozenElapsed(secs)
    }

    // Stamp the cleanup elapsed once the unregister loop completes so the
    // result strip can render "(2.3s)" alongside the success message.
    if (
      prev === 'CLEANING_UP' &&
      (phase === 'COMPLETE' || phase === 'FAILED') &&
      cleanupStartedAtRef.current != null
    ) {
      const elapsed = (Date.now() - cleanupStartedAtRef.current) / 1000
      const cur = useTrafficStore.getState().cleanupStatus
      if (cur && cur.elapsed_seconds == null) {
        setCleanupStatus({ ...cur, elapsed_seconds: Math.round(elapsed * 10) / 10, in_progress: false, complete: true })
      }
    }
  }, [phase, uacMetrics, frozenElapsed, setCleanupStatus])

  const vmIp   = pair?.uac.vm_ip   ?? '127.0.0.1'
  const vmPort = pair?.uac.metrics_port ?? 8082

  const handleReRun = async () => {
    setReRunning(true)
    try {
      await resetTestFor(vmIp, vmPort)
    } catch { /* ignore — backend may already be idle */ }
    reset()
    setFrozenElapsed(null)
    cleanupStartedAtRef.current = null
    router.push('/launch')
  }

  const handleGracefulStop = async () => {
    setStopping(true)
    if (IS_MOCK) {
      setCallEvents(MOCK_CALL_EVENTS)
      setAggregate({ ...MOCK_AGGREGATE, ended_at: new Date().toISOString() })
      setPhase('CLEANUP_READY')
      setStopping(false)
      return
    }
    try {
      await gracefulStopFor(vmIp, vmPort)
      setPhase('STOPPING')
    } catch { /* backend will still stop, polling detects phase change */ }
    setStopping(false)
  }

  const handleInterruptStop = async () => {
    setStopping(true)
    if (IS_MOCK) {
      setCallEvents(MOCK_CALL_EVENTS)
      setAggregate({ ...MOCK_AGGREGATE, ended_at: new Date().toISOString() })
      setPhase('CLEANUP_READY')
      setStopping(false)
      return
    }
    try {
      await interruptStopFor(vmIp, vmPort)
      setPhase('STOPPING')
    } catch { /* ignore — backend will stop */ }
    setStopping(false)
  }

  const handleCleanup = async () => {
    setStopping(true)
    cleanupStartedAtRef.current = Date.now()
    const extCount = pair ? (pair.uac.ext_end - pair.uac.ext_start + 1) : 0

    // Seed cleanupStatus immediately so the progress card shows
    // "Starting unregister… 0 / N" before the first metrics push arrives.
    setCleanupStatus({
      count: 0,
      total: extCount > 0 ? extCount : 0,
      failed_extensions: [],
      in_progress: true,
      complete: false,
    })

    if (IS_MOCK) {
      // Animate count up to total, then settle into COMPLETE.
      setPhase('CLEANING_UP')
      const total = extCount > 0 ? extCount : 10
      let cur = 0
      const id = setInterval(() => {
        cur = Math.min(total, cur + Math.max(1, Math.ceil(total / 10)))
        setCleanupStatus({
          count: cur,
          total,
          failed_extensions: [],
          in_progress: cur < total,
          complete: cur >= total,
        })
        if (cur >= total) {
          clearInterval(id)
          setPhase('COMPLETE')
        }
      }, 250)
      setStopping(false)
      return
    }
    try {
      await startCleanupFor(vmIp, vmPort)
      // Flip to CLEANING_UP optimistically so the progress card renders
      // before the next metrics tick. The store will overwrite this with
      // the real backend phase on the next WS push (still CLEANING_UP).
      setPhase('CLEANING_UP')
    } catch { /* backend will still run cleanup; polling will catch up */ }
    setStopping(false)
  }

  // Retry hook for the partial-failure / total-failure result strips.
  // For now this re-issues /api/cleanup/start, which on a fresh DONE engine
  // is a no-op (409). When the backend grows a "/api/unregister/retry"
  // endpoint that accepts an extension list, swap it in here.
  const handleRetryFailed = async (_extensions: string[]) => {
    void _extensions
    if (IS_MOCK) {
      const cur = useTrafficStore.getState().cleanupStatus
      if (!cur) return
      setCleanupStatus({
        ...cur,
        failed_extensions: [],
        complete: true,
      })
      return
    }
    try { await startCleanupFor(vmIp, vmPort) } catch { /* ignore */ }
  }

  // ------------------------------------------------------------------
  // Live mode: unified poll — fetches metrics (supplements WS)
  // AND detects phase changes including backend exit.
  //
  // Why REST alongside WS?
  //   WS push interval is 10s (metrics_interval default).  For a 10-call
  //   smoke test completing in ~50s, we can miss the final 2 calls if the
  //   backend exits before the next push.  Polling /metrics every 5s
  //   catches the latest snapshot regardless.
  //
  // Phase detection:
  //   - Each /metrics response includes `phase`.  If both show DONE/
  //     STOPPING, we build aggregate and transition to COMPLETE.
  //   - If both backends are unreachable (processes exited) AND we were
  //     already in TRAFFIC, we use last-known metrics to build aggregate
  //     and transition to COMPLETE after 2 consecutive failures (~10s).
  // ------------------------------------------------------------------
  useEffect(() => {
    if (IS_MOCK) return

    const { pairs, activePairIndex } = useTrafficStore.getState()
    const livePair = pairs[activePairIndex]

    let intervalId: ReturnType<typeof setInterval> | null = null
    let consecutiveFailures = 0
    let completed = false

    const finish = async (targetPhase: RunPhase) => {
      if (completed) return
      completed = true
      if (intervalId !== null) clearInterval(intervalId)

      // Fetch call events one last time (isFinal=true builds aggregate from
      // events); retry a few times so we don't fall back to metric counters
      // just because the engine briefly returned a short list.
      const gotEvents = await finalFetchCallEventsWithRetry(livePair)

      // Fallback: if we couldn't reach the backend for call events at all,
      // build aggregate from the last-known metrics snapshot. This keeps
      // the report populated even when the engine is unreachable, but the
      // FailedCallsTable may be empty in that case.
      const { callEvents } = useTrafficStore.getState()
      if (!gotEvents && callEvents.length === 0) {
        buildAggregateFromStore()
      }

      setPhase(targetPhase)
    }

    const poll = async () => {
      if (completed) return

      const uacResult = await getMetricsFor(livePair.uac.vm_ip, livePair.uac.metrics_port).catch(() => null)

      if (uacResult) {
        consecutiveFailures = 0
        updateUACMetrics(uacResult)
        const uacPhase = (uacResult as unknown as { phase: string }).phase ?? ''

        // Refresh call events on every poll while traffic is alive so the
        // FailedCallsTable, Answered/Completed counts, and Failed counts
        // all stay in sync with the engine. The fetcher tolerates empty
        // responses without dropping a previously-fetched list.
        const currentPhase = useTrafficStore.getState().phase
        if (
          currentPhase === 'TRAFFIC' || uacPhase === 'TRAFFIC' ||
          uacPhase === 'STOPPING' || uacPhase === 'DONE'
        ) {
          await fetchAndStoreCallEvents(livePair)
        }

        if (uacPhase) {
          const livePhase = mapBackendPhase(uacPhase)

          if (livePhase === 'COMPLETE' || livePhase === 'FAILED') {
            await finish(livePhase)
            return
          }

          setPhase(livePhase)
        }
        return
      }

      // Backend unreachable — likely exited
      consecutiveFailures++
      const storePhase = useTrafficStore.getState().phase
      if (
        consecutiveFailures >= 3 &&
        (
          storePhase === 'TRAFFIC' ||
          storePhase === 'PRE_PHASE' ||
          storePhase === 'STOPPING' ||
          storePhase === 'CLEANUP_READY' ||
          storePhase === 'CLEANING_UP'
        )
      ) {
        await finish('COMPLETE')
      }
    }

    poll()
    intervalId = setInterval(poll, 5000)
    return () => {
      if (intervalId !== null) clearInterval(intervalId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ------------------------------------------------------------------
  // Live mode: two independent WebSocket connections
  // ------------------------------------------------------------------

  useMetricsStream(
    vmWsUrl(pair?.uac.vm_ip ?? '127.0.0.1', pair?.uac.metrics_port ?? 8082),
    {
      onMetrics: (metrics) => {
        const m = metrics.find((m) => m.vm_id === pair?.uac.vm_id) ?? metrics[0]
        if (m) updateUACMetrics(m)
      },
      onStatusChange: (status) => setWsStatus('uac', status),
    },
    !IS_MOCK
  )

  const isPrePhase     = phase === 'PRE_PHASE'
  const isTrafficReady = phase === 'TRAFFIC_READY'
  // LiveDashboard shows only during active traffic / stopping phase.
  // CLEANUP_READY transitions immediately to the FinalReport.
  const isTraffic      = phase === 'TRAFFIC' || phase === 'STOPPING'
  // FinalReport surfaces as soon as traffic calls finish (CLEANUP_READY),
  // remains while the user runs unregister (CLEANING_UP), and stays
  // for COMPLETE / FAILED.
  const isPostRun      = phase === 'CLEANUP_READY' || phase === 'CLEANING_UP' || phase === 'COMPLETE' || phase === 'FAILED'
  const showReconnectBanner =
    !IS_MOCK &&
    isTraffic &&
    wsStatus.uac !== 'connected'

  // Track elapsed seconds since pre-phase started (for the summary modal)
  const [prePhaseElapsed, setPrePhaseElapsed] = useState(0)
  const prePhaseTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (isPrePhase) {
      setPrePhaseElapsed(0)
      prePhaseTimerRef.current = setInterval(() => setPrePhaseElapsed((e) => e + 1), 1000)
    } else {
      if (prePhaseTimerRef.current) clearInterval(prePhaseTimerRef.current)
    }
    return () => { if (prePhaseTimerRef.current) clearInterval(prePhaseTimerRef.current) }
  }, [isPrePhase])

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <ChatPanel />
      <ReconnectBanner visible={showReconnectBanner} />
      <div className="relative flex items-center justify-center border-b border-border px-6 py-4">
        <div className="absolute left-6">
          <HomeGuardButton href="/config" />
        </div>
        <StepIndicator />
      </div>
      <main className="flex-1 overflow-y-auto py-2">
        <AnimatePresence mode="wait">

          {/* Pre-phase: registration + subscription progress */}
          {isPrePhase && (
            <motion.div
              key="prephase"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center"
            >
              <PrePhaseReport />
            </motion.div>
          )}

          {/* Traffic ready: show pre-phase summary + Start Traffic button */}
          {isTrafficReady && (
            <motion.div
              key="traffic-ready"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center"
            >
              {/* Background: frozen pre-phase report */}
              <PrePhaseReport />
              {/* Overlay: summary modal */}
              <PrePhaseSummaryModal
                elapsedSeconds={prePhaseElapsed}
                onAbort={() => {
                  setPhase('IDLE')
                }}
              />
            </motion.div>
          )}

          {/* Traffic in progress */}
          {isTraffic && (
            <motion.div
              key="live"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center"
            >
              <LiveDashboard
                stopping={stopping}
                onGracefulStop={handleGracefulStop}
                onInterruptStop={handleInterruptStop}
              />
            </motion.div>
          )}

          {/* Post-run / complete: final report */}
          {isPostRun && (
            <motion.div
              key="postrun"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center"
            >
              <FinalReport
                frozenElapsed={frozenElapsed}
                onUnregister={handleCleanup}
                unregistering={stopping}
                onReRun={handleReRun}
                reRunning={reRunning}
                onRetryFailed={handleRetryFailed}
              />
            </motion.div>
          )}

          {/* Idle / unknown */}
          {!isPrePhase && !isTrafficReady && !isTraffic && !isPostRun && (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-1 items-center justify-center py-20"
            >
              <p className="font-mono text-sm text-muted-foreground">
                Waiting for pre-phase to start…
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  )
}
