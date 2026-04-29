'use client'

import { cn } from '@/lib/utils'

function formatElapsed(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = Math.floor(totalSeconds % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

interface RunTimerProps {
  elapsed: number
  /** When true the timer shows a stopped/final indicator instead of live colour */
  frozen?: boolean
  className?: string
}

export function RunTimer({ elapsed, frozen = false, className }: RunTimerProps) {
  return (
    <div className={cn('flex flex-col items-end gap-0.5 shrink-0', className)}>
      <span className="text-xs font-semibold tracking-widest uppercase text-foreground/70">
        {frozen ? 'Final Time' : 'Run Time'}
      </span>
      <span className={cn(
        'font-mono text-3xl font-semibold tabular-nums leading-none',
        frozen ? 'text-emerald-400' : 'text-foreground'
      )}>
        {formatElapsed(elapsed)}
      </span>
      {frozen && (
        <span className="text-[10px] font-medium tracking-wide text-emerald-500/70 uppercase">
          traffic complete
        </span>
      )}
    </div>
  )
}
