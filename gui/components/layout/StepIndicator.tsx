'use client'

import { usePathname } from 'next/navigation'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'

interface Step {
  label: string
  index: number
}

const STEPS: Step[] = [
  { label: 'Config', index: 0 },
  { label: 'Reg / Sub', index: 1 },
  { label: 'Running', index: 2 },
  { label: 'Complete', index: 3 },
]

function useCurrentStep(): number {
  const pathname = usePathname()
  const phase = useTrafficStore((s) => s.phase)

  if (pathname.startsWith('/run')) {
    // Step 4 ("Complete") activates as soon as traffic is done. While
    // unregister is still running we keep step 3 ticked green and step 4
    // active (animated ring) — only on COMPLETE/FAILED does step 4 itself
    // get a green checkmark via the i < currentStep branch below.
    if (phase === 'COMPLETE' || phase === 'FAILED') return 4
    if (phase === 'CLEANUP_READY' || phase === 'CLEANING_UP') return 3
    return 2
  }
  if (pathname.startsWith('/launch')) return 1
  return 0
}

export function StepIndicator() {
  const currentStep = useCurrentStep()

  return (
    <nav
      aria-label="Progress"
      className="flex items-center gap-0"
    >
      {STEPS.map((step, i) => {
        const isCompleted = i < currentStep
        const isActive = i === currentStep
        const isUpcoming = i > currentStep

        return (
          <div key={step.label} className="flex items-center">
            {/* Connector line before step (except first) */}
            {i > 0 && (
              <div
                className={cn(
                  'h-px w-8 sm:w-12 transition-colors duration-500',
                  isCompleted || isActive ? 'bg-emerald-400' : 'bg-border'
                )}
              />
            )}

            {/* Step node + label */}
            <div className="flex flex-col items-center gap-1">
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
                {step.label}
              </span>
            </div>
          </div>
        )
      })}
    </nav>
  )
}
