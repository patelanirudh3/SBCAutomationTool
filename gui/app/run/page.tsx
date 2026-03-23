'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff, Loader2, Home } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

import { Navbar } from '@/components/layout/Navbar'
import { StepIndicator } from '@/components/layout/StepIndicator'
import { ASRGauge } from '@/components/dashboard/ASRGauge'
import { RunTimer } from '@/components/dashboard/RunTimer'
import { VMMetricsCard } from '@/components/dashboard/VMMetricsCard'
import { LiveChart } from '@/components/dashboard/LiveChart'
import { ConcurrentCallsBar } from '@/components/dashboard/ConcurrentCallsBar'
import { AggregatePanel } from '@/components/dashboard/AggregatePanel'
import { SummaryCard } from '@/components/postrun/SummaryCard'
import { CallTable } from '@/components/postrun/CallTable'
import { FailureAnalysis } from '@/components/postrun/FailureAnalysis'
import { DownloadReport } from '@/components/postrun/DownloadReport'

import { useTrafficStore } from '@/store/traffic'
import { useMetricsStream } from '@/lib/ws'
import { vmWsUrl, getMetricsFor, getCallsFor, getCallSpinesFor, buildAggregate } from '@/lib/api'
import {
  MOCK_UAC_METRICS,
  MOCK_UAS_METRICS,
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

function mapBackendPhase(uacPhase: string, uasPhase: string): RunPhase {
  const phases = [uacPhase, uasPhase].map((p) => (p ?? '').toUpperCase())
  if (phases.some((p) => p === 'FAILED')) return 'FAILED'
  if (phases.some((p) => p === 'TRAFFIC')) return 'TRAFFIC'
  if (
    phases.some(
      (p) => p === 'PRE_PHASE' || p === 'PRE_REGISTER' || p === 'PRE_SUBSCRIBE'
    )
  )
    return 'PRE_PHASE'
  if (
    phases.some((p) => p === 'DONE' || p === 'STOPPING') &&
    phases.every((p) => p === 'DONE' || p === 'STOPPING' || p === 'IDLE')
  )
    return 'COMPLETE'
  return 'IDLE'
}

// ---------------------------------------------------------------------------
// Live Dashboard — Screen 3
// ---------------------------------------------------------------------------

function LiveDashboard({
  stopping,
  onStop,
}: {
  stopping: boolean
  onStop: () => void
}) {
  const phase = useTrafficStore((s) => s.phase)
  const uacMetrics = useTrafficStore((s) => s.uacMetrics)
  const uasMetrics = useTrafficStore((s) => s.uasMetrics)
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  const pair = pairs[activePairIndex]
  const configuredCps = pair?.uac.cps ?? 2

  const extensionCeiling =
    pair
      ? (pair.uac.uac_ext_end - pair.uac.uac_ext_start + 1) +
        (pair.uac.uas_ext_end - pair.uac.uas_ext_start + 1)
      : 10

  if (!uacMetrics || !uasMetrics) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="font-mono text-sm text-muted-foreground animate-pulse">
          Waiting for metrics…
        </p>
      </div>
    )
  }

  const showStopBtn = phase === 'TRAFFIC'

  return (
    <div className="flex flex-col gap-4 p-4 max-w-6xl mx-auto w-full">
      {/* Row 1 — Hero: ASR + RunTimer + Stop */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-6">
        <ASRGauge asr={uacMetrics.asr} className="flex-1 min-w-0" />
        <RunTimer elapsed={uacMetrics.run_elapsed_seconds} />
        {showStopBtn && (
          <button
            onClick={onStop}
            disabled={stopping}
            className={cn(
              'group relative flex size-20 shrink-0 flex-col items-center justify-center rounded-full',
              'bg-rose-600 text-white shadow-[0_0_24px_oklch(0.50_0.22_15/0.55)]',
              'border-4 border-rose-400/40',
              'transition-all duration-150',
              'hover:bg-rose-500 hover:shadow-[0_0_32px_oklch(0.55_0.24_15/0.70)] hover:scale-105',
              'active:scale-95 active:shadow-[0_0_14px_oklch(0.45_0.20_15/0.45)]',
              'disabled:cursor-not-allowed disabled:opacity-60 disabled:shadow-none disabled:scale-100',
            )}
          >
            {stopping ? (
              <>
                <Loader2 className="size-5 animate-spin mb-0.5" />
                <span className="text-[9px] font-bold uppercase tracking-widest leading-none">
                  Stopping
                </span>
              </>
            ) : (
              <>
                {/* Outer ring pulse */}
                <span className="absolute inset-0 rounded-full bg-rose-500/30 animate-ping group-hover:hidden" />
                <span className="relative text-[11px] font-black uppercase tracking-wider leading-tight text-center px-1">
                  Stop<br />Traffic
                </span>
              </>
            )}
          </button>
        )}
      </div>

      {/* Aggregate totals bar */}
      <AggregatePanel uacMetrics={uacMetrics} />

      {/* Row 2 — VM Metrics Cards */}
      <div className="grid grid-cols-2 gap-4">
        <VMMetricsCard
          role="UAC"
          metrics={uacMetrics}
          configuredCps={configuredCps}
        />
        <VMMetricsCard
          role="UAS"
          metrics={uasMetrics}
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
    </div>
  )
}

