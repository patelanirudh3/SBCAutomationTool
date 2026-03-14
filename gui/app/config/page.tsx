'use client'

import { Navbar } from '@/components/layout/Navbar'
import { StepIndicator } from '@/components/layout/StepIndicator'
import { VMPairBook } from '@/components/config/VMPairBook'

export default function ConfigPage() {
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Navbar />

      <div className="flex justify-center border-b border-border bg-card/50 py-3">
        <StepIndicator />
      </div>

      <VMPairBook />
    </div>
  )
}
