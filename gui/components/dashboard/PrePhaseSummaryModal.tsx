'use client'

import { useState } from 'react'
import { CheckCircle2, XCircle, Play, XOctagon, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'
import { startTrafficFor } from '@/lib/api'
import { selectedEngineEndpoint } from '@/lib/engine-endpoint'

// ---------------------------------------------------------------------------
// Stat row
// ---------------------------------------------------------------------------

function StatRow({ label, value, sub, variant = 'default' }: {
  label: string
  value: string | number
  sub?: string
  variant?: 'default' | 'success' | 'danger' | 'warning'
}) {
  const valCls = {
    default: 'text-slate-100',
    success: 'text-emerald-400',
    danger:  'text-rose-400',
    warning: 'text-amber-400',
  }[variant]

  return (
    <div className="flex items-baseline justify-between border-b border-slate-700/40 py-2 last:border-0">
      <span className="text-sm text-slate-400">{label}</span>
      <div className="text-right">
        <span className={cn('font-mono text-sm font-semibold', valCls)}>{String(value)}</span>
        {sub && <span className="ml-1.5 text-[11px] text-slate-500">{sub}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PrePhaseSummaryModal
// ---------------------------------------------------------------------------

interface PrePhaseSummaryModalProps {
  elapsedSeconds: number
  onAbort: () => void
}

export function PrePhaseSummaryModal({ elapsedSeconds, onAbort }: PrePhaseSummaryModalProps) {
  const prePhaseStatus = useTrafficStore((s) => s.prePhaseStatus)
  const pairs          = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)
  const setPhase       = useTrafficStore((s) => s.setPhase)

  const [starting, setStarting] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const pair       = pairs[activePairIndex]
  const endpoint   = selectedEngineEndpoint(pair?.uac)
  const vmIp       = endpoint.ip
  const vmPort     = endpoint.port
  const extCount   = pair ? (pair.uac.ext_end - pair.uac.ext_start + 1) : 0

  const regDone  = prePhaseStatus?.register_count  ?? 0
  const regTotal = prePhaseStatus?.register_total  ?? extCount
  const regFail  = prePhaseStatus?.failed_count    ?? 0
  const subDone  = prePhaseStatus?.subscribe_count ?? 0
  const subTotal = prePhaseStatus?.subscribe_total ?? extCount

  const regRate = elapsedSeconds > 0 ? Math.round(regDone / elapsedSeconds) : 0

  const m = Math.floor(elapsedSeconds / 60)
  const s = Math.floor(elapsedSeconds % 60)
  const durationLabel = `${m}m ${s}s`

  const handleStartTraffic = async () => {
    setStarting(true)
    setError(null)
    try {
      await startTrafficFor(vmIp, vmPort)
      setPhase('TRAFFIC')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start traffic')
      setStarting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-slate-700/60 bg-[#0d1425] shadow-2xl">

        {/* Header */}
        <div className="border-b border-slate-700/50 px-6 py-4">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="size-5 text-emerald-400" />
            <h2 className="text-base font-bold text-slate-100">Pre-Phase Complete</h2>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Registration and subscription finished. Review the summary before starting call traffic.
          </p>
        </div>

        {/* Summary tables */}
        <div className="px-6 py-4 space-y-5">

          {/* Registration */}
          <div>
            <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-blue-300">Registration</p>
            <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 px-4">
              <StatRow label="Registered" value={`${regDone.toLocaleString()} / ${regTotal.toLocaleString()}`}
                variant={regFail > 0 ? 'warning' : 'success'} />
              <StatRow label="Failed" value={regFail}
                variant={regFail > 0 ? 'danger' : 'default'} />
              <StatRow label="Time to complete" value={durationLabel} variant="default" />
              <StatRow label="Average rate" value={`${regRate} reg/s`} variant="default" />
            </div>
          </div>

          {/* Subscription */}
          <div>
            <p className="mb-1 text-[11px] font-bold uppercase tracking-widest text-violet-300">Subscription</p>
            <div className="rounded-lg border border-slate-700/40 bg-slate-800/30 px-4">
              <StatRow label="Subscribed" value={`${subDone.toLocaleString()} / ${subTotal.toLocaleString()}`}
                variant="success" />
              <StatRow label="Failed" value={0} variant="default" />
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-400">
              <XCircle className="size-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between border-t border-slate-700/50 px-6 py-4">
          <button
            type="button"
            onClick={onAbort}
            disabled={starting}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors',
              'border-rose-500/40 text-rose-400 hover:bg-rose-500/10',
              starting && 'cursor-not-allowed opacity-50',
            )}
          >
            <XOctagon className="size-4" />
            Abort
          </button>
          <button
            type="button"
            onClick={handleStartTraffic}
            disabled={starting}
            className={cn(
              'flex items-center gap-2 rounded-lg px-5 py-2 text-sm font-bold transition-colors',
              'bg-emerald-600 text-white hover:bg-emerald-500',
              starting && 'cursor-not-allowed opacity-70',
            )}
          >
            {starting ? (
              <><Loader2 className="size-4 animate-spin" />Starting…</>
            ) : (
              <><Play className="size-4" />Start Call Traffic</>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
