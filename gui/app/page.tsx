import { ModeSelector } from '@/components/mode/ModeSelector'
import { ActiveRunResumeGuard } from '@/components/run/ActiveRunResumeGuard'

export default function RootPage() {
  return (
    <>
      <ActiveRunResumeGuard />
      <ModeSelector />
    </>
  )
}
