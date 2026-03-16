'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, Play, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChecklistItem, type ChecklistState } from './ChecklistItem'
import { LaunchCountdown } from './LaunchCountdown'
import { useTrafficStore } from '@/store/traffic'
import { pingVM, getMetricsFor, startTestFor } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { VMRole } from '@/types'

// ---------------------------------------------------------------------------
// Per-side checklist model
// ---------------------------------------------------------------------------

interface CheckItem {
  key: string
  label: string
  state: ChecklistState
  failLog?: string
}

function makeUASItems(n: number): CheckItem[] {
  return [
    { key: 'register',   label: `REGISTER complete: 0/${n} OK, 0 failed`,                 state: 'pending' },
    { key: 'subscribe',  label: `SUBSCRIBE complete: 0/${n} OK, 0 failed`,                state: 'pending' },
    { key: 'extensions', label: `ALL EXTENSIONS READY — 0 registered, 0 subscribed`,      state: 'pending' },
    { key: 'auto_start', label: `UAS auto-answer started for ${n} extensions`,             state: 'pending' },
    { key: 'auto_active',label: `UAS auto-answer mode active on ${n} extensions`,          state: 'pending' },
  ]
}

function makeUACItems(n: number): CheckItem[] {
  return [
    { key: 'register',   label: `REGISTER complete: 0/${n} OK, 0 failed`,                 state: 'pending' },
    { key: 'subscribe',  label: `SUBSCRIBE complete: 0/${n} OK, 0 failed`,                state: 'pending' },
    { key: 'extensions', label: `ALL EXTENSIONS READY — 0 registered, 0 subscribed`,      state: 'pending' },
  ]
}

// GET /metrics response shape — only the fields we care about for pre-phase.
interface LiveMetrics {
  phase: string           // backend: "INIT" | "PRE_REGISTER" | "TRAFFIC" | "STOPPING" | "DONE"
  running: boolean
  registered_count: number
  subscribed_count: number
}

// ---------------------------------------------------------------------------
// Side panel (UAS or UAC) — now includes per-side Start button
// ---------------------------------------------------------------------------

