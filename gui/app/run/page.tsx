'use client'

import { useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { WifiOff } from 'lucide-react'

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
import {
  MOCK_UAC_METRICS,
  MOCK_UAS_METRICS,
  MOCK_CALL_EVENTS,
  MOCK_AGGREGATE,
  simulateMetricsTick,
} from '@/lib/mock-data'
import type { TrafficMetrics } from '@/types'

const IS_MOCK = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'

// ---------------------------------------------------------------------------
// Live Dashboard — Screen 3
// ---------------------------------------------------------------------------

function LiveDashboard() {
  const uacMetrics = useTrafficStore((s) => s.uacMetrics)
  const uasMetrics = useTrafficStore((s) => s.uasMetrics)
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  const pair = pairs[activePairIndex]
  const configuredCps = pair?.uac.cps ?? 2

  // Ceiling = registered extensions count (or configured ext range)
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

  return (
    <div className="flex flex-col gap-4 p-4 max-w-6xl mx-auto w-full">
      {/* Row 1 — Hero: ASR + RunTimer */}
      <div className="rounded-lg border border-border bg-card p-5 flex items-center gap-6">
        <ASRGauge asr={uacMetrics.asr} className="flex-1 min-w-0" />
        <RunTimer elapsed={uacMetrics.run_elapsed_seconds} />
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
// Root page — orchestrator
// ---------------------------------------------------------------------------

export default function RunPage() {
  const phase = useTrafficStore((s) => s.phase)
  const wsStatus = useTrafficStore((s) => s.wsStatus)
  const { setPhase, updateMetrics, setWsStatus, setCallEvents, setAggregate } =
    useTrafficStore()

  const mockTickRef = useRef(0)
  const mockUacRef = useRef<TrafficMetrics>(MOCK_UAC_METRICS)
  const mockUasRef = useRef<TrafficMetrics>(MOCK_UAS_METRICS)

  // ------------------------------------------------------------------
  // MOCK_MODE: simulate live metrics + auto-transition to COMPLETE
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!IS_MOCK) return

    // If arriving here with IDLE phase, assume we came straight from launch
    if (phase === 'IDLE' || phase === 'PRE_PHASE') {
      setPhase('TRAFFIC')
    }

    setWsStatus('connected')

    // Seed initial metrics immediately
    updateMetrics(mockUacRef.current, mockUasRef.current)

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

      updateMetrics(mockUacRef.current, mockUasRef.current)

      // Auto-complete after ~20 updates
      if (tick >= 20) {
        clearInterval(interval)
        setCallEvents(MOCK_CALL_EVENTS)
        setAggregate({
          ...MOCK_AGGREGATE,
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
  // Live mode: connect WebSocket
  // ------------------------------------------------------------------
  useMetricsStream(
    {
      onMetrics: (metrics) => {
        const uac = metrics.find((m) => m.vm_id.startsWith('uac'))
        const uas = metrics.find((m) => m.vm_id.startsWith('uas'))
        if (uac && uas) updateMetrics(uac, uas)
        else if (uac) updateMetrics(uac, uac)
      },
      onStatusChange: (s) => setWsStatus(s),
    },
    !IS_MOCK
  )

  const isTraffic = phase === 'TRAFFIC'
  const isPostRun = phase === 'COMPLETE' || phase === 'FAILED'
  const showReconnectBanner =
    !IS_MOCK && isTraffic && (wsStatus === 'reconnecting' || wsStatus === 'disconnected')

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <ReconnectBanner visible={showReconnectBanner} />
      <div className="flex justify-center py-4 border-b border-border">
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
              <LiveDashboard />
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
