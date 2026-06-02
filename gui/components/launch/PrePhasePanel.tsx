'use client'

import { useEffect, useCallback, useState, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle, Play, ArrowRight, Users, CheckCircle2, XCircle,
  Loader2, Sparkles, RotateCcw, ShieldOff, Download,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTrafficStore } from '@/store/traffic'
import {
  getMetricsFor, startPrepFor, startRegSubFor, abortRegSubFor,
  startTrafficFor, startTestFor, resetTestFor, startCleanupFor,
  moveHASubscriptionFor,
  APIError,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import type { HAEvent, PrepStatus, RegisterFailure, SubscribeFailure, SubscriptionEventStats } from '@/types'

const POLL_INTERVAL_MS = 1_000

interface RegSubMetrics {
  phase: string
  prep_status?: PrepStatus
  registered_count?: number
  registered_total?: number
  subscribed_count?: number
  subscribed_total?: number
  subscriptions_by_event?: Record<string, SubscriptionEventStats>
  idle_count?: number
  non_idle_count?: number
  reg_only_count?: number
  transport_connect_total?: number
  transport_connect_done?: number
  transport_connect_failed?: number
  transport_connect_active?: boolean
  transport_connect_failure_sample_limit?: number
  transport_connect_failed_details?: Array<{
    ext: string
    local_ip?: string
    remote?: string
    error?: string
  }>
  register_failed_details?: RegisterFailure[]
  subscribe_failed_details?: SubscribeFailure[]
  ha_primary_reachable?: boolean
  ha_primary_recovered_at?: string
  ha_ready_protected?: number
  ha_degraded_primary_only?: number
  ha_not_usable?: number
  ha_active_controller?: 'primary' | 'secondary' | string
  ha_move_active?: boolean
  ha_move_last_error?: string
  ha_failover_events?: number
  ha_failover_deferred?: number
  ha_events?: HAEvent[]
  ha_primary_registered?: number
  ha_secondary_registered?: number
  ha_primary_subscribed?: number
  ha_secondary_subscribed?: number
}

// ---------------------------------------------------------------------------
// LayeredBar — dual-tone progress bar (green completed + amber partial)
// ---------------------------------------------------------------------------
function LayeredBar({ completed, partial = 0, className }: {
  completed: number; partial?: number; className?: string
}) {
  return (
    <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-slate-700', className)}>
      <div
        className="absolute inset-y-0 left-0 bg-emerald-500 transition-all duration-500 ease-out"
        style={{ width: `${Math.min(completed, 100)}%` }}
      />
      {partial > 0 && (
        <div
          className="absolute inset-y-0 bg-amber-500/80 transition-all duration-500 ease-out"
          style={{
            left:  `${Math.min(completed, 100)}%`,
            width: `${Math.min(partial, 100 - completed)}%`,
          }}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CountBadge — single pool-count metric tile
// ---------------------------------------------------------------------------
function CountBadge({ label, value, color, pulsing = false }: {
  label: string; value: number; color: 'emerald' | 'amber' | 'slate' | 'rose'; pulsing?: boolean
}) {
  const cls = {
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    amber:   'border-amber-500/30 bg-amber-500/10 text-amber-400',
    slate:   'border-slate-600/40 bg-slate-700/20 text-slate-300',
    rose:    'border-rose-500/30 bg-rose-500/10 text-rose-400',
  }[color]
  return (
    <div className={cn(
      'flex flex-col items-center rounded-lg border px-4 py-3 transition-shadow',
      cls,
      pulsing && value > 0 && 'ring-1 ring-current/40 animate-pulse',
    )}>
      <span className="text-2xl font-bold font-mono">{value}</span>
      <span className="mt-0.5 text-[11px] font-medium tracking-wide">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PrepButton — corner control for the optional async unregister flush.
// Visual states (in order of lifecycle):
//   idle      → outline button "Start Prep"
//   starting  → countdown "Wiring up… Ns" while the POST /api/prep/start
//               request is in flight (server may wait up to 10 s for the
//               OnPrepStart handler to be wired during transport connect)
//   running   → sky spinner "Cleaning up…"
//   done      → green check "Prep Complete" (locked)
//   failed    → amber retry link
// ---------------------------------------------------------------------------
function PrepButton({
  status,
  disabled,
  onClick,
  startingCountdown,
}: {
  status: PrepStatus
  disabled: boolean
  onClick: () => void
  /** When non-null the request to /api/prep/start is in flight; show a
   *  countdown from this many seconds down to 0 so the operator knows
   *  why the button is "stuck". */
  startingCountdown: number | null
}) {
  // Starting state takes precedence over all other states because it
  // represents the active request lifecycle before status changes server-side.
  if (startingCountdown !== null) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-300 tabular-nums">
        <Loader2 className="size-3.5 animate-spin" />
        Wiring up… {startingCountdown}s
      </span>
    )
  }
  if (status === 'running') {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-xs font-semibold text-sky-300">
        <Loader2 className="size-3.5 animate-spin" />
        Cleaning up…
      </span>
    )
  }
  if (status === 'done') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 cursor-default">
            <CheckCircle2 className="size-3.5" />
            Prep Complete
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Stale registrations cleaned. Re-prep is locked for this session.
        </TooltipContent>
      </Tooltip>
    )
  }
  if (status === 'failed') {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className="inline-flex items-center gap-2 rounded-full border border-amber-500/40 bg-amber-500/5 px-3 py-1.5 text-xs font-semibold text-amber-300 transition hover:bg-amber-500/10 disabled:opacity-50"
      >
        <RotateCcw className="size-3.5" />
        Retry Prep
      </button>
    )
  }
  // idle
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          onClick={onClick}
          className="inline-flex items-center gap-2 rounded-full border border-slate-600 bg-slate-800/60 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-sky-500/50 hover:text-sky-300 hover:bg-sky-500/10 disabled:opacity-50"
        >
          <Sparkles className="size-3.5" />
          Start Prep
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Optional: clear stale registrations from a previous run before Reg/Sub.
      </TooltipContent>
    </Tooltip>
  )
}

