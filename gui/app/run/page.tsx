import { Navbar } from '@/components/layout/Navbar'
import { StepIndicator } from '@/components/layout/StepIndicator'

export default function RunPage() {
  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />
      <div className="flex justify-center py-4 border-b border-border">
        <StepIndicator />
      </div>
      <main className="flex-1 flex items-center justify-center">
        <p className="text-muted-foreground font-mono text-sm">
          Screen 3/4 — Live Dashboard / Post-Run (coming soon)
        </p>
      </main>
    </div>
  )
}