// ---------------------------------------------------------------------------
// Post-Run — Screen 4
// ---------------------------------------------------------------------------

function PostRunSummary() {
  const phase = useTrafficStore((s) => s.phase)

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="flex flex-col gap-4 p-4 max-w-5xl mx-auto w-full"
    >
      <SummaryCard />
      {phase === 'FAILED' && <FailureAnalysis />}
      <CallTable />
      <DownloadReport />
    </motion.div>
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
  livePair: { uac: { vm_ip: string; metrics_port: number; vm_id?: string }; uas: { vm_ip: string; metrics_port: number } },
  isFinal = false
): Promise<boolean> {
  const [uacCalls, uasCalls] = await Promise.all([
    getCallsFor(livePair.uac.vm_ip, livePair.uac.metrics_port),
    getCallsFor(livePair.uas.vm_ip, livePair.uas.metrics_port),
  ])

  const allEvents = [...uacCalls, ...uasCalls]
  allEvents.sort((a, b) =>
    new Date(a.ts_utc ?? a.timestamp ?? 0).getTime() -
    new Date(b.ts_utc ?? b.timestamp ?? 0).getTime()
  )
  if (allEvents.length === 0) return false

  const { setCallEvents, setAggregate, uacMetrics } = useTrafficStore.getState()
  setCallEvents(allEvents)

  if (isFinal) {
    const { currentRunId, setCallSpines } = useTrafficStore.getState()
    const runId = currentRunId || `run-${livePair.uac.vm_id ?? 'local'}-${Date.now()}`
    const startedAt = uacMetrics?.run_elapsed_seconds
      ? new Date(Date.now() - uacMetrics.run_elapsed_seconds * 1000).toISOString()
      : new Date().toISOString()

    setAggregate(buildAggregate(uacCalls, uasCalls, runId, startedAt))

    // Fetch correlated call spines from UAC backend
    const spines = await getCallSpinesFor(livePair.uac.vm_ip, livePair.uac.metrics_port)
    setCallSpines(spines)
  }

  return true
}

// ---------------------------------------------------------------------------
// Root page — orchestrator
// ---------------------------------------------------------------------------

