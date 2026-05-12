'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Home } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'
import { getGuardConfig } from '@/lib/nav-guard'
import { NavGuardDialog } from './NavGuardDialog'

// HomeGuardButton — top-left "Home" chevron used on /launch and /run.
// Delegates dialog UI + Emergency Cleanup & Reset to the shared
// NavGuardDialog so HomeGuardButton + StepIndicator behave identically.

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

      <NavGuardDialog
        open={open}
        onOpenChange={setOpen}
        guard={guard}
        href={href}
      />
    </>
  )
}
