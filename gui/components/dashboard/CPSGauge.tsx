'use client'

import { cn } from '@/lib/utils'

interface CPSGaugeProps {
  actual: number
  configured: number
  className?: string
}

export function CPSGauge({ actual, configured, className }: CPSGaugeProps) {
  const ratio = configured > 0 ? actual / configured : 0
  const fillPct = Math.min(ratio * 100, 100)

  const barColor =
    ratio >= 0.9
      ? 'bg-emerald-400'
      : ratio >= 0.6
        ? 'bg-amber-400'
        : 'bg-rose-500'

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/70">CPS</span>
        <span className="font-mono text-sm tabular-nums text-foreground">
          <span className={cn('font-bold', barColor.replace('bg-', 'text-'))}>
            {actual.toFixed(2)}
          </span>
          <span className="text-foreground/55"> / {configured} cfg</span>
        </span>
      </div>
      <div className="relative h-1 w-full overflow-hidden rounded-full bg-secondary">
        <div
          className={cn('h-full rounded-full transition-all duration-500', barColor)}
          style={{ width: `${fillPct}%` }}
        />
      </div>
    </div>
  )
}
