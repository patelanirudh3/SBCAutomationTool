'use client'

import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'

function asrColor(asr: number): {
  text: string
  bar: string
  badge: string
  dot: string
} {
  if (asr > 90)
    return {
      text: 'text-emerald-400',
      bar: 'bg-emerald-400',
      badge: 'bg-emerald-400/10 text-emerald-400 border-emerald-400/20',
      dot: 'bg-emerald-400',
    }
  if (asr >= 80)
    return {
      text: 'text-amber-400',
      bar: 'bg-amber-400',
      badge: 'bg-amber-400/10 text-amber-400 border-amber-400/20',
      dot: 'bg-amber-400',
    }
  return {
    text: 'text-rose-500',
    bar: 'bg-rose-500',
    badge: 'bg-rose-500/10 text-rose-500 border-rose-500/20',
    dot: 'bg-rose-500',
  }
}

interface ASRGaugeProps {
  asr: number
  className?: string
}

export function ASRGauge({ asr, className }: ASRGaugeProps) {
  const clampedAsr = Math.max(0, Math.min(100, asr))
  const colors = asrColor(clampedAsr)

  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {/* Header row: label + number + status badge */}
      <div className="flex items-baseline gap-3">
        <span className="text-sm font-semibold tracking-widest uppercase text-foreground/70">
          ASR
        </span>
        <span
          className={cn(
            'font-mono text-5xl font-bold leading-none tabular-nums',
            colors.text
          )}
        >
          {clampedAsr.toFixed(1)}%
        </span>
        <span
          className={cn(
            'ml-1 rounded border px-2 py-0.5 text-xs font-medium',
            colors.badge
          )}
        >
          {clampedAsr > 90 ? 'HEALTHY' : clampedAsr >= 80 ? 'DEGRADED' : 'CRITICAL'}
        </span>
      </div>

      {/* Animated fill bar */}
      <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-secondary">
        <motion.div
          className={cn('h-full rounded-full', colors.bar)}
          initial={{ width: 0 }}
          animate={{ width: `${clampedAsr}%` }}
          transition={{ duration: 0.6, ease: 'easeOut' }}
        />
      </div>

      {/* Threshold legend */}
      <div className="flex items-center gap-4 text-xs font-medium text-foreground/60">
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-emerald-400" />
          &gt;90% Healthy
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-amber-400" />
          80–90% Degraded
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block size-1.5 rounded-full bg-rose-500" />
          &lt;80% Critical
        </span>
      </div>
    </div>
  )
}
