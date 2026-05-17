'use client'

import { useRouter } from 'next/navigation'
import { Download, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'

interface DownloadReportProps {
  className?: string
  showNewRun?: boolean
}

export function DownloadReport({ className, showNewRun = true }: DownloadReportProps) {
  const aggregate = useTrafficStore((s) => s.aggregate)
  const callEvents = useTrafficStore((s) => s.callEvents)
  const callSpines = useTrafficStore((s) => s.callSpines)
  const uacMetrics = useTrafficStore((s) => s.uacMetrics)
  const cleanupStatus = useTrafficStore((s) => s.cleanupStatus)
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  function handleDownload() {
    const report = {
      generated_at: new Date().toISOString(),
      run_id: aggregate?.run_id ?? 'unknown',
      aggregate,
      final_metrics: uacMetrics,
      config: pairs[activePairIndex],
      call_events: callEvents,
      call_spines: callSpines,
      cleanup: cleanupStatus,
    }

    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: 'application/json',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${aggregate?.run_id ?? 'report'}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const router = useRouter()
  const reset = useTrafficStore((s) => s.reset)

  function handleNewRun() {
    reset()
    router.push('/config')
  }

  return (
    <div className={cn('flex items-center', showNewRun ? 'justify-between' : 'justify-end', className)}>
      {showNewRun && (
        <Button
          variant="outline"
          size="sm"
          onClick={handleNewRun}
          className="gap-2 border-border text-foreground hover:bg-secondary"
        >
          <RotateCcw className="size-3.5" />
          New Run
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={handleDownload}
        className="gap-2 border-border text-foreground hover:bg-secondary"
      >
        <Download className="size-3.5" />
        Export Report JSON
      </Button>
    </div>
  )
}
