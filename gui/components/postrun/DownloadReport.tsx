'use client'

import { Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'

interface DownloadReportProps {
  className?: string
}

export function DownloadReport({ className }: DownloadReportProps) {
  const aggregate = useTrafficStore((s) => s.aggregate)
  const callEvents = useTrafficStore((s) => s.callEvents)
  const uacMetrics = useTrafficStore((s) => s.uacMetrics)
  const uasMetrics = useTrafficStore((s) => s.uasMetrics)
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  function handleDownload() {
    const report = {
      generated_at: new Date().toISOString(),
      run_id: aggregate?.run_id ?? 'unknown',
      aggregate,
      final_uac_metrics: uacMetrics,
      final_uas_metrics: uasMetrics,
      config: pairs[activePairIndex],
      call_events: callEvents,
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

  return (
    <div className={cn('flex justify-end', className)}>
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
