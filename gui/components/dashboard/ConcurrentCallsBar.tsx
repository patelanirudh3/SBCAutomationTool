'use client'

import { cn } from '@/lib/utils'
import { motion } from 'framer-motion'

interface ConcurrentCallsBarProps {
  concurrent: number
  ceiling: number
  className?: string
}

export function ConcurrentCallsBar({
  concurrent,
  ceiling,
  className,
}: ConcurrentCallsBarProps) {
  const pct = ceiling > 0 ? Math.min((concurrent / ceiling) * 100, 100) : 0
  const isAlarm = pct > 95

  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-between">
        <span
          className="text-xs font-semibold uppercase tracking-widest text-foreground/75"
          title="Calls in the established (post-ACK / pre-BYE-completion) state. Calls in the INVITE→ACK setup window or in failure timeouts are NOT counted here."
        >
          Concurrent Calls
        </span>
        <span className="font-mono text-sm tabular-nums text-foreground">
          <span className={cn('font-bold', isAlarm ? 'text-rose-500' : 'text-foreground')}>
            {concurrent.toLocaleString()}
          </span>
          <span className="text-foreground/55"> / {ceiling.toLocaleString()}</span>
        </span>
      </div>

      {/* Bar track */}
      <div
        className={cn(
          'relative h-3 w-full overflow-hidden rounded-full bg-secondary',
          isAlarm && 'ring-1 ring-rose-500/40'
        )}
      >
        <motion.div
          className={cn(
            'h-full rounded-full transition-colors duration-300',
            isAlarm ? 'bg-rose-500' : 'bg-emerald-400'
          )}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
        />
      </div>

      {/* Alarm pulse overlay when >95% */}
      {isAlarm && (
        <div className="flex items-center gap-1.5">
          <span className="relative flex size-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-rose-500 opacity-75" />
            <span className="relative inline-flex size-2 rounded-full bg-rose-500" />
          </span>
          <span className="text-[10px] font-medium text-rose-400">
            Nearing capacity — {pct.toFixed(0)}% of ceiling
          </span>
        </div>
      )}
    </div>
  )
}
