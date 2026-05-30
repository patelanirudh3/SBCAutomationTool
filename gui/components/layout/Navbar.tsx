'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { MessageCircle } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SessionMenu } from './SessionMenu'
import type { RunPhase } from '@/types'
import { cn } from '@/lib/utils'

const PHASE_LABEL: Record<RunPhase, string> = {
  IDLE: 'Idle',
  PRE_PHASE: 'Reg/Sub',
  PRE_REGISTER: 'Registering',
  REGSUB_READY: 'Reg/Sub Ready',
  REGSUB_RUNNING: 'Reg/Sub',
  REGSUB_DONE: 'Traffic Ready',
  TRAFFIC_READY: 'Traffic Ready',
  TRAFFIC: 'Running',
  STOPPING: 'Stopping',
  CLEANUP_READY: 'Cleanup Ready',
  CLEANING_UP: 'Cleaning Up…',
  COMPLETE: 'Complete',
  DONE: 'Done',
  FAILED: 'Failed',
}

const PHASE_COLOR: Record<RunPhase, string> = {
  IDLE: 'text-muted-foreground',
  PRE_PHASE: 'text-amber-400',
  PRE_REGISTER: 'text-amber-400',
  REGSUB_READY: 'text-sky-400',
  REGSUB_RUNNING: 'text-amber-400',
  REGSUB_DONE: 'text-sky-400',
  TRAFFIC_READY: 'text-sky-400',
  TRAFFIC: 'text-emerald-400',
  STOPPING: 'text-amber-400',
  CLEANUP_READY: 'text-sky-400',
  CLEANING_UP: 'text-amber-400',
  COMPLETE: 'text-emerald-400',
  DONE: 'text-emerald-400',
  FAILED: 'text-rose-500',
}

type WsDisplayStatus = 'connected' | 'reconnecting' | 'disconnected'

function deriveWsStatus(ws: { uac: WsDisplayStatus }): WsDisplayStatus {
  return ws.uac
}

export function Navbar() {
  const phase = useTrafficStore((s) => s.phase)
  const wsStatusRaw = useTrafficStore((s) => s.wsStatus)
  const wsStatus = deriveWsStatus(wsStatusRaw)
  const chatOpen = useTrafficStore((s) => s.chatPanelOpen)
  const setChatOpen = useTrafficStore((s) => s.setChatPanelOpen)
  const pathname = usePathname()

  const isScenarioMode = pathname.startsWith('/scenarios')
  const showWsStatus = (phase === 'TRAFFIC' || phase === 'STOPPING') && wsStatus !== 'connected'

  return (
    <header className="sticky top-0 z-50 flex h-14 items-center gap-5 border-b border-border bg-card px-5">
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <span className="rounded bg-red-600 px-2 py-0.5 text-xs font-black tracking-widest text-white">
          AVAYA
        </span>
        <span className="font-bold tracking-tight text-base text-foreground">
          Nexus Studio
        </span>
      </div>

      {/* Divider */}
      <div className="h-5 w-px bg-border" />

      {/* Mode toggle */}
      <nav className="flex items-center rounded-lg border border-border bg-secondary/40 p-0.5">
        <Link
          href="/config"
          className={cn(
            'rounded-md px-3 py-1 text-xs font-semibold transition-all duration-150',
            !isScenarioMode
              ? 'bg-card text-emerald-400 shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Load Testing
        </Link>
        <Link
          href="/scenarios"
          className={cn(
            'rounded-md px-3 py-1 text-xs font-semibold transition-all duration-150',
            isScenarioMode
              ? 'bg-card text-violet-400 shadow-sm'
              : 'text-muted-foreground hover:text-foreground'
          )}
        >
          Feature Scenarios
        </Link>
      </nav>

      {/* Divider */}
      <div className="h-5 w-px bg-border" />

      {/* Phase badge */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-cyan-400">Phase</span>
        <span className={cn('text-sm font-semibold font-mono', PHASE_COLOR[phase])}>
          {PHASE_LABEL[phase]}
        </span>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Session management dropdown */}
      <SessionMenu />

      {/* Chat toggle */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setChatOpen(!chatOpen)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 transition-colors',
              chatOpen
                ? 'bg-violet-500/15 text-violet-400'
                : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
            )}
            aria-label="Toggle AI chat"
          >
            <MessageCircle className="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">AI Analysis</TooltipContent>
      </Tooltip>

      {/* WS status dot */}
      {showWsStatus && (
      <>
        <div className="h-5 w-px bg-border/50" />
        <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 hover:bg-secondary transition-colors"
            aria-label={`WebSocket: ${wsStatus}`}
          >
            <WsDot status={wsStatus} />
            <span
              className={cn(
                'text-sm font-medium',
                wsStatus === 'reconnecting' ? 'text-amber-400' : 'text-rose-500'
              )}
            >
              {wsStatus === 'reconnecting' ? 'Reconnecting…' : 'Disconnected'}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Engine: {wsStatusRaw.uac}
        </TooltipContent>
        </Tooltip>
      </>
      )}
    </header>
  )
}

function WsDot({ status }: { status: 'connected' | 'reconnecting' | 'disconnected' }) {
  if (status === 'connected') {
    return (
      <span className="relative flex size-2.5">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60" />
        <span className="relative inline-flex rounded-full size-2.5 bg-emerald-400" />
      </span>
    )
  }
  if (status === 'reconnecting') {
    return <span className="size-2.5 rounded-full bg-amber-400 animate-pulse" />
  }
  return <span className="size-2.5 rounded-full bg-rose-500" />
}
