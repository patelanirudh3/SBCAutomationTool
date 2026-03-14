'use client'

import { CheckCircle2, XCircle, FileText } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'
import type { RunPhase } from '@/types'

function ExitBadge({ exit, label }: { exit: number; label: string }) {
  const ok = exit === 0
  return (
    <div className="flex items-center gap-2">
      {ok ? (
        <CheckCircle2 className="size-4 text-emerald-400 shrink-0" />
      ) : (
        <XCircle className="size-4 text-rose-500 shrink-0" />
      )}
      <span className="text-sm text-foreground">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground ml-1">exit {exit}</span>
      </span>
    </div>
  )
}

function asrColor(asr: number): string {
  if (asr > 90) return 'text-emerald-400'
  if (asr >= 80) return 'text-amber-400'
  return 'text-rose-500'
}

function asrEmoji(asr: number): string {
  if (asr > 90) return '🟢'
  if (asr >= 80) return '🟡'
  return '🔴'
}

interface SummaryCardProps {
  className?: string
}

export function SummaryCard({ className }: SummaryCardProps) {
  const phase = useTrafficStore((s) => s.phase)
  const aggregate = useTrafficStore((s) => s.aggregate)
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  const pair = pairs[activePairIndex]
  const isComplete = phase === 'COMPLETE'

  if (!aggregate) return null

  const durationSec = aggregate.ended_at
    ? (Date.parse(aggregate.ended_at) - Date.parse(aggregate.started_at)) / 1000
    : null

  const uacVmId = pair?.uac.vm_id ?? 'uac-local'
  const uasVmId = pair?.uas.vm_id ?? 'uas-local'

  const runTimestamp = aggregate.run_id.replace('run-', '').replace(/-/g, '')

  return (
    <div
      className={cn(
        'rounded-lg border bg-card p-6 flex flex-col gap-5',
        isComplete ? 'border-emerald-500/20' : 'border-rose-500/20',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'rounded px-2.5 py-1 text-xs font-bold tracking-widest',
            isComplete
              ? 'bg-emerald-400/10 text-emerald-400'
              : 'bg-rose-500/10 text-rose-500'
          )}
        >
          RUN {isComplete ? 'COMPLETE' : 'FAILED'}
        </div>
        <span className="font-mono text-xs text-muted-foreground">{aggregate.run_id}</span>
      </div>

      {/* Exit statuses + duration */}
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-2">
          <ExitBadge exit={isComplete ? 0 : 1} label="UAC" />
          <ExitBadge exit={0} label="UAS" />
        </div>
        <div className="flex flex-col gap-1">
          {durationSec != null && (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground/65">Duration</span>
              <span className="font-mono text-sm text-foreground font-semibold">
                {durationSec.toFixed(1)}s
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground/65">Started</span>
            <span className="font-mono text-xs text-foreground">
              {new Date(aggregate.started_at).toLocaleTimeString()}
            </span>
          </div>
        </div>
      </div>

      {/* Aggregate stats */}
      <div className="grid grid-cols-4 gap-3 rounded-md border border-border bg-secondary/30 p-3">
        <Stat label="Total Attempted" value={aggregate.total_attempted.toLocaleString()} />
        <Stat
          label="Total Completed"
          value={aggregate.total_completed.toLocaleString()}
          valueClass="text-emerald-400"
        />
        <Stat
          label="Total Failed"
          value={aggregate.total_failed.toLocaleString()}
          valueClass={aggregate.total_failed > 0 ? 'text-rose-500' : undefined}
        />
        <Stat
          label="Aggregate ASR"
          value={`${aggregate.aggregate_asr.toFixed(1)}% ${asrEmoji(aggregate.aggregate_asr)}`}
          valueClass={asrColor(aggregate.aggregate_asr)}
        />
      </div>

      {/* Log files */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/70 mb-1">
          Log Files
        </span>
        {[
          `traffic_${uacVmId}_${runTimestamp}.log`,
          `traffic_summary_${uacVmId}_${runTimestamp}.log`,
          `traffic_${uasVmId}_${runTimestamp}.log`,
          `traffic_summary_${uasVmId}_${runTimestamp}.log`,
        ].map((f) => (
          <div key={f} className="flex items-center gap-2">
            <FileText className="size-3 text-foreground/50 shrink-0" />
            <span className="font-mono text-xs text-foreground/70">{f}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Stat({
  label,
  value,
  valueClass,
}: {
  label: string
  value: string
  valueClass?: string
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium text-foreground/65 leading-tight">{label}</span>
      <span className={cn('font-mono text-sm font-semibold tabular-nums', valueClass)}>
        {value}
      </span>
    </div>
  )
}
