import { Navbar } from '@/components/layout/Navbar'
import { StepIndicator } from '@/components/layout/StepIndicator'
import { PrePhasePanel } from '@/components/launch/PrePhasePanel'

export default function LaunchPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />
      <div className="flex justify-center border-b border-border py-4">
        <StepIndicator />
      </div>
      <PrePhasePanel />
    </div>
  )
}