export default function RunPage() {
  const phase = useTrafficStore((s) => s.phase)
  const wsStatus = useTrafficStore((s) => s.wsStatus)
  const pair = useTrafficStore((s) => s.pairs[s.activePairIndex])
  const { setPhase, updateUACMetrics, updateUASMetrics, setWsStatus, setCallEvents, setAggregate } =
    useTrafficStore()

  const [stopping, setStopping] = useState(false)

  const mockTickRef = useRef(0)
  const mockUacRef = useRef<TrafficMetrics>(MOCK_UAC_METRICS)
  const mockUasRef = useRef<TrafficMetrics>(MOCK_UAS_METRICS)

  // ------------------------------------------------------------------
  // MOCK_MODE: simulate live metrics + auto-transition to COMPLETE
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!IS_MOCK) return

    if (phase === 'IDLE' || phase === 'PRE_PHASE') {
      setPhase('TRAFFIC')
    }

    setWsStatus('uac', 'connected')
    setWsStatus('uas', 'connected')

    updateUACMetrics(mockUacRef.current)
    updateUASMetrics(mockUasRef.current)

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
      mockUasRef.current = simulateMetricsTick(
        mockUasRef.current,
        totalCompleted,
        totalCompleted,
        0
      )

      updateUACMetrics(mockUacRef.current)
      updateUASMetrics(mockUasRef.current)

      if (tick >= 20) {
        clearInterval(interval)
        setCallEvents(MOCK_CALL_EVENTS)
        const runId = useTrafficStore.getState().currentRunId || MOCK_AGGREGATE.run_id
        setAggregate({
          ...MOCK_AGGREGATE,
          run_id: runId,
          total_attempted: totalAttempted,
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
  // Stop Traffic handler
  // ------------------------------------------------------------------
  const handleStop = async () => {
    setStopping(true)

    if (IS_MOCK) {
      setCallEvents(MOCK_CALL_EVENTS)
      setAggregate({
        ...MOCK_AGGREGATE,
        ended_at: new Date().toISOString(),
      })
      setPhase('COMPLETE')
      return
    }

    try {
      await fetch(
        `http://${pair?.uac.vm_ip ?? '127.0.0.1'}:${pair?.uac.metrics_port ?? 8082}/api/test/stop`,
        { method: 'POST' }
      )
    } catch {
      setStopping(false)
    }
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
    let callsFetched = false

    const finish = async (targetPhase: RunPhase) => {
      if (completed) return
      completed = true
      if (intervalId !== null) clearInterval(intervalId)

      // Fetch call events one last time (isFinal=true builds aggregate from events)
      const gotEvents = await fetchAndStoreCallEvents(livePair, true)

      // Fallback: if we couldn't reach backends for call events, build
      // aggregate from the last-known metrics snapshot
      if (!gotEvents) {
        buildAggregateFromStore()
      }

      setPhase(targetPhase)
    }

    const poll = async () => {
      if (completed) return

      let uacReachable = false
      let uasReachable = false
      let uacPhase = ''
      let uasPhase = ''

      const [uacResult, uasResult] = await Promise.all([
        getMetricsFor(livePair.uac.vm_ip, livePair.uac.metrics_port).catch(() => null),
        getMetricsFor(livePair.uas.vm_ip, livePair.uas.metrics_port).catch(() => null),
      ])

      if (uacResult) {
        uacReachable = true
        updateUACMetrics(uacResult)
        uacPhase = (uacResult as unknown as { phase: string }).phase ?? ''
      }
      if (uasResult) {
        uasReachable = true
        updateUASMetrics(uasResult)
        uasPhase = (uasResult as unknown as { phase: string }).phase ?? ''
      }

      // At least one backend is alive — attempt phase detection + call fetch
      if (uacReachable || uasReachable) {
        consecutiveFailures = 0

        // Continuously fetch call events while backends are alive so we
        // always have the latest snapshot — the backends may exit before
        // we get another chance.
        const currentPhase = useTrafficStore.getState().phase
        if (
          !callsFetched &&
          (currentPhase === 'TRAFFIC' || uacPhase === 'TRAFFIC' || uacPhase === 'STOPPING' || uacPhase === 'DONE')
        ) {
          callsFetched = await fetchAndStoreCallEvents(livePair)
        }

        if (uacPhase || uasPhase) {
          const livePhase = mapBackendPhase(
            uacPhase || 'IDLE',
            uasPhase || 'IDLE'
          )

          if (livePhase === 'COMPLETE' || livePhase === 'FAILED') {
            // Backends reporting DONE — finish will handle final call fetch
            await finish(livePhase)
            return
          }

          setPhase(livePhase)
        }
        return
      }

      // Both unreachable — backends likely exited
      consecutiveFailures++
      const storePhase = useTrafficStore.getState().phase
      if (
        consecutiveFailures >= 3 &&
        (storePhase === 'TRAFFIC' || storePhase === 'PRE_PHASE')
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

  useMetricsStream(
    vmWsUrl(pair?.uas.vm_ip ?? '127.0.0.1', pair?.uas.metrics_port ?? 8081),
    {
      onMetrics: (metrics) => {
        const m = metrics.find((m) => m.vm_id === pair?.uas.vm_id) ?? metrics[0]
        if (m) updateUASMetrics(m)
      },
      onStatusChange: (status) => setWsStatus('uas', status),
    },
    !IS_MOCK
  )

  const isTraffic = phase === 'TRAFFIC'
  const isPostRun = phase === 'COMPLETE' || phase === 'FAILED'
  const showReconnectBanner =
    !IS_MOCK &&
    isTraffic &&
    (wsStatus.uac !== 'connected' || wsStatus.uas !== 'connected')

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <ReconnectBanner visible={showReconnectBanner} />
      <div className="relative flex items-center justify-center border-b border-border px-6 py-4">
        <div className="absolute left-6">
          <Link
            href="/config"
            className={[
              'flex items-center gap-2 rounded-md border px-3 py-1.5',
              'border-sky-500/50 text-sky-400',
              'text-sm font-semibold tracking-wide',
              'hover:border-sky-400 hover:bg-sky-500/15 hover:text-sky-300',
              'transition-all duration-200',
            ].join(' ')}
          >
            <Home className="size-4" strokeWidth={2.5} />
            <span>Home</span>
          </Link>
        </div>
        <StepIndicator />
      </div>
      <main className="flex-1 overflow-y-auto py-2">
        <AnimatePresence mode="wait">
          {isTraffic && (
            <motion.div
              key="live"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center"
            >
              <LiveDashboard stopping={stopping} onStop={handleStop} />
            </motion.div>
          )}
          {isPostRun && (
            <motion.div
              key="postrun"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="flex flex-col items-center"
            >
              <PostRunSummary />
            </motion.div>
          )}
          {!isTraffic && !isPostRun && (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="flex flex-1 items-center justify-center py-20"
            >
              <p className="font-mono text-sm text-muted-foreground">
                Waiting for traffic phase to start…
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  )
}
