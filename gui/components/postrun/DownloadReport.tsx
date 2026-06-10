'use client'

import { useRouter } from 'next/navigation'
import { Download, Loader2, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'
import { getMetricsFor, startNewRunFor } from '@/lib/api'

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
  const resetRunState = useTrafficStore((s) => s.resetRunState)
  const [startingNewRun, setStartingNewRun] = useState(false)

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

  async function handleNewRun() {
    if (startingNewRun) return
    setStartingNewRun(true)
    try {
      const vm = pairs[activePairIndex]?.uac
      if (vm && !process.env.NEXT_PUBLIC_MOCK_MODE) {
        const ip = vm.vm_ip ?? '127.0.0.1'
        const port = vm.metrics_port ?? 8082
        const res = await startNewRunFor(ip, port)
        if (res.status === 'cleanup_started') {
          const deadline = Date.now() + 35 * 60 * 1000
          while (Date.now() < deadline) {
            const m = await getMetricsFor(ip, port)
            const phase = (m.phase ?? '').toUpperCase()
            if (phase === 'DONE' || phase === 'COMPLETE' || phase === 'FAILED') break
            await new Promise((resolve) => setTimeout(resolve, 1000))
          }
          await startNewRunFor(ip, port)
        }
      }
      resetRunState()
      router.push('/config')
    } finally {
      setStartingNewRun(false)
    }
  }

  return (
    <div className={cn('flex items-center', showNewRun ? 'justify-between' : 'justify-end', className)}>
      {showNewRun && (
        <Button
          variant="outline"
          size="sm"
          disabled={startingNewRun}
          onClick={handleNewRun}
          className="gap-2 border-border text-foreground hover:bg-secondary"
        >
          {startingNewRun ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
          {startingNewRun ? 'Starting…' : 'Start New Run'}
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