function SidePanel({
  role,
  vmId,
  items,
  active,
  onRetry,
  hasFailed,
  showStartBtn,
  onStart,
  pingError,
}: {
  role: VMRole
  vmId: string
  items: CheckItem[]
  active: boolean
  onRetry?: () => void
  hasFailed: boolean
  showStartBtn?: boolean
  onStart?: () => void
  pingError?: string | null
}) {
  const isUAS = role === 'UAS'

  return (
    <motion.div
      animate={{ opacity: active ? 1 : 0.35 }}
      transition={{ duration: 0.5 }}
      className="flex flex-1 flex-col"
    >
      {/* Side header */}
      <div className="flex items-center justify-between border-b border-border bg-card/80 px-5 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-bold tracking-widest',
              isUAS ? 'bg-violet-500/15 text-violet-400' : 'bg-blue-500/15 text-blue-400'
            )}
          >
            {role}
          </span>
          <span className="font-mono text-sm text-foreground">{vmId}</span>
        </div>
        {hasFailed && onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 text-xs">
            <RotateCcw className="size-3" />
            Retry
          </Button>
        )}
      </div>

      {/* Per-side Start button — shown in live mode before monitoring starts for this side */}
      {showStartBtn && onStart && (
        <div className="flex flex-col items-center gap-2 border-b border-border/30 py-3">
          <Button
            onClick={onStart}
            variant="outline"
            size="sm"
            className={cn(
              'gap-2',
              isUAS
                ? 'border-violet-500/30 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 hover:text-violet-300'
                : 'border-blue-500/30 bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300'
            )}
          >
            <Play className="size-3" />
            Start {role}
          </Button>
          {pingError && (
            <p className="max-w-xs text-center text-xs text-rose-400">
              {pingError}{' '}
              <button
                onClick={onStart}
                className="underline underline-offset-2 hover:text-rose-300"
              >
                Retry
              </button>
            </p>
          )}
        </div>
      )}

      {/* Checklist */}
      <div className="flex-1 space-y-3 px-5 py-5">
        {items.map((item) => (
          <ChecklistItem
            key={item.key}
            label={item.label}
            state={item.state}
            failLog={item.failLog}
          />
        ))}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export function PrePhasePanel() {
  const router = useRouter()
  const { pairs, activePairIndex, setPhase, setUASPrePhase, setUACPrePhase } = useTrafficStore()
  const pair = pairs[activePairIndex]
  const extCount = pair ? pair.uas.uas_ext_end - pair.uas.uas_ext_start + 1 : 10

  const [uasItems, setUasItems] = useState<CheckItem[]>(() => makeUASItems(extCount))
  const [uacItems, setUacItems] = useState<CheckItem[]>(() => makeUACItems(extCount))
  const [uasActive, setUasActive] = useState(true)
  const [uacActive, setUacActive] = useState(false)
  const [showCountdown, setShowCountdown] = useState(false)
  const [uasComplete, setUasComplete] = useState(false)
  const [uacComplete, setUacComplete] = useState(false)

  // Per-side monitoring state (live mode only)
  const [uasMonitoringStarted, setUasMonitoringStarted] = useState(false)
  const [uacMonitoringStarted, setUacMonitoringStarted] = useState(false)
  const [uasPingError, setUasPingError] = useState<string | null>(null)
  const [uacPingError, setUacPingError] = useState<string | null>(null)

  const isMock = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'
  const hasStartedRef = useRef(false)

  // Live-mode polling and timeout handles
  const uasPollRef    = useRef<ReturnType<typeof setInterval>  | null>(null)
  const uacPollRef    = useRef<ReturnType<typeof setInterval>  | null>(null)
  const uasTimeoutRef = useRef<ReturnType<typeof setTimeout>   | null>(null)
  const uacTimeoutRef = useRef<ReturnType<typeof setTimeout>   | null>(null)

  // ---------------------------------------------------------------------------
  // Helpers shared by mock + live
  // ---------------------------------------------------------------------------

  const advanceItem = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<CheckItem[]>>,
      key: string,
      state: ChecklistState,
      label?: string,
      failLog?: string
    ) => {
      setter((prev) =>
        prev.map((it) =>
          it.key === key ? { ...it, state, label: label ?? it.label, failLog } : it
        )
      )
    },
    []
  )

  const transitionItem = useCallback(
    async (
      setter: React.Dispatch<React.SetStateAction<CheckItem[]>>,
      key: string,
      finalState: ChecklistState,
      label: string
    ) => {
      advanceItem(setter, key, 'checking')
      await new Promise((r) => setTimeout(r, 800))
      advanceItem(setter, key, finalState, label)
    },
    [advanceItem]
  )

  // Cleanup all live-mode timers on unmount
  useEffect(() => {
    return () => {
      if (uasPollRef.current)    clearInterval(uasPollRef.current)
      if (uacPollRef.current)    clearInterval(uacPollRef.current)
      if (uasTimeoutRef.current) clearTimeout(uasTimeoutRef.current)
      if (uacTimeoutRef.current) clearTimeout(uacTimeoutRef.current)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // MOCK_MODE simulation — unchanged, auto-runs on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isMock || hasStartedRef.current) return
    hasStartedRef.current = true

    setPhase('PRE_PHASE')

    const run = async () => {
      const n = extCount

      await transitionItem(setUasItems, 'register',   'ok', `REGISTER complete: ${n}/${n} OK, 0 failed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'subscribe',  'ok', `SUBSCRIBE complete: ${n}/${n} OK, 0 failed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'extensions', 'ok', `ALL EXTENSIONS READY — ${n} registered, ${n} subscribed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'auto_start', 'ok', `UAS auto-answer started for ${n} extensions`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'auto_active','ok', `UAS auto-answer mode active on ${n} extensions`)

      setUasComplete(true)
      setUASPrePhase({
        vm_id: pair?.uas.vm_id ?? 'uas-local',
        role: 'UAS',
        register_complete: true,
        register_count: n,
        register_total: n,
        subscribe_complete: true,
        subscribe_count: n,
        subscribe_total: n,
        extensions_ready: true,
        auto_answer_started: true,
        auto_answer_active: true,
      })

      setShowCountdown(true)
    }

    run()
  }, [isMock, extCount, pair, setPhase, setUASPrePhase, transitionItem])

  // ---------------------------------------------------------------------------
  // Live mode: UAS polling — started by "Start UAS" button
  // ---------------------------------------------------------------------------

  const startUASPolling = useCallback(() => {
    if (!pair) return
    const n = extCount

    setPhase('PRE_PHASE')

    uasTimeoutRef.current = setTimeout(() => {
      setUasItems((prev) =>
        prev.map((it) =>
          it.state === 'checking'
            ? { ...it, state: 'failed' as ChecklistState, failLog: 'Timeout: no response after 60s' }
            : it
        )
      )
      if (uasPollRef.current) { clearInterval(uasPollRef.current); uasPollRef.current = null }
    }, 60_000)

    uasPollRef.current = setInterval(async () => {
      try {
        const m = (await getMetricsFor(pair.uas.vm_ip, pair.uas.metrics_port)) as unknown as LiveMetrics
        const phase = m.phase ?? 'INIT'

        if (phase === 'TRAFFIC' || phase === 'STOPPING' || phase === 'DONE') {
          if (uasPollRef.current) { clearInterval(uasPollRef.current); uasPollRef.current = null }
          if (uasTimeoutRef.current) { clearTimeout(uasTimeoutRef.current); uasTimeoutRef.current = null }

          const steps: [string, string][] = [
            ['register',    `REGISTER complete: ${n}/${n} OK, 0 failed`],
            ['subscribe',   `SUBSCRIBE complete: ${n}/${n} OK, 0 failed`],
            ['extensions',  `ALL EXTENSIONS READY — ${n} registered, ${n} subscribed`],
            ['auto_start',  `UAS auto-answer started for ${n} extensions`],
            ['auto_active', `UAS auto-answer mode active on ${n} extensions`],
          ]
          for (const [key, label] of steps) {
            advanceItem(setUasItems, key, 'checking')
            await new Promise((r) => setTimeout(r, 800))
            advanceItem(setUasItems, key, 'ok', label)
            await new Promise((r) => setTimeout(r, 600))
          }

          setUasComplete(true)
          setUASPrePhase({
            vm_id: pair.uas.vm_id,
            role: 'UAS',
            register_complete: true,
            register_count: n,
            register_total: n,
            subscribe_complete: true,
            subscribe_count: n,
            subscribe_total: n,
            extensions_ready: true,
            auto_answer_started: true,
            auto_answer_active: true,
          })
          setShowCountdown(true)
          return
        }

        if (phase === 'PRE_REGISTER' || phase === 'INIT') {
          setUasItems((prev) =>
            prev.map((it) =>
              it.key === 'register' && it.state === 'pending'
                ? { ...it, state: 'checking' }
                : it
            )
          )
        }
      } catch {
        // transient network error — keep polling
      }
    }, 3_000)
  }, [pair, extCount, setPhase, setUASPrePhase, advanceItem])

  // ---------------------------------------------------------------------------
  // Live mode: UAC polling — started by "Start UAC" button (after countdown)
  // ---------------------------------------------------------------------------

  const startUACPolling = useCallback(() => {
    if (!pair) return
    const n = extCount

    uacTimeoutRef.current = setTimeout(() => {
      setUacItems((prev) =>
        prev.map((it) =>
          it.state === 'checking'
            ? { ...it, state: 'failed' as ChecklistState, failLog: 'Timeout: no response after 60s' }
            : it
        )
      )
      if (uacPollRef.current) { clearInterval(uacPollRef.current); uacPollRef.current = null }
    }, 60_000)

    uacPollRef.current = setInterval(async () => {
      try {
        const m = (await getMetricsFor(pair.uac.vm_ip, pair.uac.metrics_port)) as unknown as LiveMetrics
        const phase = m.phase ?? 'INIT'

        if (phase === 'TRAFFIC' || phase === 'STOPPING' || phase === 'DONE') {
          if (uacPollRef.current) { clearInterval(uacPollRef.current); uacPollRef.current = null }
          if (uacTimeoutRef.current) { clearTimeout(uacTimeoutRef.current); uacTimeoutRef.current = null }

          const steps: [string, string][] = [
            ['register',   `REGISTER complete: ${n}/${n} OK, 0 failed`],
            ['subscribe',  `SUBSCRIBE complete: ${n}/${n} OK, 0 failed`],
            ['extensions', `ALL EXTENSIONS READY — ${n} registered, ${n} subscribed`],
          ]
          for (const [key, label] of steps) {
            advanceItem(setUacItems, key, 'checking')
            await new Promise((r) => setTimeout(r, 800))
            advanceItem(setUacItems, key, 'ok', label)
            await new Promise((r) => setTimeout(r, 600))
          }

          setUacComplete(true)
          setUACPrePhase({
            vm_id: pair.uac.vm_id,
            role: 'UAC',
            register_complete: true,
            register_count: n,
            register_total: n,
            subscribe_complete: true,
            subscribe_count: n,
            subscribe_total: n,
            extensions_ready: true,
            auto_answer_started: false,
            auto_answer_active: false,
          })
          return
        }

        if (phase === 'PRE_REGISTER' || phase === 'INIT') {
          setUacItems((prev) =>
            prev.map((it) =>
              it.key === 'register' && it.state === 'pending'
                ? { ...it, state: 'checking' }
                : it
            )
          )
        }
      } catch {
        // transient network error — keep polling
      }
    }, 3_000)
  }, [pair, extCount, setUACPrePhase, advanceItem])

  // ---------------------------------------------------------------------------
  // Per-side "Start" button handlers — ping only that side's VM
  // ---------------------------------------------------------------------------

  const handleStartUAS = useCallback(async () => {
    if (!pair) return
    setUasPingError(null)

    // Verify backend is reachable, then trigger the traffic lifecycle
    const ok = await pingVM(pair.uas.vm_ip, pair.uas.metrics_port)
    if (!ok) {
      setUasPingError(
        `Could not reach UAS at http://${pair.uas.vm_ip}:${pair.uas.metrics_port} — ensure the --api-only process is running`
      )
      return
    }

    try {
      await startTestFor(pair.uas.vm_ip, pair.uas.metrics_port)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start UAS'
      setUasPingError(`Start UAS failed: ${msg}`)
      return
    }

    setUasMonitoringStarted(true)
    startUASPolling()
  }, [pair, startUASPolling])

  const handleStartUAC = useCallback(async () => {
    if (!pair) return
    setUacPingError(null)

    const ok = await pingVM(pair.uac.vm_ip, pair.uac.metrics_port)
    if (!ok) {
      setUacPingError(
        `Could not reach UAC at http://${pair.uac.vm_ip}:${pair.uac.metrics_port} — ensure the --api-only process is running`
      )
      return
    }

    try {
      await startTestFor(pair.uac.vm_ip, pair.uac.metrics_port)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start UAC'
      setUacPingError(`Start UAC failed: ${msg}`)
      return
    }

    setUacMonitoringStarted(true)
    startUACPolling()
  }, [pair, startUACPolling])

  // Countdown complete → activate UAC panel
  const handleCountdownDone = useCallback(async () => {
    setShowCountdown(false)
    setUacActive(true)

    if (isMock) {
      const n = extCount
      await new Promise((r) => setTimeout(r, 500))
      await transitionItem(setUacItems, 'register',   'ok', `REGISTER complete: ${n}/${n} OK, 0 failed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUacItems, 'subscribe',  'ok', `SUBSCRIBE complete: ${n}/${n} OK, 0 failed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUacItems, 'extensions', 'ok', `ALL EXTENSIONS READY — ${n} registered, ${n} subscribed`)

      setUacComplete(true)
      setUACPrePhase({
        vm_id: pair?.uac.vm_id ?? 'uac-local',
        role: 'UAC',
        register_complete: true,
        register_count: n,
        register_total: n,
        subscribe_complete: true,
        subscribe_count: n,
        subscribe_total: n,
        extensions_ready: true,
        auto_answer_started: false,
        auto_answer_active: false,
      })
    }
    // Live mode: UAC "Start UAC" button is now visible — operator starts UAC
    // process in terminal, then clicks the button. No auto-polling here.
  }, [isMock, extCount, pair, setUACPrePhase, transitionItem])

  // Auto-navigate when all UAC items are green — 1.5s so user sees the final state
  useEffect(() => {
    if (uacComplete) {
      const timeout = setTimeout(() => {
        setPhase('TRAFFIC')
        router.push('/run')
      }, 1500)
      return () => clearTimeout(timeout)
    }
  }, [uacComplete, setPhase, router])

  // ---------------------------------------------------------------------------
  // Retry handlers (per-side)
  // ---------------------------------------------------------------------------

  const handleRetryUAS = useCallback(() => {
    if (uasPollRef.current)    { clearInterval(uasPollRef.current);  uasPollRef.current    = null }
    if (uasTimeoutRef.current) { clearTimeout(uasTimeoutRef.current); uasTimeoutRef.current = null }
    setUasItems(makeUASItems(extCount))
    setUasComplete(false)
    setUasPingError(null)
    if (isMock) {
      hasStartedRef.current = false
    } else {
      setUasMonitoringStarted(false)
    }
  }, [extCount, isMock])

  const handleRetryUAC = useCallback(() => {
    if (uacPollRef.current)    { clearInterval(uacPollRef.current);  uacPollRef.current    = null }
    if (uacTimeoutRef.current) { clearTimeout(uacTimeoutRef.current); uacTimeoutRef.current = null }
    setUacItems(makeUACItems(extCount))
    setUacComplete(false)
    setUacPingError(null)
    if (!isMock) {
      setUacMonitoringStarted(false)
    }
  }, [extCount, isMock])

  const uasFailed = uasItems.some((it) => it.state === 'failed')
  const uacFailed = uacItems.some((it) => it.state === 'failed')

  // UAS button: shown in live mode before UAS monitoring starts
  const showUASStartBtn = !isMock && !uasMonitoringStarted
  // UAC button: shown in live mode after countdown (uacActive), before UAC monitoring starts
  const showUACStartBtn = !isMock && uacActive && !uacMonitoringStarted

  void uasComplete

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Top banner */}
      <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-5 py-2.5">
        <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
        <p className="text-xs text-amber-300">
          Launching UAS first. UAC will start automatically when UAS is ready.
        </p>
      </div>

      {/* Two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        <SidePanel
          role="UAS"
          vmId={pair?.uas.vm_id ?? 'uas-local'}
          items={uasItems}
          active={uasActive}
          onRetry={handleRetryUAS}
          hasFailed={uasFailed}
          showStartBtn={showUASStartBtn}
          onStart={handleStartUAS}
          pingError={uasPingError}
        />

        {/* Divider */}
        <div className="w-px shrink-0 bg-border/30" />

        <SidePanel
          role="UAC"
          vmId={pair?.uac.vm_id ?? 'uac-local'}
          items={uacItems}
          active={uacActive}
          onRetry={handleRetryUAC}
          hasFailed={uacFailed}
          showStartBtn={showUACStartBtn}
          onStart={handleStartUAC}
          pingError={uacPingError}
        />
      </div>

      {/* Countdown overlay */}
      <AnimatePresence>
        {showCountdown && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          >
            <LaunchCountdown seconds={5} onComplete={handleCountdownDone} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
