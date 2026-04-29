'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Play, ArrowRight, Users, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { getMetricsFor, startPrePhaseFor, startTrafficFor, startTestFor, resetTestFor } from '@/lib/api'
import { cn } from '@/lib/utils'

// How often to poll metrics during pre-phase
const POLL_INTERVAL_MS = 1_000

// Pre-phase live metrics shape from backend
interface PrePhaseMetrics {
  phase: string
  registered_count?: number
  subscribed_count?: number
  idle_count?: number
  non_idle_count?: number
  reg_only_count?: number
}

// ---------------------------------------------------------------------------
// LayeredBar — dual-tone progress bar (green completed + amber partial)
// ---------------------------------------------------------------------------

function LayeredBar({
  completed,
  partial = 0,
  className,
}: {
  completed: number   // 0-100 green (fully done)
  partial?: number    // 0-100 amber (partial / reg-only)
  className?: string
}) {
  return (
    <div className={cn('relative h-2 w-full overflow-hidden rounded-full bg-slate-700', className)}>
      {/* green segment */}
      <div
        className="absolute inset-y-0 left-0 bg-emerald-500 transition-all duration-500 ease-out"
        style={{ width: `${Math.min(completed, 100)}%` }}
      />
      {/* amber segment (starts where green ends) */}
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
// CountBadge — shows a single pool-count metric
// ---------------------------------------------------------------------------

function CountBadge({
  label,
  value,
  color,
  pulsing = false,
}: {
  label: string
  value: number
  color: 'emerald' | 'amber' | 'slate' | 'rose'
  pulsing?: boolean
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
// Helpers
// ---------------------------------------------------------------------------

function formatElapsed(secs: number) {
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Main PrePhasePanel
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

  const [regStarted, setRegStarted] = useState(false)
  const [regDone, setRegDone] = useState(false)
  const [regCount, setRegCount] = useState(0)
  const [subCount, setSubCount] = useState(0)
  const [localIdleCount, setLocalIdleCount] = useState(0)
  const [localRegOnlyCount, setLocalRegOnlyCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isStartingReg, setIsStartingReg] = useState(false)
  const [isStartingTraffic, setIsStartingTraffic] = useState(false)

  // Pre-run engine state check
  const [enginePhase, setEnginePhase] = useState<string | null>(null)
  const [engineCheckDone, setEngineCheckDone] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  // Elapsed timer (counts up while reg/sub is in progress)
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

  // Elapsed timer — counts up while reg is in progress, freezes when done
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

  // ---------------------------------------------------------------------------
  // Polling — checks metrics while pre-phase is running
  // ---------------------------------------------------------------------------

  const startPolling = useCallback(() => {
    stopPolling()
    pollRef.current = setInterval(async () => {
      try {
        const m = (await getMetricsFor(vmIp, vmPort)) as unknown as PrePhaseMetrics & {
          idle_count?: number; non_idle_count?: number; reg_only_count?: number
          registered_count?: number; subscribed_count?: number; phase?: string
        }

        // Feed into store so pool counts & phase badge stay current
        updateUACMetrics(m as Parameters<typeof updateUACMetrics>[0])

        const newReg = m.registered_count ?? 0
        const delta = newReg - prevRegCountRef.current
        const rate  = delta / (POLL_INTERVAL_MS / 1000)
        prevRegCountRef.current = newReg
        if (rate > 0) setRegRate(Math.round(rate * 10) / 10)

        setRegCount(newReg)
        setSubCount(m.subscribed_count ?? 0)
        setLocalIdleCount(m.idle_count ?? 0)
        setLocalRegOnlyCount(m.reg_only_count ?? 0)

        const phase = m.phase ?? ''
        if (phase === 'TRAFFIC_READY' || phase === 'TRAFFIC' || phase === 'CLEANUP_READY' || phase === 'DONE') {
          stopPolling()
          setRegDone(true)
          setRegRate(0)
          setPhase('TRAFFIC_READY')
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
        // transient error — keep polling
      }
    }, POLL_INTERVAL_MS)
  }, [vmIp, vmPort, pair, extCount, stopPolling, setPhase, setPrePhaseStatus, updateUACMetrics])

  // ---------------------------------------------------------------------------
  // Pre-run engine state check — runs once on mount (live mode only)
  // ---------------------------------------------------------------------------

  const checkEngineReady = useCallback(async () => {
    if (isMock) {
      setEngineCheckDone(true)
      setEnginePhase('IDLE')
      return
    }
    try {
      const m = await getMetricsFor(vmIp, vmPort) as unknown as { phase?: string }
      setEnginePhase((m.phase ?? 'IDLE').toUpperCase())
    } catch {
      setEnginePhase('IDLE')
    } finally {
      setEngineCheckDone(true)
    }
  }, [isMock, vmIp, vmPort])

  useEffect(() => {
    checkEngineReady()
  }, [checkEngineReady])

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

  // ---------------------------------------------------------------------------
  // MOCK mode — auto-simulate pre-phase on mount
  // ---------------------------------------------------------------------------

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
    setPhase('PRE_PHASE')

    const tick = 200
    let reg = 0
    let sub = 0

    const iv = setInterval(() => {
      if (reg < n) {
        reg = Math.min(reg + 1, n)
        setRegCount(reg)
      }
      if (sub < reg - 1) {
        sub = Math.min(sub + 1, reg - 1)
        setSubCount(sub)
        setLocalIdleCount(sub)
      }
      if (reg >= n && sub >= n) {
        clearInterval(iv)
        setRegDone(true)
        setRegRate(0)
        setLocalIdleCount(n)
        setLocalRegOnlyCount(0)
        setPhase('TRAFFIC_READY')
        setPrePhaseStatus({
          vm_id: pair?.uac.vm_id ?? 'traffic-local',
          register_complete: true,
          register_count: n,
          register_total: n,
          subscribe_complete: true,
          subscribe_count: n,
          subscribe_total: n,
          extensions_ready: true,
          idle_count: n,
          reg_only_count: 0,
        })
      }
    }, tick)
    return () => clearInterval(iv)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMock])

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleStartRegSub = useCallback(async () => {
    if (isStartingReg) return
    setIsStartingReg(true)
    setError(null)

    const pad = (x: number) => String(x).padStart(2, '0')
    const now = new Date()
    const runId = `run-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    setCurrentRunId(runId)

    try {
      await startTestFor(vmIp, vmPort, runId, pair?.pair_id ?? 'pair-1')
      await startPrePhaseFor(vmIp, vmPort)
      setRegStarted(true)
      setPhase('PRE_PHASE')
      startPolling()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start registration'
      setError(`Could not start Reg/Sub at http://${vmIp}:${vmPort} — ${msg}`)
    } finally {
      setIsStartingReg(false)
    }
  }, [isStartingReg, vmIp, vmPort, pair, setCurrentRunId, setPhase, startPolling])

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

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------

  const displayIdle    = isMock ? localIdleCount    : (idleCount    > 0 ? idleCount    : localIdleCount)
  const displayRegOnly = isMock ? localRegOnlyCount : (regOnlyCount > 0 ? regOnlyCount : localRegOnlyCount)
  const total          = Math.max(extCount, 1)

  // "Pending" = extensions not yet registered (still queued or failed)
  const displayPending = Math.max(0, total - regCount)

  const canStartTraffic = displayIdle >= 2
  const regPct = Math.round((regCount / total) * 100)
  const subPct = Math.round((subCount / total) * 100)

  // Amber segment on the subscribe bar = reg-only (registered but not subscribed)
  const subAmberPct = Math.round((displayRegOnly / total) * 100)

  // Post-completion failed count (extensions that never made it to either pool)
  const failedCount = regDone ? Math.max(0, total - regCount) : 0

  return (
    <div className="flex flex-1 flex-col overflow-hidden">

      {/* ── Info banner ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b border-sky-500/20 bg-sky-500/5 px-5 py-2.5">
        <Users className="size-3.5 shrink-0 text-sky-400" />
        <p className="text-xs text-sky-300">
          Phase 1 — Register and subscribe all extensions. Each successful Reg+Sub adds the user to the
          idle pool. Once <span className="font-bold">≥ 2</span> users are idle, you can start traffic.
        </p>
      </div>

      {/* ── Main content ─────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-6 py-8">

          {/* ── Engine state warning ───────────────────────────── */}
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
                    <>
                      <Loader2 className="size-3.5 animate-spin" />
                      Resetting…
                    </>
                  ) : (
                    'Reset Engine'
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* ── Start button row ───────────────────────────────── */}
          {!regStarted && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-muted-foreground">
                Click <span className="font-semibold text-foreground">Reg / Sub</span> to register and
                subscribe all {extCount > 0 ? extCount : '…'} extensions.
              </p>
              <Button
                size="lg"
                onClick={isMock ? () => { hasStartedRef.current = false; handleStartRegSub() } : handleStartRegSub}
                disabled={isStartingReg || !engineIsReady || isResetting}
                className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50"
              >
                {isStartingReg ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Starting…
                  </>
                ) : !engineCheckDone ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Checking engine…
                  </>
                ) : (
                  <>
                    <Play className="size-4" />
                    Reg / Sub
                  </>
                )}
              </Button>
            </div>
          )}

          {/* ── Registration Status card ──────────────────────── */}
          {regStarted && (
            <div className="space-y-4 rounded-xl border border-border bg-card p-5">

              {/* card heading + elapsed timer + rate badge */}
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-foreground">Registration Status</h3>
                <div className="flex items-center gap-2">
                  {/* reg/s rate badge — only shown while in-progress */}
                  {!regDone && regRate > 0 && (
                    <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-400">
                      {regRate} reg/s
                    </span>
                  )}
                  {/* elapsed timer */}
                  <span className={cn(
                    'font-mono text-xs font-semibold tabular-nums',
                    regDone ? 'text-emerald-400' : 'text-foreground/70',
                  )}>
                    {formatElapsed(elapsed)}
                  </span>
                </div>
              </div>

              {/* REGISTER row */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>REGISTER</span>
                  <span className="font-mono">
                    <span className="font-semibold text-foreground">{regCount}</span> / {extCount}
                    {regCount >= extCount && (
                      <CheckCircle2 className="ml-1 inline size-3 text-emerald-400" />
                    )}
                  </span>
                </div>
                <LayeredBar completed={regPct} />
              </div>

              {/* SUBSCRIBE row */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>SUBSCRIBE</span>
                  <span className="font-mono">
                    <span className="font-semibold text-foreground">{subCount}</span> / {extCount}
                    {subCount >= extCount && (
                      <CheckCircle2 className="ml-1 inline size-3 text-emerald-400" />
                    )}
                  </span>
                </div>
                <LayeredBar completed={subPct} partial={subAmberPct} />
              </div>

            </div>
          )}

          {/* ── Pool count badges ─────────────────────────────── */}
          {regStarted && (
            <div className="grid grid-cols-3 gap-3">
              <CountBadge
                label="Ready for Traffic"
                value={displayIdle}
                color="emerald"
                pulsing={!regDone}
              />
              <CountBadge
                label="Reg w/o Sub"
                value={displayRegOnly}
                color="amber"
                pulsing={!regDone}
              />
              <CountBadge
                label="Pending"
                value={displayPending}
                color="slate"
                pulsing={!regDone}
              />
            </div>
          )}

          {/* ── Completion status ─────────────────────────────── */}
          {regDone && (
            <div className="space-y-2">
              <div className={cn(
                'flex items-start gap-3 rounded-lg border p-4',
                canStartTraffic
                  ? 'border-emerald-500/30 bg-emerald-500/5'
                  : 'border-amber-500/30 bg-amber-500/5'
              )}>
                {canStartTraffic ? (
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-400" />
                ) : (
                  <XCircle className="mt-0.5 size-4 shrink-0 text-amber-400" />
                )}
                <div>
                  <p className={cn(
                    'text-sm font-semibold',
                    canStartTraffic ? 'text-emerald-300' : 'text-amber-300'
                  )}>
                    {canStartTraffic
                      ? `${displayIdle} users in idle pool — ready for traffic`
                      : `Only ${displayIdle} idle user${displayIdle === 1 ? '' : 's'} — need at least 2 to start traffic`
                    }
                  </p>
                  {displayRegOnly > 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {displayRegOnly} user{displayRegOnly === 1 ? '' : 's'} registered but not subscribed (reg w/o sub list).
                    </p>
                  )}
                </div>
              </div>

              {/* Failed count badge — only shown if some extensions never registered */}
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

          {/* ── Error ─────────────────────────────────────────── */}
          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-4">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-400" />
              <p className="text-sm text-rose-300">{error}</p>
            </div>
          )}

          {/* ── Start Traffic button ──────────────────────────── */}
          {(regDone || (regStarted && displayIdle >= 2)) && (
            <div className="flex justify-end">
              <Button
                size="lg"
                onClick={isMock ? handleMockStartTraffic : handleStartTraffic}
                disabled={!canStartTraffic || isStartingTraffic}
                className={cn(
                  'gap-2',
                  canStartTraffic
                    ? 'bg-blue-600 hover:bg-blue-500 text-white'
                    : 'opacity-40 cursor-not-allowed'
                )}
              >
                {isStartingTraffic ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    Start Traffic
                    <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </div>
          )}

        </div>
      </div>

    </div>
  )
}
