'use client'

import { Navbar } from '@/components/layout/Navbar'
import { StepIndicator } from '@/components/layout/StepIndicator'
import { PrePhasePanel } from '@/components/launch/PrePhasePanel'
import { HomeGuardButton } from '@/components/shared/HomeGuardButton'
import { ActiveRunResumeGuard } from '@/components/run/ActiveRunResumeGuard'

export default function LaunchPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <ActiveRunResumeGuard />
      <Navbar />
      <div className="relative flex items-center justify-center border-b border-border px-6 py-4">
        <div className="absolute left-6">
          <HomeGuardButton href="/config" />
        </div>
        <StepIndicator />
      </div>
      <PrePhasePanel />
    </div>
  )
}
