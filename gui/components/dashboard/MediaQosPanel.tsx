'use client'

import { Activity, Gauge, BarChart3, Construction, Timer } from 'lucide-react'
import { cn } from '@/lib/utils'

interface MediaQosPanelProps {
  jitterMs?: number | null
  mosEstimate?: number | null
  qosScore?: number | null
  /** Round-trip time from RTCP SR/RR. Only meaningful when RTCP SR
   *  transmission is enabled in Advanced Settings (Phase 2). */
  rttMs?: number | null
  /** Whether RTCP SR transmission is enabled. When false, the RTT card is
   *  hidden because no SR has been sent and the value will always be 0. */
  rtcpSrEnabled?: boolean
}

function QosCard({
  icon: Icon,
  label,
  value,
  unit,
  pending,
}: {
  icon: React.ElementType
  label: string
  value?: number | null
  unit?: string
  pending: boolean
}) {
  return (
    <div className={cn(
      'flex flex-col items-center gap-2 rounded-xl border p-4',
      pending ? 'border-slate-700/40 bg-slate-800/30' : 'border-sky-500/25 bg-sky-500/5',
    )}>
      <Icon className={cn('size-5', pending ? 'text-slate-500' : 'text-sky-400')} />
      <div className="text-center">
        {pending || value == null ? (
          <span className="block font-mono text-lg font-bold text-slate-500">—</span>
        ) : (
          <span className="block font-mono text-lg font-bold text-sky-300">
            {typeof value === 'number' ? value.toFixed(1) : value}
            {unit && <span className="ml-0.5 text-xs text-slate-400">{unit}</span>}
          </span>
        )}
        <span className="text-[11px] text-slate-400">{label}</span>
      </div>
    </div>
  )
}

export function MediaQosPanel({ jitterMs, mosEstimate, qosScore, rttMs, rtcpSrEnabled }: MediaQosPanelProps) {
  const isPending = jitterMs == null && mosEstimate == null && qosScore == null

  // RTT card is shown only when RTCP SR is enabled — otherwise the SBC has
  // never received an SR from us so the field would always read 0/—.
  const showRtt = !!rtcpSrEnabled
  const cardCount = showRtt ? 4 : 3

  return (
    <div className="rounded-xl border border-slate-700/40 bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="size-4 text-sky-400" />
        <span className="text-sm font-semibold text-slate-200">Media &amp; QoS</span>
        {isPending && (
          <span className="ml-auto flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
            <Construction className="size-3" />
            Backend pending
          </span>
        )}
        {showRtt && !isPending && (
          <span className="ml-auto rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
            RTCP SR active
          </span>
        )}
      </div>

      <div className={cn('grid gap-3', cardCount === 4 ? 'grid-cols-4' : 'grid-cols-3')}>
        <QosCard icon={Activity}  label="Jitter (ms)"   value={jitterMs}     unit="ms"  pending={jitterMs == null} />
        <QosCard icon={BarChart3} label="MOS Estimate"  value={mosEstimate}  unit=""    pending={mosEstimate == null} />
        <QosCard icon={Gauge}     label="QoS Score"     value={qosScore}     unit="%"   pending={qosScore == null} />
        {showRtt && (
          <QosCard icon={Timer}   label="RTT (ms)"      value={rttMs}        unit="ms"  pending={rttMs == null || rttMs === 0} />
        )}
      </div>

      {isPending && (
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Media quality metrics (jitter, MOS, QoS) will be populated once the backend implementation is complete.
          The UI is ready to display them automatically.
        </p>
      )}
    </div>
  )
}
