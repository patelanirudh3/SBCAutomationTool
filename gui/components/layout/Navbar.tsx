'use client'

import { Activity } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RunPhase } from '@/types'
import { cn } from '@/lib/utils'

const PHASE_LABEL: Record<RunPhase, string> = {
  IDLE: 'Idle',
  PRE_PHASE: 'Pre-Phase',
  TRAFFIC: 'Running',
  COMPLETE: 'Complete',
  FAILED: 'Failed',
}

const PHASE_COLOR: Record<RunPhase, string> = {
  IDLE: 'text-muted-foreground',
  PRE_PHASE: 'text-amber-400',
  TRAFFIC: 'text-emerald-400',
  COMPLETE: 'text-emerald-400',
  FAILED: 'text-rose-500',
}

export function Navbar() {
  const phase = useTrafficStore((s) => s.phase)
  const wsStatus = useTrafficStore((s) => s.wsStatus)

  return (
    <header className="sticky top-0 z-50 flex h-12 items-center gap-4 border-b border-border bg-card px-4">
      {/* Logo */}
      <div className="flex items-center gap-2">
        <Activity className="size-4 text-emerald-400" strokeWidth={2.5} />
        <span className="font-semibold tracking-tight text-sm text-foreground">
          CCI Traffic
        </span>
      </div>

      {/* Divider */}
      <div className="h-4 w-px bg-border" />

      {/* Phase badge */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Phase</span>
        <span className={cn('text-xs font-medium font-mono', PHASE_COLOR[phase])}>
          {PHASE_LABEL[phase]}
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* WS status dot */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-secondary transition-colors"
            aria-label={`WebSocket: ${wsStatus}`}
          >
            <WsDot status={wsStatus} />
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {wsStatus === 'connected'
                ? 'Live'
                : wsStatus === 'reconnecting'
                  ? 'Reconnecting…'
                  : 'Disconnected'}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          WebSocket stream: {wsStatus}
        </TooltipContent>
      </Tooltip>
    </header>
  )
}

function WsDot({ status }: { status: 'connected' | 'reconnecting' | 'disconnected' }) {
  if (status === 'connected') {
    return (
      <span className="relative flex size-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex rounded-full size-2 bg-emerald-400" />
      </span>
    )
  }
  if (status === 'reconnecting') {
    return <span className="size-2 rounded-full bg-amber-400 animate-pulse" />
  }
  return <span className="size-2 rounded-full bg-rose-500" />
}
