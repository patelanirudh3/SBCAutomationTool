'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, Play, ArrowRight, Users, CheckCircle2, XCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useTrafficStore } from '@/store/traffic'
import { getMetricsFor, startPrePhaseFor, startTrafficFor, startTestFor } from '@/lib/api'
import { cn } from '@/lib/utils'

// How often to poll metrics during pre-phase
const POLL_INTERVAL_MS = 2_000

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
// PoolCountBadge — shows idle / non-idle / reg-only counts
// ---------------------------------------------------------------------------

function CountBadge({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: 'emerald' | 'amber' | 'slate' | 'rose'
}) {
  const cls = {
    emerald: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    amber:   'border-amber-500/30 bg-amber-500/10 text-amber-400',
    slate:   'border-slate-600/40 bg-slate-700/20 text-slate-300',
    rose:    'border-rose-500/30 bg-rose-500/10 text-rose-400',
  }[color]

  return (
    <div className={cn('flex flex-col items-center rounded-lg border px-4 py-3', cls)}>
      <span className="text-2xl font-bold font-mono">{value}</span>
      <span className="mt-0.5 text-[11px] font-medium tracking-wide">{label}</span>
    </div>
  )
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
    nonIdleCount,
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
  const [localNonIdleCount, setLocalNonIdleCount] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [isStartingReg, setIsStartingReg] = useState(false)
  const [isStartingTraffic, setIsStartingTraffic] = useState(false)

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const isMock  = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'

  // Sync pool counts from store (populated via WS metrics)
  useEffect(() => {
    setLocalIdleCount(idleCount)
    setLocalNonIdleCount(nonIdleCount)
    setLocalRegOnlyCount(regOnlyCount)
  }, [idleCount, nonIdleCount, regOnlyCount])

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

        setRegCount(m.registered_count ?? 0)
        setSubCount(m.subscribed_count ?? 0)
        setLocalIdleCount(m.idle_count ?? 0)
        setLocalRegOnlyCount(m.reg_only_count ?? 0)
        setLocalNonIdleCount(m.non_idle_count ?? 0)

        const phase = m.phase ?? ''
        if (phase === 'TRAFFIC_READY' || phase === 'TRAFFIC' || phase === 'CLEANUP_READY' || phase === 'DONE') {
          stopPolling()
          setRegDone(true)
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

    // Generate run_id
    const pad = (x: number) => String(x).padStart(2, '0')
    const now = new Date()
    const runId = `run-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    setCurrentRunId(runId)

    try {
      // First, start the traffic engine (test/start) to launch the backend process
      await startTestFor(vmIp, vmPort, runId, pair?.pair_id ?? 'pair-1')
      // Then signal prephase/start to begin registration
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

  // Mock mode: clicking Start Traffic navigates immediately
  const handleMockStartTraffic = useCallback(() => {
    setPhase('TRAFFIC')
    router.push('/run')
  }, [setPhase, router])

  // ---------------------------------------------------------------------------
  // Derived display values
  // ---------------------------------------------------------------------------

  const displayIdle   = isMock ? localIdleCount   : (idleCount    > 0 ? idleCount    : localIdleCount)
  const displayRegOnly= isMock ? localRegOnlyCount : (regOnlyCount > 0 ? regOnlyCount : localRegOnlyCount)
  const displayNonIdle= isMock ? localNonIdleCount : (nonIdleCount > 0 ? nonIdleCount : localNonIdleCount)
  const canStartTraffic = displayIdle >= 2
  const total = Math.max(extCount, 1)
  const regPct = Math.round((regCount / total) * 100)
  const subPct = Math.round((subCount / total) * 100)

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
                disabled={isStartingReg}
                className="gap-2 bg-emerald-600 hover:bg-emerald-500 text-white"
              >
                {isStartingReg ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Starting…
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

          {/* ── Progress bars ─────────────────────────────────── */}
          {regStarted && (
            <div className="space-y-4 rounded-xl border border-border bg-card p-5">
              <h3 className="text-sm font-semibold text-foreground">Registration Progress</h3>

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
                <Progress value={regPct} className="h-2" />
              </div>

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
                <Progress value={subPct} className="h-2" />
              </div>
            </div>
          )}

          {/* ── Pool counts ───────────────────────────────────── */}
          {regStarted && (
            <div className="grid grid-cols-3 gap-3">
              <CountBadge label="Idle (ready)" value={displayIdle}    color="emerald" />
              <CountBadge label="Reg-only"     value={displayRegOnly} color="amber"   />
              <CountBadge label="Active calls" value={displayNonIdle} color="slate"   />
            </div>
          )}

          {/* ── Completion status ─────────────────────────────── */}
          {regDone && (
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
                    {displayRegOnly} user{displayRegOnly === 1 ? '' : 's'} registered but not subscribed (reg-only list).
                  </p>
                )}
              </div>
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
