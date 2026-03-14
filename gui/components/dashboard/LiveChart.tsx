'use client'

import { useMemo } from 'react'
import { AreaChart } from '@tremor/react'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

interface LiveChartProps {
  className?: string
}

export function LiveChart({ className }: LiveChartProps) {
  const metricsHistory = useTrafficStore((s) => s.metricsHistory)

  const chartData = useMemo(
    () =>
      metricsHistory.map((pt) => ({
        time: fmtTime(pt.t),
        Completed: pt.completed,
        Failed: pt.failed,
      })),
    [metricsHistory]
  )

  const isEmpty = chartData.length === 0

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card p-4 flex flex-col gap-3',
        className
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/80">
          Call Volume — 60s Window
        </span>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
            <span className="inline-block size-2 rounded-full bg-emerald-400" />
            Completed
          </span>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-rose-400">
            <span className="inline-block size-2 rounded-full bg-rose-500" />
            Failed
          </span>
        </div>
      </div>

      {isEmpty ? (
        <div className="flex h-36 items-center justify-center">
          <span className="text-xs text-muted-foreground font-mono">
            Waiting for metrics…
          </span>
        </div>
      ) : (
        <AreaChart
          className="h-36 mt-1"
          data={chartData}
          index="time"
          categories={['Completed', 'Failed']}
          colors={['emerald', 'rose']}
          showLegend={false}
          showGridLines={true}
          showAnimation={false}
          connectNulls={true}
          yAxisWidth={36}
          valueFormatter={(v) => String(v)}
        />
      )}
    </div>
  )
}
