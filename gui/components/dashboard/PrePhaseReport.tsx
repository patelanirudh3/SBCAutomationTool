'use client'

import { useEffect, useState } from 'react'
import { CheckCircle2, XCircle, Loader2, Clock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(secs: number): string {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function ProgressBar({
  label,
  done,
  total,
  failed,
  color,
}: {
  label: string
  done: number
  total: number
  failed: number
  color: 'blue' | 'violet'
}) {
  const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const isComplete = done >= total && total > 0

  const barCls = color === 'blue' ? 'bg-blue-500' : 'bg-violet-500'
  const textCls = color === 'blue' ? 'text-blue-400' : 'text-violet-400'

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-200">{label}</span>
        <div className="flex items-center gap-2">
          {isComplete ? (
            <span className="flex items-center gap-1 text-xs font-semibold text-emerald-400">
              <CheckCircle2 className="size-3.5" />Complete
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-amber-400">
              <Loader2 className="size-3 animate-spin" />In progress
            </span>
          )}
          {failed > 0 && (
            <span className="flex items-center gap-1 text-xs text-rose-400">
              <XCircle className="size-3" />{failed} failed
            </span>
          )}
        </div>
      </div>

      {/* Progress track */}
      <div className="relative h-3 w-full overflow-hidden rounded-full bg-slate-700/60">
        <div
          className={cn('h-full rounded-full transition-all duration-500', barCls)}
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Count row */}
      <div className="flex items-center justify-between font-mono text-xs">
        <span className={cn('font-bold', textCls)}>
          {done.toLocaleString()} / {total.toLocaleString()}
        </span>
        <span className="text-slate-400">{pct}%</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PrePhaseReport
// ---------------------------------------------------------------------------

export function PrePhaseReport() {
  const prePhaseStatus = useTrafficStore((s) => s.prePhaseStatus)
  const uacMetrics     = useTrafficStore((s) => s.uacMetrics)
  const pairs          = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  const [elapsed, setElapsed] = useState(0)
  const [regRate, setRegRate] = useState<number | null>(null)
  const [prevRegCount, setPrevRegCount] = useState(0)
  const [prevTs, setPrevTs] = useState(Date.now())

  // Wall-clock timer
  useEffect(() => {
    const id = setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Compute live registration rate
  useEffect(() => {
    const now = Date.now()
    const regCount = prePhaseStatus?.register_count ?? 0
    const dtSec = (now - prevTs) / 1000
    if (dtSec > 0.5 && regCount > prevRegCount) {
      setRegRate(Math.round((regCount - prevRegCount) / dtSec))
      setPrevRegCount(regCount)
      setPrevTs(now)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prePhaseStatus?.register_count])

  const pair = pairs[activePairIndex]
  const extCount = pair
    ? (pair.uac.ext_end - pair.uac.ext_start + 1)
    : 0

  const regDone  = prePhaseStatus?.register_count  ?? uacMetrics?.registered_count  ?? 0
  const regTotal = prePhaseStatus?.register_total  ?? extCount
  const regFail  = prePhaseStatus?.failed_count    ?? 0

  const subDone  = prePhaseStatus?.subscribe_count  ?? 0
  const subTotal = prePhaseStatus?.subscribe_total  ?? extCount
  const subFail  = 0  // backend field not yet available

  const elapsed_backend = uacMetrics?.run_elapsed_seconds ?? elapsed

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Loader2 className="size-5 animate-spin text-blue-400" />
        <div>
          <h2 className="text-lg font-bold text-slate-100">Pre-Phase: Registration &amp; Subscription</h2>
          <p className="text-sm text-slate-400">
            Registering {extCount.toLocaleString()} extensions with the SIP server…
          </p>
        </div>
      </div>

      {/* Timer + rate row */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-4 text-center">
          <Clock className="mx-auto mb-1.5 size-4 text-slate-400" />
          <p className="font-mono text-2xl font-bold text-slate-100">{fmt(elapsed_backend)}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">Elapsed</p>
        </div>
        <div className="rounded-lg border border-blue-500/25 bg-blue-500/5 p-4 text-center">
          <p className="font-mono text-2xl font-bold text-blue-400">{regDone.toLocaleString()}</p>
          <p className="mt-0.5 text-[11px] text-slate-400">Registered</p>
        </div>
        <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-4 text-center">
          <p className="font-mono text-2xl font-bold text-emerald-400">
            {regRate !== null ? `${regRate}` : '—'}
          </p>
          <p className="mt-0.5 text-[11px] text-slate-400">reg/s (live)</p>
        </div>
      </div>

      {/* Progress bars */}
      <div className="rounded-xl border border-slate-700/50 bg-slate-800/30 p-6 space-y-6">
        <ProgressBar
          label="REGISTER"
          done={regDone}
          total={regTotal}
          failed={regFail}
          color="blue"
        />
        <ProgressBar
          label="SUBSCRIBE"
          done={subDone}
          total={subTotal}
          failed={subFail}
          color="violet"
        />
      </div>

      {/* Pool counts */}
      {(prePhaseStatus?.idle_count != null || prePhaseStatus?.reg_only_count != null) && (
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-center">
            <p className="text-2xl font-bold font-mono text-emerald-400">{prePhaseStatus?.idle_count ?? 0}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Idle (ready)</p>
          </div>
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-center">
            <p className="text-2xl font-bold font-mono text-amber-400">{prePhaseStatus?.reg_only_count ?? 0}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Registered only</p>
          </div>
          <div className="rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-center">
            <p className="text-2xl font-bold font-mono text-rose-400">{prePhaseStatus?.failed_count ?? 0}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Failed</p>
          </div>
        </div>
      )}
    </div>
  )
}
