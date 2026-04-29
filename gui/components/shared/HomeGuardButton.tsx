'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Home, AlertTriangle, ShieldAlert } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { RunPhase } from '@/types'

// ---------------------------------------------------------------------------
// Per-phase guard config
// ---------------------------------------------------------------------------

interface GuardConfig {
  title: string
  message: string
  /** warn = amber (soft; override allowed), block = rose (hard; no bypass) */
  severity: 'warn' | 'block'
  allowOverride?: boolean
  overrideLabel?: string
}

function getGuardConfig(phase: RunPhase): GuardConfig | null {
  switch (phase) {
    case 'IDLE':
    case 'COMPLETE':
    case 'FAILED':
      return null // safe — allow navigation immediately

    case 'TRAFFIC':
      return {
        title: 'Traffic Run In Progress',
        message:
          'A traffic run is currently active. Use Graceful Stop or Force Stop on the dashboard before navigating away.',
        severity: 'block',
      }

    case 'STOPPING':
      return {
        title: 'Stop In Progress',
        message:
          'The traffic run is stopping. Please wait for it to complete before leaving.',
        severity: 'block',
      }

    case 'PRE_PHASE':
      return {
        title: 'Registration In Progress',
        message:
          'SIP extensions are currently being registered and subscribed. Please wait for registration to finish before leaving.',
        severity: 'block',
      }

    case 'TRAFFIC_READY':
      return {
        title: 'Extensions Ready — Run Not Started',
        message:
          'Extensions are registered and idle. Start a traffic run or unregister before leaving.',
        severity: 'block',
      }

    case 'CLEANUP_READY':
      return {
        title: 'Extensions Still Registered',
        message:
          'SIP extensions are still registered on the SBC. Click "Unregister / Unsubscribe" on the report to clean up properly. You may also choose to leave them registered if you intend to run again shortly.',
        severity: 'warn',
        allowOverride: true,
        overrideLabel: 'Leave registered & go home',
      }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// HomeGuardButton
// ---------------------------------------------------------------------------

interface HomeGuardButtonProps {
  /** Destination route — defaults to the config/home screen */
  href?: string
  className?: string
  label?: string
}

export function HomeGuardButton({
  href = '/config',
  className,
  label = 'Home',
}: HomeGuardButtonProps) {
  const phase = useTrafficStore((s) => s.phase)
  const router = useRouter()
  const [open, setOpen] = useState(false)

  const guard = getGuardConfig(phase)

  const handleClick = () => {
    if (!guard) {
      router.push(href)
    } else {
      setOpen(true)
    }
  }

  return (
    <>
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center gap-2 rounded-md border px-3 py-1.5',
          'border-sky-500/50 text-sky-400',
          'text-sm font-semibold tracking-wide',
          'hover:border-sky-400 hover:bg-sky-500/15 hover:text-sky-300',
          'transition-all duration-200',
          className,
        )}
      >
        <Home className="size-4" strokeWidth={2.5} />
        <span>{label}</span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-3">
              {guard?.severity === 'block' ? (
                <ShieldAlert className="size-5 shrink-0 text-rose-400" />
              ) : (
                <AlertTriangle className="size-5 shrink-0 text-amber-400" />
              )}
              <DialogTitle className="text-base font-semibold text-foreground">
                {guard?.title}
              </DialogTitle>
            </div>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              {guard?.message}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            {guard?.allowOverride && (
              <Button
                variant="outline"
                size="sm"
                className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
                onClick={() => {
                  setOpen(false)
                  router.push(href)
                }}
              >
                {guard.overrideLabel ?? 'Continue anyway'}
              </Button>
            )}
            <Button
              size="sm"
              onClick={() => setOpen(false)}
            >
              Stay on this page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
