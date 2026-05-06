'use client'

import { useEffect, useCallback, useState, useRef, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  AlertTriangle, Play, ArrowRight, Users, CheckCircle2, XCircle,
  Loader2, Sparkles, RotateCcw, ShieldOff,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTrafficStore } from '@/store/traffic'
import {
  getMetricsFor, startPrepFor, startRegSubFor, abortRegSubFor,
  startTrafficFor, startTestFor, resetTestFor, startCleanupFor,
} from '@/lib/api'
import { cn } from '@/lib/utils'
import type { PrepStatus } from '@/types'

const POLL_INTERVAL_MS = 1_000

interface RegSubMetrics {
  phase: string
  prep_status?: PrepStatus
  registered_count?: number
  registered_total?: number
  subscribed_count?: number
  subscribed_total?: number
  idle_count?: number
  non_idle_count?: number
  reg_only_count?: number
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
// Three locked states: idle (clickable) -> running (spinner) -> done (locked
// green check). Failed shows a small retry link.
// ---------------------------------------------------------------------------
function PrepButton({
  status,
  disabled,
  onClick,
}: {
  status: PrepStatus
  disabled: boolean
  onClick: () => void
}) {
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
    updateUACMetrics,
  } = useTrafficStore()

  const pair = pairs[activePairIndex]
  const vmIp   = pair?.uac.vm_ip   ?? '127.0.0.1'
  const vmPort = pair?.uac.metrics_port ?? 8082
  const extCount = pair ? (pair.uac.ext_end ?? 0) - (pair.uac.ext_start ?? 0) + 1 : 0

  const [prepStatus, setPrepStatus] = useState<PrepStatus>('idle')
  const [regStarted, setRegStarted] = useState(false)
  const [regDone, setRegDone] = useState(false)
  const [regCount, setRegCount] = useState(0)
  const [subCount, setSubCount] = useState(0)
  const [regTotal, setRegTotal] = useState(0)
  const [subTotal, setSubTotal] = useState(0)
  const [localIdleCount, setLocalIdleCount] = useState(0)
  const [localRegOnlyCount, setLocalRegOnlyCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isStartingPrep, setIsStartingPrep] = useState(false)
  const [isStartingReg, setIsStartingReg] = useState(false)
  const [isStartingTraffic, setIsStartingTraffic] = useState(false)
  const [isAborting, setIsAborting] = useState(false)
  const [isUnregisteringAll, setIsUnregisteringAll] = useState(false)

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
        if ((m.registered_total ?? 0) > 0) setRegTotal(m.registered_total ?? 0)
        if ((m.subscribed_total ?? 0) > 0) setSubTotal(m.subscribed_total ?? 0)
        setLocalIdleCount(m.idle_count ?? 0)
        setLocalRegOnlyCount(m.reg_only_count ?? 0)

        const phase = (m.phase ?? '').toUpperCase()
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
            subscribe_total: extCount,
            extensions_ready: (m.idle_count ?? 0) >= 2,
            idle_count: m.idle_count,
            reg_only_count: m.reg_only_count,
          })
        }
      } catch {
        // transient — keep polling
      }
    }, POLL_INTERVAL_MS)
  }, [vmIp, vmPort, pair, extCount, stopPolling, setPhase, setPrePhaseStatus, updateUACMetrics])

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
      const msg = err instanceof Error ? err.message : 'Failed to start reg/sub'
      setError(`Could not start Reg/Sub at http://${vmIp}:${vmPort} — ${msg}`)
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
    setSubTotal(n)
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
  const regBarPct = useMemo(() => {
    const denom = regTotal > 0 ? regTotal : extCount
    return denom > 0 ? Math.round((regCount / denom) * 100) : 0
  }, [regCount, regTotal, extCount])
  const subBarPct = useMemo(() => {
    const denom = subTotal > 0 ? subTotal : extCount
    return denom > 0 ? Math.round((subCount / denom) * 100) : 0
  }, [subCount, subTotal, extCount])
  const subAmberPct = Math.round((displayRegOnly / total) * 100)
  const failedCount = regDone ? Math.max(0, total - regCount) : 0

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
          {!regStarted && (
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

          {/* ── Registration Status card ──────────────────────────────── */}
          {regStarted && (
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
                    <span className="font-semibold text-foreground">{subCount}</span> / {subTotal > 0 ? subTotal : extCount}
                    {subCount >= (subTotal > 0 ? subTotal : extCount) && subTotal > 0 && (
                      <CheckCircle2 className="ml-1 inline size-3 text-emerald-400" />
                    )}
                  </span>
                </div>
                <LayeredBar completed={subBarPct} partial={subAmberPct} />
              </div>
            </div>
          )}

          {/* ── Pool count badges ─────────────────────────────────────── */}
          {regStarted && (
            <div className="grid grid-cols-3 gap-3">
              <CountBadge label="Ready for Traffic" value={displayIdle}    color="emerald" pulsing={!regDone} />
              <CountBadge label="Reg w/o Sub"       value={displayRegOnly} color="amber"   pulsing={!regDone} />
              <CountBadge label="Pending"           value={displayPending} color="slate"   pulsing={!regDone} />
            </div>
          )}

          {/* ── Abort button (visible only while reg/sub running) ─────── */}
          {regStarted && !regDone && !isMock && (
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

              {failedCount > 0 && (
                <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 px-4 py-2.5">
                  <XCircle className="size-3.5 shrink-0 text-rose-400" />
                  <p className="text-xs text-rose-300">
                    <span className="font-semibold">{failedCount}</span> extension{failedCount === 1 ? '' : 's'} failed to register.
                  </p>
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
                  <>Start Traffic <ArrowRight className="size-4" /></>
                )}
              </Button>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}