function formatElapsed(secs: number) {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Main PrePhasePanel — handles REGSUB_READY, REGSUB_RUNNING, REGSUB_DONE
// states inside a single component. The optional Prep button lives in the
// top-right corner and runs independently of Reg/Sub.
// ---------------------------------------------------------------------------
export function PrePhasePanel() {
  const router = useRouter()
  const {
    pairs,
    activePairIndex,
    setPhase,
    setPrePhaseStatus,
    setCurrentRunId,
    idleCount,
    regOnlyCount,
    uacMetrics,
    updateUACMetrics,
  } = useTrafficStore()

  const pair = pairs[activePairIndex]
  const vmIp   = pair?.uac.vm_ip   ?? '127.0.0.1'
  const vmPort = pair?.uac.metrics_port ?? 8082
  const extCount = pair ? (pair.uac.ext_end ?? 0) - (pair.uac.ext_start ?? 0) + 1 : 0
  const subscribeEventCount = Math.max(pair?.uac.subscribe_events?.length ?? 1, 1)
  const subscribeTxnFallback = extCount * subscribeEventCount

  const [prepStatus, setPrepStatus] = useState<PrepStatus>('idle')
  const [regStarted, setRegStarted] = useState(false)
  const [regDone, setRegDone] = useState(false)
  const [regCount, setRegCount] = useState(0)
  const [subCount, setSubCount] = useState(0)
  const [regTotal, setRegTotal] = useState(0)
  const [subTotal, setSubTotal] = useState(0)
  const [subByEvent, setSubByEvent] = useState<Record<string, SubscriptionEventStats>>({})
  const [localIdleCount, setLocalIdleCount] = useState(0)
  const [localRegOnlyCount, setLocalRegOnlyCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isStartingPrep, setIsStartingPrep] = useState(false)
  // Server-side wait for OnPrepStart wiring is up to 10 s. Show a countdown
  // so the operator knows the button isn't hung. null = no request in flight.
  const PREP_START_TIMEOUT_S = 10
  const [prepCountdown, setPrepCountdown] = useState<number | null>(null)
  const [isStartingReg, setIsStartingReg] = useState(false)
  const [isStartingTraffic, setIsStartingTraffic] = useState(false)
  const [isAborting, setIsAborting] = useState(false)
  const [isUnregisteringAll, setIsUnregisteringAll] = useState(false)
  const [haBusy, setHaBusy] = useState<'primary' | 'secondary' | null>(null)
  const [haError, setHaError] = useState<string | null>(null)

  // Pre-run engine state check
  const [enginePhase, setEnginePhase] = useState<string | null>(null)
  const [engineCheckDone, setEngineCheckDone] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // Elapsed timer (counts up during reg/sub)
  const [elapsed, setElapsed] = useState(0)

  // Live reg/s rate
  const [regRate, setRegRate] = useState(0)
  const prevRegCountRef = useRef(0)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMock  = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'

  // Sync idle / reg-only counts from store (populated via WS metrics)
  useEffect(() => {
    setLocalIdleCount(idleCount)
    setLocalRegOnlyCount(regOnlyCount)
  }, [idleCount, regOnlyCount])

  useEffect(() => {
    if (!regStarted || regDone) return
    const id = setInterval(() => setElapsed(e => e + 1), 1000)
    return () => clearInterval(id)
  }, [regStarted, regDone])

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])
  useEffect(() => () => stopPolling(), [stopPolling])

  // ------------------------------------------------------------------
  // Polling — reads metrics during prep AND reg/sub. Polls always while
  // mounted (cheap) so we can pick up prep_status transitions even when
  // Reg/Sub hasn't started yet.
  // ------------------------------------------------------------------
  const startPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const m = (await getMetricsFor(vmIp, vmPort)) as unknown as RegSubMetrics

        updateUACMetrics(m as Parameters<typeof updateUACMetrics>[0])

        if (m.prep_status) setPrepStatus(m.prep_status)

        const newReg = m.registered_count ?? 0
        const delta = newReg - prevRegCountRef.current
        const rate  = delta / (POLL_INTERVAL_MS / 1000)
        prevRegCountRef.current = newReg
        if (rate > 0) setRegRate(Math.round(rate * 10) / 10)

        setRegCount(newReg)
        setSubCount(m.subscribed_count ?? 0)
        setSubByEvent(m.subscriptions_by_event ?? {})
        if ((m.registered_total ?? 0) > 0) setRegTotal(m.registered_total ?? 0)
        if ((m.subscribed_total ?? 0) > 0) setSubTotal(m.subscribed_total ?? 0)
        setLocalIdleCount(m.idle_count ?? 0)
        setLocalRegOnlyCount(m.reg_only_count ?? 0)

        const phase = (m.phase ?? '').toUpperCase()
        if (phase === 'FAILED') {
          setRegDone(false)
          setRegRate(0)
          setPhase('FAILED')
          setError('Reg/Sub failed. Review transport, register, and subscribe diagnostics below.')
          return
        }
        if (phase === 'REGSUB_DONE' || phase === 'TRAFFIC_READY' || phase === 'TRAFFIC' || phase === 'CLEANUP_READY' || phase === 'DONE') {
          setRegDone(true)
          setRegRate(0)
          setPhase('REGSUB_DONE')
          setPrePhaseStatus({
            vm_id: pair?.uac.vm_id ?? 'traffic-local',
            register_complete: true,
            register_count: m.registered_count ?? 0,
            register_total: extCount,
            subscribe_complete: true,
            subscribe_count: m.subscribed_count ?? 0,
            subscribe_total: subscribeTxnFallback,
            extensions_ready: (m.idle_count ?? 0) >= 2,
            idle_count: m.idle_count,
            reg_only_count: m.reg_only_count,
          })
        }
      } catch {
        // transient — keep polling
      }
    }, POLL_INTERVAL_MS)
  }, [vmIp, vmPort, pair, extCount, subscribeTxnFallback, stopPolling, setPhase, setPrePhaseStatus, updateUACMetrics])

  // ------------------------------------------------------------------
  // Engine state check on mount
  // ------------------------------------------------------------------
  const checkEngineReady = useCallback(async () => {
    if (isMock) {
      setEngineCheckDone(true)
      setEnginePhase('IDLE')
      return
    }
    try {
      const m = await getMetricsFor(vmIp, vmPort) as unknown as { phase?: string; prep_status?: PrepStatus }
      setEnginePhase((m.phase ?? 'IDLE').toUpperCase())
      if (m.prep_status) setPrepStatus(m.prep_status)
    } catch {
      setEnginePhase('IDLE')
    } finally {
      setEngineCheckDone(true)
    }
  }, [isMock, vmIp, vmPort])
  useEffect(() => { checkEngineReady() }, [checkEngineReady])

  // Always start polling on mount so Prep status updates live even before
  // Reg/Sub kicks off. Stops automatically on unmount via the cleanup above.
  useEffect(() => {
    if (isMock) return
    startPolling()
  }, [isMock, startPolling])

  const handleResetEngine = useCallback(async () => {
    setIsResetting(true)
    setError(null)
    try {
      await resetTestFor(vmIp, vmPort)
    } catch { /* ignore — engine may already be idle */ }
    await checkEngineReady()
    setIsResetting(false)
  }, [vmIp, vmPort, checkEngineReady])

  const engineIsReady = !engineCheckDone || enginePhase === 'IDLE' || enginePhase === null

  // ------------------------------------------------------------------
  // Handlers
  // ------------------------------------------------------------------
  const ensureRunIdAndStartTest = useCallback(async () => {
    const pad = (x: number) => String(x).padStart(2, '0')
    const now = new Date()
    const runId = `run-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    setCurrentRunId(runId)
    await startTestFor(vmIp, vmPort, runId, pair?.pair_id ?? 'pair-1')
  }, [vmIp, vmPort, pair, setCurrentRunId])

  const handleStartPrep = useCallback(async () => {
    if (isStartingPrep || prepStatus === 'running' || prepStatus === 'done') return
    setIsStartingPrep(true)
    setError(null)
    // Kick off a 1 Hz countdown that mirrors the backend's max wait window
    // for OnPrepStart wiring. Stops as soon as the request returns.
    setPrepCountdown(PREP_START_TIMEOUT_S)
    const tick = setInterval(() => {
      setPrepCountdown((n) => (n == null || n <= 1 ? n : n - 1))
    }, 1000)
    try {
      // Prep needs the engine in CONFIGURED state (StartFunc spawned). The
      // backend lifecycle blocks at REGSUB_READY waiting for our gate.
      await ensureRunIdAndStartTest()
      await startPrepFor(vmIp, vmPort)
      setPrepStatus('running')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start prep'
      setError(`Could not start Prep at http://${vmIp}:${vmPort} — ${msg}`)
    } finally {
      clearInterval(tick)
      setPrepCountdown(null)
      setIsStartingPrep(false)
    }
  }, [isStartingPrep, prepStatus, vmIp, vmPort, ensureRunIdAndStartTest])

  const handleStartRegSub = useCallback(async () => {
    if (isStartingReg) return
    if (prepStatus === 'running') return // defensive — UI also disables
    setIsStartingReg(true)
    setError(null)
    try {
      // ensureRunIdAndStartTest is idempotent — if Prep already kicked it
      // off the second call returns 409 which we swallow.
      try { await ensureRunIdAndStartTest() } catch { /* already started */ }
      await startRegSubFor(vmIp, vmPort)
      setRegStarted(true)
      setPhase('REGSUB_RUNNING')
    } catch (err) {
      // Treat 409 as benign — it means the lifecycle already advanced past
      // REGSUB_READY (e.g. another tab clicked first, the click was a
      // duplicate, or a stale buffered signal was consumed). Polling will
      // catch up the GUI state automatically; flip the local flag now so
      // the progress bars render immediately rather than waiting for the
      // next polling tick.
      if (err instanceof APIError && err.status === 409) {
        setRegStarted(true)
        setPhase('REGSUB_RUNNING')
      } else {
        const msg = err instanceof Error ? err.message : 'Failed to start reg/sub'
        setError(`Could not start Reg/Sub at http://${vmIp}:${vmPort} — ${msg}`)
      }
    } finally {
      setIsStartingReg(false)
    }
  }, [isStartingReg, prepStatus, vmIp, vmPort, ensureRunIdAndStartTest, setPhase])

  const handleAbortRegSub = useCallback(async () => {
    if (isAborting) return
    setIsAborting(true)
    setError(null)
    try {
      await abortRegSubFor(vmIp, vmPort)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Abort failed'
      setError(`Abort failed: ${msg}`)
    } finally {
      setIsAborting(false)
    }
  }, [isAborting, vmIp, vmPort])

  const handleUnregisterAll = useCallback(async () => {
    if (isUnregisteringAll) return
    setIsUnregisteringAll(true)
    setError(null)
    try {
      await startCleanupFor(vmIp, vmPort)
      setPhase('CLEANING_UP')
      router.push('/run')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unregister failed'
      setError(`Unregister failed: ${msg}`)
      setIsUnregisteringAll(false)
    }
  }, [isUnregisteringAll, vmIp, vmPort, setPhase, router])

  const handleHAMove = useCallback(async (target: 'primary' | 'secondary') => {
    if (haBusy) return
    setHaBusy(target)
    setHaError(null)
    try {
      await moveHASubscriptionFor(vmIp, vmPort, target)
      const m = await getMetricsFor(vmIp, vmPort)
      updateUACMetrics(m)
    } catch (err) {
      setHaError(err instanceof Error ? err.message : 'HA subscription move failed')
    } finally {
      setHaBusy(null)
    }
  }, [haBusy, vmIp, vmPort, updateUACMetrics])

  const handleDownloadHATimeline = useCallback(() => {
    const payload = {
      generated_at: new Date().toISOString(),
      active_controller: uacMetrics?.ha_active_controller ?? 'primary',
      primary_reachable: uacMetrics?.ha_primary_reachable ?? null,
      events: uacMetrics?.ha_events ?? [],
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ha-timeline-${pair?.pair_id ?? 'pair'}-${Date.now()}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [pair?.pair_id, uacMetrics])

  const handleStartTraffic = useCallback(async () => {
    if (isStartingTraffic) return
    setIsStartingTraffic(true)
    setError(null)
    try {
      await startTrafficFor(vmIp, vmPort)
      setPhase('TRAFFIC')
      router.push('/run')
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start traffic'
      setError(`Could not start traffic at http://${vmIp}:${vmPort} — ${msg}`)
      setIsStartingTraffic(false)
    }
  }, [isStartingTraffic, vmIp, vmPort, setPhase, router])

  const handleMockStartTraffic = useCallback(() => {
    setPhase('TRAFFIC')
    router.push('/run')
  }, [setPhase, router])

  // MOCK mode — auto-simulate so the UI is still browsable without a backend
  const hasStartedRef = useRef(false)
  useEffect(() => {
    if (!isMock || hasStartedRef.current) return
    hasStartedRef.current = true
    const n = Math.max(extCount, 10)
    const pad = (x: number) => String(x).padStart(2, '0')
    const now = new Date()
    const runId = `run-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    setCurrentRunId(runId)
    setRegStarted(true)
    setRegTotal(n)
    setSubTotal(n * subscribeEventCount)
    setPhase('REGSUB_RUNNING')
    let reg = 0
    let sub = 0
    const iv = setInterval(() => {
      if (reg < n) { reg = Math.min(reg + 1, n); setRegCount(reg) }
      if (sub < reg - 1) { sub = Math.min(sub + 1, reg - 1); setSubCount(sub); setLocalIdleCount(sub) }
      if (reg >= n && sub >= n) {
        clearInterval(iv)
        setRegDone(true)
        setRegRate(0)
        setLocalIdleCount(n)
        setLocalRegOnlyCount(0)
        setPhase('REGSUB_DONE')
        setPrePhaseStatus({
          vm_id: pair?.uac.vm_id ?? 'traffic-local',
          register_complete: true, register_count: n, register_total: n,
          subscribe_complete: true, subscribe_count: n, subscribe_total: n,
          extensions_ready: true, idle_count: n, reg_only_count: 0,
        })
      }
    }, 200)
    return () => clearInterval(iv)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMock])

  // ------------------------------------------------------------------
  // Derived display values
  // ------------------------------------------------------------------
  const displayIdle    = isMock ? localIdleCount    : (idleCount    > 0 ? idleCount    : localIdleCount)
  const displayRegOnly = isMock ? localRegOnlyCount : (regOnlyCount > 0 ? regOnlyCount : localRegOnlyCount)
  const total          = Math.max(extCount, 1)
  const displayPending = Math.max(0, total - regCount)
  const canStartTraffic = displayIdle >= 2
  const transportTotal = uacMetrics?.transport_connect_total ?? 0
  const transportConnected = uacMetrics?.transport_connect_done ?? 0
  const transportFailed = uacMetrics?.transport_connect_failed ?? 0
  const configuredExtensions = transportTotal > 0 ? transportTotal : total
  const registerAttempted = regTotal > 0 ? regTotal : (transportConnected > 0 ? transportConnected : total)
  const registerFailed = regDone ? Math.max(0, registerAttempted - regCount) : 0
  const subscribeFailedAgents = regDone ? displayRegOnly : 0
  const excludedFromTraffic = Math.max(0, configuredExtensions - displayIdle)
  const registerFailureDetails = uacMetrics?.register_failed_details ?? []
  const subscribeFailureDetails = uacMetrics?.subscribe_failed_details ?? []
  const haActiveController = uacMetrics?.ha_active_controller ?? 'primary'
  const haPrimaryReachable = uacMetrics?.ha_primary_reachable ?? haActiveController === 'primary'
  const primaryFailbackBlocked = haActiveController === 'secondary' && !haPrimaryReachable
  const regBarPct = useMemo(() => {
    const denom = regTotal > 0 ? regTotal : extCount
    return denom > 0 ? Math.round((regCount / denom) * 100) : 0
  }, [regCount, regTotal, extCount])
  const subBarPct = useMemo(() => {
    const denom = subTotal > 0 ? subTotal : subscribeTxnFallback
    return denom > 0 ? Math.round((subCount / denom) * 100) : 0
  }, [subCount, subTotal, subscribeTxnFallback])
  const subAmberPct = Math.round((displayRegOnly / total) * 100)
  const failedCount = regDone ? Math.max(0, total - regCount) : 0

  // regSubViewActive — derived flag that tells us "the Reg/Sub flow is in
  // progress or has produced data, so render the progress card and pool
  // badges". Driving this from polling-derived state (regCount, regTotal,
  // etc.) instead of just the local regStarted click flag means a browser
  // refresh during pre-phase still surfaces the progress UI even though
  // the click handler in this component instance never ran. Also covers
  // the 409 "click was too late" path — polling has already populated
  // regCount/regTotal so the card renders immediately.
  const regSubViewActive =
    regStarted ||
    regDone ||
    (uacMetrics?.phase ?? '').toUpperCase() === 'CONNECTING_TRANSPORTS' ||
    regCount > 0 ||
    regTotal > 0 ||
    subCount > 0 ||
    subTotal > 0

  // The Prep button is locked while running OR while Reg/Sub has started.
  const prepDisabled = prepStatus === 'running' || prepStatus === 'done' || isStartingPrep || regStarted || !engineIsReady

  // Start Reg/Sub is disabled while Prep is running (defensive — backend
  // also returns 409). Also disabled while engine is in a non-clean state.
  const startRegSubBlocked = prepStatus === 'running'
  const startRegSubDisabled = isStartingReg || !engineIsReady || isResetting || startRegSubBlocked

  return (
    <div className="flex flex-1 flex-col overflow-hidden">

      {/* ── Top bar with phase banner + corner Prep button ─────────────────── */}
      <div className="flex items-center gap-2 border-b border-sky-500/20 bg-sky-500/5 px-5 py-2.5">
        <Users className="size-3.5 shrink-0 text-sky-400" />
        <p className="flex-1 text-xs text-sky-300">
          Reg / Sub — register and subscribe all extensions. Each successful Reg+Sub adds the user to the
          idle pool. Once <span className="font-bold">≥ 2</span> users are idle, you can start traffic.
        </p>
        <PrepButton
          status={prepStatus}
          disabled={prepDisabled}
          onClick={handleStartPrep}
          startingCountdown={prepCountdown}
        />
      </div>

      {/* ── Main content ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">

          {/* ── Engine state warning ──────────────────────────────────── */}
          {!regStarted && engineCheckDone && !engineIsReady && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-400" />
                <div>
                  <p className="text-sm font-semibold text-amber-300">
                    Engine not in a clean state
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    The traffic engine at{' '}
                    <span className="font-mono text-amber-200">{vmIp}:{vmPort}</span> is currently
                    in <span className="font-mono font-semibold text-amber-300">{enginePhase}</span>{' '}
                    state. Reset it before starting a new run, or previous SIP registrations may
                    conflict.
                  </p>
                </div>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isResetting}
                  onClick={handleResetEngine}
                  className="gap-2 border-amber-500/40 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                >
                  {isResetting ? (
                    <><Loader2 className="size-3.5 animate-spin" /> Resetting…</>
                  ) : 'Reset Engine'}
                </Button>
              </div>
            </div>
          )}

          {/* ── Start button row ──────────────────────────────────────── */}
          {/* Gated on the derived regSubViewActive flag, not just
              !regStarted, so a refresh after pre-phase has already
              completed (regDone=true via polling) doesn't expose a
              destructive re-register click. The pool-counts row + ready
              banner below render in that case instead. */}
          {!regSubViewActive && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-muted-foreground text-center">
                Click <span className="font-semibold text-foreground">Start Reg / Sub</span> to register
                and subscribe all {extCount > 0 ? extCount : '…'} extensions.
                {prepStatus === 'idle' && (
                  <>
                    <br />
                    <span className="text-xs">
                      If a previous run left stale registrations on the SBC, click
                      {' '}<span className="font-semibold text-sky-300">Start Prep</span> in the top
                      right first.
                    </span>
                  </>
                )}
              </p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-block">
                    <Button
                      size="lg"
                      onClick={isMock ? () => { hasStartedRef.current = false; handleStartRegSub() } : handleStartRegSub}
                      disabled={startRegSubDisabled}
                      className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
                    >
                      {isStartingReg ? (
                        <><Loader2 className="size-4 animate-spin" /> Starting…</>
                      ) : !engineCheckDone ? (
                        <><Loader2 className="size-4 animate-spin" /> Checking engine…</>
                      ) : (
                        <><Play className="size-4" /> Start Reg / Sub</>
                      )}
                    </Button>
                  </span>
                </TooltipTrigger>
                {startRegSubBlocked && (
                  <TooltipContent side="top">
                    Wait for Prep to finish before starting Reg/Sub.
                  </TooltipContent>
                )}
              </Tooltip>
            </div>
          )}

          {uacMetrics && (uacMetrics.transport_connect_total ?? 0) > 0 && (
            <div className="space-y-3 rounded-xl border border-slate-700/50 bg-card p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">TCP/TLS Connections</h3>
                <span className="font-mono text-xs text-muted-foreground">
                  {(uacMetrics.transport_connect_done ?? 0).toLocaleString()} / {(uacMetrics.transport_connect_total ?? 0).toLocaleString()} connected
                  {(uacMetrics.transport_connect_failed ?? 0) > 0 ? ` · ${(uacMetrics.transport_connect_failed ?? 0).toLocaleString()} failed` : ''}
                </span>
              </div>
              <LayeredBar
                completed={(uacMetrics.transport_connect_total ?? 0) > 0
                  ? ((uacMetrics.transport_connect_done ?? 0) / (uacMetrics.transport_connect_total ?? 1)) * 100
                  : 0}
                partial={(uacMetrics.transport_connect_total ?? 0) > 0
                  ? ((uacMetrics.transport_connect_failed ?? 0) / (uacMetrics.transport_connect_total ?? 1)) * 100
                  : 0}
              />
              {(uacMetrics.transport_connect_failed_details?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-xs">
                  <div className="mb-2 font-semibold text-rose-300">
                    Showing first {Math.min(10, uacMetrics.transport_connect_failed_details?.length ?? 0)} of {(uacMetrics.transport_connect_failure_sample_limit ?? 100)} captured failure details.
                  </div>
                  <div className="space-y-1">
                    {uacMetrics.transport_connect_failed_details?.slice(0, 10).map((f) => (
                      <div key={`${f.ext}-${f.local_ip}-${f.error}`} className="grid grid-cols-[80px_130px_150px_1fr] gap-2 font-mono text-[11px] text-rose-100">
                        <span>{f.ext}</span>
                        <span>{f.local_ip || '—'}</span>
                        <span>{f.remote || '—'}</span>
                        <span className="truncate" title={f.error}>{f.error || 'connect failed'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Registration Status card ──────────────────────────────── */}
          {regSubViewActive && (
            <div className="space-y-4 rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Reg / Sub Status</h3>
                <div className="flex items-center gap-2">
                  {!regDone && regRate > 0 && (
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      {regRate} reg/s
                    </span>
                  )}
                  <span className={cn(
                    'font-mono text-xs font-semibold tabular-nums',
                    regDone ? 'text-emerald-400' : 'text-foreground/70',
                  )}>
                    {formatElapsed(elapsed)}
                  </span>
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>REGISTER</span>
                  <span className="font-mono">
                    <span className="font-semibold text-foreground">{regCount}</span> / {regTotal > 0 ? regTotal : extCount}
                    {regCount >= (regTotal > 0 ? regTotal : extCount) && (
                      <CheckCircle2 className="ml-1 inline size-3 text-emerald-400" />
                    )}
                  </span>
                </div>
                <LayeredBar completed={regBarPct} />
              </div>

              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>SUBSCRIBE</span>
                  <span className="font-mono">
                    <span className="font-semibold text-foreground">{subCount}</span> / {subTotal > 0 ? subTotal : subscribeTxnFallback}
                    {subCount >= (subTotal > 0 ? subTotal : subscribeTxnFallback) && subTotal > 0 && (
                      <CheckCircle2 className="ml-1 inline size-3 text-emerald-400" />
                    )}
                  </span>
                </div>
                <LayeredBar completed={subBarPct} partial={subAmberPct} />
                {Object.keys(subByEvent).length > 0 && (
                  <div className="grid gap-1 rounded-lg border border-slate-800 bg-slate-950/35 p-2 text-[11px]">
                    {Object.entries(subByEvent).map(([event, stats]) => (
                      <div key={event} className="flex items-center justify-between gap-3">
                        <span className="truncate text-slate-400">{event}</span>
                        <span className="shrink-0 font-mono text-slate-300">
                          <span className="text-emerald-300">{stats.successful}</span>
                          /{stats.total}
                          <span className="ml-2 text-sky-300">N:{stats.notify_received}</span>
                          {stats.failed > 0 && <span className="ml-2 text-rose-300">F:{stats.failed}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {pair?.uac.dual_registration_enabled && regDone && (
            <div className="space-y-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-sky-100">Remote Server HA</h3>
                  <p className="text-xs text-slate-400">
                    Active controller: <span className="font-mono text-sky-300">{haActiveController}</span>
                  </p>
                  <p className="text-xs text-slate-500">
                    Auto failovers: {uacMetrics?.ha_failover_events ?? 0}
                    {(uacMetrics?.ha_failover_deferred ?? 0) > 0 ? ` · deferred ${uacMetrics?.ha_failover_deferred}` : ''}
                  </p>
                  {haActiveController === 'secondary' && (
                    <p className={cn('text-xs', haPrimaryReachable ? 'text-emerald-300' : 'text-amber-300')}>
                      Primary recovery: {haPrimaryReachable ? 'reachable for manual failback' : 'waiting for recovered transport'}
                      {uacMetrics?.ha_primary_recovered_at ? ` · ${uacMetrics.ha_primary_recovered_at}` : ''}
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={(uacMetrics?.ha_events?.length ?? 0) === 0}
                    onClick={handleDownloadHATimeline}
                    className="gap-1.5"
                  >
                    <Download className="size-3" />
                    Timeline
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!!haBusy || (uacMetrics?.ha_move_active ?? false) || primaryFailbackBlocked}
                    onClick={() => handleHAMove('primary')}
                    className="gap-1.5"
                  >
                    {haBusy === 'primary' && <Loader2 className="size-3 animate-spin" />}
                    Move to Primary
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!!haBusy || (uacMetrics?.ha_move_active ?? false)}
                    onClick={() => handleHAMove('secondary')}
                    className="gap-1.5"
                  >
                    {haBusy === 'secondary' && <Loader2 className="size-3 animate-spin" />}
                    Move to Secondary
                  </Button>
                </div>
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 p-2">
                  <div className="font-bold uppercase tracking-wide text-slate-400">Primary</div>
                  <div className="mt-1 font-mono text-slate-200">Registered {uacMetrics?.ha_primary_registered ?? regCount}</div>
                  <div className="font-mono text-slate-200">Subscribed {uacMetrics?.ha_primary_subscribed ?? subCount}</div>
                </div>
                <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 p-2">
                  <div className="font-bold uppercase tracking-wide text-slate-400">Secondary</div>
                  <div className="mt-1 font-mono text-slate-200">Registered {uacMetrics?.ha_secondary_registered ?? 0}</div>
                  <div className="font-mono text-slate-200">Subscribed {uacMetrics?.ha_secondary_subscribed ?? 0}</div>
                </div>
              </div>
              <div className="grid gap-2 text-xs sm:grid-cols-3">
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
                  <div className="font-bold uppercase tracking-wide text-emerald-400/80">HA Protected</div>
                  <div className="mt-1 font-mono text-slate-100">{uacMetrics?.ha_ready_protected ?? 0}</div>
                  <div className="mt-0.5 text-[11px] text-emerald-300/70">active + standby ready</div>
                </div>
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
                  <div className="font-bold uppercase tracking-wide text-amber-400/80">Degraded</div>
                  <div className="mt-1 font-mono text-slate-100">{uacMetrics?.ha_degraded_primary_only ?? 0}</div>
                  <div className="mt-0.5 text-[11px] text-amber-300/70">traffic ready, failover reduced</div>
                </div>
                <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-2">
                  <div className="font-bold uppercase tracking-wide text-rose-400/80">Not Usable</div>
                  <div className="mt-1 font-mono text-slate-100">{uacMetrics?.ha_not_usable ?? 0}</div>
                  <div className="mt-0.5 text-[11px] text-rose-300/70">excluded from traffic</div>
                </div>
              </div>
              {(uacMetrics?.ha_degraded_primary_only ?? 0) > 0 && (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Some ready users are running without full standby protection. Traffic can continue, but failover capacity is reduced.
                </div>
              )}
              {haError && (
                <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                  {haError}
                </div>
              )}
              {uacMetrics?.ha_move_last_error && (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Last HA move error: {uacMetrics.ha_move_last_error}
                </div>
              )}
              {(uacMetrics?.ha_events?.length ?? 0) > 0 && (
                <div className="rounded-lg border border-slate-700/50 bg-slate-950/30 p-2 text-xs">
                  <div className="mb-1 font-bold uppercase tracking-wide text-slate-400">HA Timeline</div>
                  <div className="space-y-1">
                    {uacMetrics?.ha_events?.slice(-5).reverse().map((ev, idx) => (
                      <div key={`${ev.timestamp}-${ev.type}-${idx}`} className="grid grid-cols-[135px_120px_1fr] gap-2 font-mono text-[11px] text-slate-300">
                        <span className="text-slate-500">{ev.timestamp}</span>
                        <span className="text-sky-300">{ev.type}{ev.target ? `:${ev.target}` : ''}</span>
                        <span className="truncate" title={ev.details}>{ev.details || '—'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ── Pool count badges ─────────────────────────────────────── */}
          {regSubViewActive && (
            <div className="grid grid-cols-3 gap-3">
              <CountBadge label="Ready for Traffic" value={displayIdle}    color="emerald" pulsing={!regDone} />
              <CountBadge label="Reg w/o Sub"       value={displayRegOnly} color="amber"   pulsing={!regDone} />
              <CountBadge label="Pending"           value={displayPending} color="slate"   pulsing={!regDone} />
            </div>
          )}

          {/* ── Abort button (visible only while reg/sub running) ─────── */}
          {regSubViewActive && !regDone && !isMock && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="outline"
                disabled={isAborting}
                onClick={handleAbortRegSub}
                className="gap-2 border-amber-500/40 text-amber-300 hover:bg-amber-500/10"
              >
                {isAborting ? (
                  <><Loader2 className="size-3.5 animate-spin" /> Aborting…</>
                ) : (
                  <><ShieldOff className="size-3.5" /> Abort</>
                )}
              </Button>
            </div>
          )}

          {/* ── Completion summary ────────────────────────────────────── */}
          {regDone && (
            <div className="space-y-2">
              <div className="rounded-xl border border-slate-700/50 bg-slate-950/30 p-4">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-100">Readiness Decision</h3>
                    <p className="text-xs text-slate-400">
                      Traffic uses only fully subscribed idle extensions. Excluded extensions stay out of the ready pool.
                    </p>
                  </div>
                  <span className={cn(
                    'rounded-full px-2.5 py-1 text-xs font-semibold',
                    canStartTraffic ? 'bg-emerald-500/10 text-emerald-300' : 'bg-amber-500/10 text-amber-300',
                  )}>
                    {canStartTraffic ? 'User can continue' : 'Blocked'}
                  </span>
                </div>
                <div className="grid gap-2 text-xs sm:grid-cols-5">
                  <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-2">
                    <div className="text-slate-500">Configured</div>
                    <div className="mt-1 font-mono text-base font-semibold text-slate-100">{configuredExtensions.toLocaleString()}</div>
                  </div>
                  <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-2">
                    <div className="text-slate-500">Connected</div>
                    <div className="mt-1 font-mono text-base font-semibold text-slate-100">{(transportTotal > 0 ? transportConnected : registerAttempted).toLocaleString()}</div>
                    {transportFailed > 0 && <div className="mt-0.5 font-mono text-[11px] text-rose-300">-{transportFailed.toLocaleString()}</div>}
                  </div>
                  <div className="rounded-lg border border-slate-700/60 bg-slate-900/50 p-2">
                    <div className="text-slate-500">Registered</div>
                    <div className="mt-1 font-mono text-base font-semibold text-slate-100">{regCount.toLocaleString()}</div>
                    {registerFailed > 0 && <div className="mt-0.5 font-mono text-[11px] text-rose-300">-{registerFailed.toLocaleString()}</div>}
                  </div>
                  <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2">
                    <div className="text-emerald-400/80">Ready</div>
                    <div className="mt-1 font-mono text-base font-semibold text-emerald-300">{displayIdle.toLocaleString()}</div>
                  </div>
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2">
                    <div className="text-amber-400/80">Excluded</div>
                    <div className="mt-1 font-mono text-base font-semibold text-amber-300">{excludedFromTraffic.toLocaleString()}</div>
                    {subscribeFailedAgents > 0 && <div className="mt-0.5 font-mono text-[11px] text-amber-200">sub failed {subscribeFailedAgents.toLocaleString()}</div>}
                  </div>
                </div>
                {canStartTraffic ? (
                  <p className="mt-3 text-xs text-slate-400">
                    Continue only if you are comfortable running traffic with {displayIdle.toLocaleString()} fully ready extensions.
                  </p>
                ) : (
                  <p className="mt-3 text-xs text-amber-300">
                    At least 2 fully subscribed idle extensions are required before traffic can start.
                  </p>
                )}
              </div>

              <div className={cn(
                'flex items-start gap-3 rounded-lg border p-4',
                canStartTraffic ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-amber-500/30 bg-amber-500/5'
              )}>
                {canStartTraffic ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-amber-400" />
                )}
                <div>
                  <p className={cn('text-sm font-semibold', canStartTraffic ? 'text-emerald-300' : 'text-amber-300')}>
                    {canStartTraffic
                      ? `${displayIdle} users in idle pool — ready for traffic`
                      : `Only ${displayIdle} idle user${displayIdle === 1 ? '' : 's'} — need at least 2 to start traffic`}
                  </p>
                  {displayRegOnly > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {displayRegOnly} user{displayRegOnly === 1 ? '' : 's'} registered but not subscribed (reg w/o sub list).
                    </p>
                  )}
                </div>
              </div>

              {(failedCount > 0 || transportFailed > 0) && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-2.5">
                  <XCircle className="size-3.5 shrink-0 text-rose-400" />
                  <p className="text-xs text-rose-300">
                    {transportFailed > 0 && (
                      <>
                        <span className="font-semibold">{transportFailed}</span> transport connection failure{transportFailed === 1 ? '' : 's'}
                      </>
                    )}
                    {transportFailed > 0 && failedCount > 0 && ' · '}
                    {failedCount > 0 && (
                      <>
                        <span className="font-semibold">{failedCount}</span> extension{failedCount === 1 ? '' : 's'} failed to register.
                      </>
                    )}
                  </p>
                </div>
              )}

              {(registerFailureDetails.length > 0 || subscribeFailureDetails.length > 0) && (
                <div className="space-y-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-xs">
                  <div className="font-semibold text-rose-300">Failure diagnostics</div>
                  {registerFailureDetails.length > 0 && (
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-rose-300/80">
                        REGISTER failures
                      </div>
                      <div className="space-y-1">
                        {registerFailureDetails.slice(0, 10).map((f) => (
                          <div key={`reg-${f.ext}`} className="grid grid-cols-[90px_1fr] gap-2 font-mono text-[11px] text-rose-100">
                            <span>{f.ext}</span>
                            <span className="truncate" title={f.error}>{f.error || 'registration failed'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {subscribeFailureDetails.length > 0 && (
                    <div>
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-rose-300/80">
                        SUBSCRIBE failures
                      </div>
                      <div className="space-y-1">
                        {subscribeFailureDetails.slice(0, 10).map((f) => (
                          <div key={`sub-${f.ext}`} className="grid grid-cols-[90px_160px_1fr] gap-2 font-mono text-[11px] text-rose-100">
                            <span>{f.ext}</span>
                            <span className="truncate" title={f.events}>{f.events || 'events'}</span>
                            <span className="truncate" title={f.error}>{f.error || 'subscription failed'}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ── Error ──────────────────────────────────────────────────── */}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-400" />
              <p className="text-sm text-rose-300">{error}</p>
            </div>
          )}

          {/* ── Action buttons (Unregister All + Start Traffic) ──────── */}
          {(regDone || (regStarted && displayIdle >= 2)) && (
            <div className="flex justify-between gap-3">
              <Button
                size="lg"
                variant="outline"
                disabled={isUnregisteringAll || isStartingTraffic}
                onClick={handleUnregisterAll}
                className="gap-2 border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
              >
                {isUnregisteringAll ? (
                  <><Loader2 className="size-4 animate-spin" /> Unregistering…</>
                ) : (
                  <><ShieldOff className="size-4" /> Unregister All</>
                )}
              </Button>
              <Button
                size="lg"
                onClick={isMock ? handleMockStartTraffic : handleStartTraffic}
                disabled={!canStartTraffic || isStartingTraffic || isUnregisteringAll}
                className={cn(
                  'gap-2',
                  canStartTraffic
                    ? 'bg-blue-600 hover:bg-blue-500 text-white'
                    : 'opacity-40 cursor-not-allowed'
                )}
              >
                {isStartingTraffic ? (
                  <><Loader2 className="size-4 animate-spin" /> Starting…</>
                ) : (
                  <>Start Traffic with {displayIdle.toLocaleString()} Ready <ArrowRight className="size-4" /></>
                )}
              </Button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
