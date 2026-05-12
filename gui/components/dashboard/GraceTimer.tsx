'use client'

import { cn } from '@/lib/utils'

// GraceTimer — countdown shown in the live dashboard hero row when the
// backend has frozen the run timer and is draining in-flight calls.
//
// Mutually exclusive with the live RunTimer: when the timed-mode deadline
// fires (or the operator clicks Graceful Stop), the backend sets
// graceful_drain_active=true and the parent swaps RunTimer for this
// component until either every active call drains naturally or the
// budget (cps × hold × 3) elapses.

interface GraceTimerProps {
  totalSeconds: number
  remainingSeconds: number
  /** Optional active-call count — surfaced in the sub-label so operators
   *  can see what the drain is waiting on. */
  activeCalls?: number
  className?: string
}

function formatMmSs(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(safe / 60)
  const s = safe % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function GraceTimer({
  totalSeconds,
  remainingSeconds,
  activeCalls,
  className,
}: GraceTimerProps) {
  const pct =
    totalSeconds > 0
      ? Math.max(0, Math.min(100, (remainingSeconds / totalSeconds) * 100))
      : 0

  return (
    <div className={cn('flex flex-col items-end gap-1 shrink-0', className)}>
      <span className="text-xs font-semibold tracking-widest uppercase text-amber-300/80">
        Graceful Drain
      </span>
      <span className="font-mono text-3xl font-semibold tabular-nums leading-none text-amber-300">
        {formatMmSs(remainingSeconds)}
      </span>
      <div className="h-1 w-32 overflow-hidden rounded-full bg-amber-500/20">
        <div
          className="h-full bg-amber-400 transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] font-medium tracking-wide text-amber-500/70 uppercase">
        {activeCalls != null
          ? `completing in-flight calls — ${activeCalls.toLocaleString()} active`
          : 'completing in-flight calls'}
      </span>
    </div>
  )
}
