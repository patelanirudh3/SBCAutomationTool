'use client'

import { cn } from '@/lib/utils'
import type { TrafficMetrics } from '@/types'

interface AggregatePanelProps {
  uacMetrics: TrafficMetrics
  className?: string
}

export function AggregatePanel({ uacMetrics, className }: AggregatePanelProps) {
  const asr = uacMetrics.asr
  const asrColor =
    asr > 90 ? 'text-emerald-400' : asr >= 80 ? 'text-amber-400' : 'text-rose-500'

  return (
    <div
      className={cn(
        'flex items-center gap-6 rounded-lg border border-border bg-card px-5 py-3',
        className
      )}
    >
      <Stat label="Total Attempted" value={uacMetrics.calls_attempted.toLocaleString()} />
      <div className="h-6 w-px bg-border" />
      <Stat
        label="Completed"
        value={uacMetrics.calls_completed.toLocaleString()}
        valueClass="text-emerald-400"
      />
      <div className="h-6 w-px bg-border" />
      <Stat
        label="Failed"
        value={uacMetrics.calls_failed.toLocaleString()}
        valueClass={uacMetrics.calls_failed > 0 ? 'text-rose-500' : undefined}
      />
      <div className="h-6 w-px bg-border" />
      <Stat label="Aggregate ASR" value={`${asr.toFixed(1)}%`} valueClass={asrColor} />
    </div>
  )
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-widest text-foreground/65">
        {label}
      </span>
      <span className={cn('font-mono text-base font-semibold tabular-nums', valueClass)}>
        {value}
      </span>
    </div>
  )
}
