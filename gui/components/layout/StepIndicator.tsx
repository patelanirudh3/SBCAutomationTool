'use client'

import { useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { Check } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'
import {
  getGuardConfig,
  isStepNavigable,
  STEP_LABELS,
  STEP_ROUTES,
  type StepIndex,
} from '@/lib/nav-guard'
import { NavGuardDialog } from '@/components/shared/NavGuardDialog'

// StepIndicator — top-centre tab strip with four step nodes (Config /
// Reg-Sub / Running / Complete). Used to be visual-only decoration; now
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

const STEP_INDICES: StepIndex[] = [0, 1, 2, 3]

function useCurrentStep(): StepIndex {
  const pathname = usePathname()
  const phase = useTrafficStore((s) => s.phase)

  if (pathname.startsWith('/run')) {
    if (phase === 'COMPLETE' || phase === 'FAILED') return 3
    if (phase === 'CLEANUP_READY' || phase === 'CLEANING_UP') return 3
    return 2
  }
  if (pathname.startsWith('/launch')) return 1
  return 0
}

export function StepIndicator() {
  const router = useRouter()
  const pathname = usePathname()
  const phase = useTrafficStore((s) => s.phase)
  const currentStep = useCurrentStep()

  // Single dialog shared across step clicks — tracks which target the
  // operator wanted, so on confirmation the right href is followed.
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingHref, setPendingHref] = useState<string>('/config')

  const guard = getGuardConfig(phase)

  const handleStepClick = (target: StepIndex) => {
    const targetRoute = STEP_ROUTES[target]
    // Already on target route — no-op.
    if (pathname.startsWith(targetRoute)) return
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
          const isCompleted = i < currentStep
          const isActive = i === currentStep
          const isUpcoming = i > currentStep
          const navigable = isStepNavigable(phase, step)
          const isCurrentRoute = pathname.startsWith(STEP_ROUTES[step])
          const clickable = navigable && !isCurrentRoute

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
                    : isCurrentRoute
                      ? `${label} (current page)`
                      : `${label} (not yet available)`
                }
                title={
                  isCurrentRoute
                    ? `${label} (current page)`
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
                    isCompleted && 'bg-emerald-400 text-black',
                    isActive &&
                      'ring-2 ring-emerald-400 ring-offset-2 ring-offset-background bg-card text-emerald-400',
                    isUpcoming && 'bg-secondary text-muted-foreground'
                  )}
                >
                  {isCompleted ? (
                    <Check className="size-3.5" strokeWidth={3} />
                  ) : (
                    <span>{i + 1}</span>
                  )}
                </div>
                <span
                  className={cn(
                    'text-xs font-semibold hidden sm:block transition-colors duration-300',
                    isActive ? 'text-emerald-400' : isCompleted ? 'text-emerald-300/80' : 'text-slate-400'
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
