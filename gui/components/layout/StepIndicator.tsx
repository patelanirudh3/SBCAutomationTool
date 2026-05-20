'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Check, Minus } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'
import {
  activeStepForPhase,
  getGuardConfig,
  isStepNavigable,
  STEP_LABELS,
  STEP_ROUTES,
  type StepIndex,
} from '@/lib/nav-guard'
import { NavGuardDialog } from '@/components/shared/NavGuardDialog'

// StepIndicator — top-centre tab strip with five step nodes (Config /
// Reg-Sub / Traffic / Report / Cleanup). Used to be visual-only decoration; now
// every reachable step is clickable, gated by the same guard logic as
// HomeGuardButton via the shared NavGuardDialog.
//
// Click semantics per step:
//   - target == current step:                    no-op (already there).
//   - target is unreachable for current phase:   button rendered as
//                                                cursor-not-allowed with
//                                                aria-disabled (e.g. clicking
//                                                "Running" while still on
//                                                Config does nothing because
//                                                the engine hasn't started).
//   - target is reachable + no guard:            navigate immediately.
//   - target is reachable + guard returns warn:  show dialog with
//                                                "Continue anyway" override.
//   - target is reachable + guard returns block: show dialog with the
//                                                Emergency Cleanup & Reset
//                                                escape hatch.

const STEP_INDICES: StepIndex[] = [0, 1, 2, 3, 4]

function useCurrentStep(): StepIndex {
  const pathname = usePathname()
  const phase = useTrafficStore((s) => s.phase)

  if (pathname.startsWith('/run')) {
    return activeStepForPhase(phase)
  }
  if (pathname.startsWith('/launch')) return 1
  return 0
}

export function StepIndicator() {
  const router = useRouter()
  const pathname = usePathname()
  const phase = useTrafficStore((s) => s.phase)
  const uacMetrics = useTrafficStore((s) => s.uacMetrics)
  const currentStep = useCurrentStep()
  const trafficStarted = Boolean(
    (uacMetrics?.calls_invite_sent ?? 0) > 0 ||
    (uacMetrics?.calls_attempted ?? 0) > 0 ||
    (uacMetrics?.calls_completed ?? 0) > 0
  )
  const cleanupReached = phase === 'CLEANING_UP' || phase === 'COMPLETE' || phase === 'DONE'

  // Single dialog shared across step clicks — tracks which target the
  // operator wanted, so on confirmation the right href is followed.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingHref, setPendingHref] = useState<string>('/config')

  const guard = getGuardConfig(phase)

  const handleStepClick = (target: StepIndex) => {
    const targetRoute = STEP_ROUTES[target]
    if (cleanupReached && !trafficStarted && (target === 2 || target === 3)) return
    // Already on target lifecycle step — no-op. Several steps share /run, so
    // route equality alone is not enough.
    if (target === currentStep) return
    // Unreachable for current phase — render disabled, ignore click.
    if (!isStepNavigable(phase, target)) return

    // Reachable. If there's no guard for the current phase OR the
    // operator is moving toward the same step they're already past,
    // navigate immediately. Otherwise show the dialog.
    if (!guard) {
      router.push(targetRoute)
      return
    }
    setPendingHref(targetRoute)
    setDialogOpen(true)
  }

  return (
    <>
      <nav
        aria-label="Progress"
        className="flex items-center gap-0"
      >
        {STEP_INDICES.map((i) => {
          const step = i
          const label = STEP_LABELS[step]
          const terminalCleanupComplete = (phase === 'COMPLETE' || phase === 'DONE') && i === 4
          const isCompleted = i < currentStep || terminalCleanupComplete
          const isActive = i === currentStep && !terminalCleanupComplete
          const isUpcoming = i > currentStep
          const isSkipped = cleanupReached && !trafficStarted && (i === 2 || i === 3)
          const navigable = isStepNavigable(phase, step)
          const isCurrentStep = step === currentStep
          const clickable = navigable && !isCurrentStep && !isSkipped

          return (
            <div key={label} className="flex items-center">
              {/* Connector line before step (except first) */}
              {i > 0 && (
                <div
                  className={cn(
                    'h-px w-8 sm:w-12 transition-colors duration-500',
                    isCompleted || isActive ? 'bg-emerald-400' : 'bg-border'
                  )}
                />
              )}

              {/* Step node + label — wrapped in a button so each step is
                  individually focusable and keyboard-navigable. */}
              <button
                type="button"
                onClick={() => handleStepClick(step)}
                aria-disabled={!clickable}
                aria-label={
                  clickable
                    ? `Go to ${label}`
                    : isCurrentStep
                      ? `${label} (current page)`
                      : isSkipped
                        ? `${label} skipped`
                        : `${label} (not yet available)`
                }
                title={
                  isCurrentStep
                    ? `${label} (current page)`
                    : isSkipped
                      ? `${label} skipped because no traffic run was started`
                    : !navigable
                      ? `${label} — available once you reach a later phase`
                      : `Go to ${label}`
                }
                className={cn(
                  'flex flex-col items-center gap-1 rounded-md px-1.5 py-1 transition-colors',
                  clickable
                    ? 'cursor-pointer hover:bg-secondary/40 focus-visible:outline-2 focus-visible:outline-emerald-400'
                    : isUpcoming
                      ? 'cursor-not-allowed opacity-60'
                      : 'cursor-default',
                )}
                disabled={!clickable && !isUpcoming}
              >
                <div
                  className={cn(
                    'flex size-6 items-center justify-center rounded-full text-xs font-semibold transition-all duration-300',
                    isCompleted && !isSkipped && 'bg-emerald-400 text-black',
                    isSkipped && 'border border-slate-600 bg-secondary text-slate-400',
                    isActive &&
                      'ring-2 ring-emerald-400 ring-offset-2 ring-offset-background bg-card text-emerald-400',
                    isUpcoming && 'bg-secondary text-muted-foreground'
                  )}
                >
                  {isSkipped ? (
                    <Minus className="size-3.5" strokeWidth={3} />
                  ) : isCompleted ? (
                    <Check className="size-3.5" strokeWidth={3} />
                  ) : (
                    <span>{i + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    'text-xs font-semibold hidden sm:block transition-colors duration-300',
                    isActive ? 'text-emerald-400' : isSkipped ? 'text-slate-500' : isCompleted ? 'text-emerald-300/80' : 'text-slate-400'
                  )}
                >
                  {label}
                </span>
              </button>
            </div>
          )
        })}
      </nav>

      <NavGuardDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        guard={guard}
        href={pendingHref}
      />
    </>
  )
}
