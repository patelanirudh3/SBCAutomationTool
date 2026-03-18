import Link from 'next/link'
import { Home } from 'lucide-react'
import { Navbar } from '@/components/layout/Navbar'
import { StepIndicator } from '@/components/layout/StepIndicator'
import { PrePhasePanel } from '@/components/launch/PrePhasePanel'

export default function LaunchPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <div className="relative flex items-center justify-center border-b border-border px-6 py-4">
        <div className="absolute left-6">
          <Link
            href="/config"
            className={[
              'flex items-center gap-2 rounded-md border px-3 py-1.5',
              'border-sky-500/50 text-sky-400',
              'text-sm font-semibold tracking-wide',
              'hover:border-sky-400 hover:bg-sky-500/15 hover:text-sky-300',
              'transition-all duration-200',
            ].join(' ')}
          >
            <Home className="size-4" strokeWidth={2.5} />
            <span>Home</span>
          </Link>
        </div>
        <StepIndicator />
      </div>
      <PrePhasePanel />
    </div>
  )
}
