'use client'

import { cn } from '@/lib/utils'
import type { TrafficMetrics } from '@/types'

interface AggregatePanelProps {
  uacMetrics: TrafficMetrics
  className?: string
}

export function AggregatePanel({ uacMetrics, className }: AggregatePanelProps) {
  const asr = uacMetrics.asr
  const asrColor =
    asr > 90 ? 'text-emerald-400' : asr >= 80 ? 'text-amber-400' : 'text-rose-500'

  const inviteSent = uacMetrics.calls_invite_sent ?? 0
  const answered = uacMetrics.calls_answered ?? 0
  const acknowledged = uacMetrics.calls_acknowledged ?? 0

  // Drop-rate diagnostic: INVITEs the SBC never answered with 100 Trying.
  // A non-zero value here points to network-layer / SBC-reachability
  // issues (the request never reached the SBC's transaction layer).
  const noResponseDrops = Math.max(inviteSent - uacMetrics.calls_attempted, 0)

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-card px-5 py-3',
        className
      )}
    >
      <Stat
        label="INVITEs Sent"
        title="Total INVITEs we transmitted, regardless of whether the SBC ever responded. Compare with Attempted to see how many went unanswered."
        value={inviteSent.toLocaleString()}
      />
      <div className="h-6 w-px bg-border" />
      <Stat
        label="Total Attempted (got 100 Trying)"
        title="INVITEs that the SBC accepted (received a 100 Trying back). The gap from INVITEs Sent reflects requests the SBC never saw or never acknowledged."
        value={uacMetrics.calls_attempted.toLocaleString()}
        valueClass={noResponseDrops > 0 ? 'text-amber-400' : undefined}
      />
      <div className="h-6 w-px bg-border" />
      <Stat
        label="Total Answered (INV/200)"
        title="INVITEs that received a 200 OK from the UAS. Independent of whether ACK followed — high Answered + low Acknowledged means the UAS answered but the UAC never confirmed."
        value={answered.toLocaleString()}
        valueClass={answered > 0 ? 'text-sky-400' : undefined}
      />
      <div className="h-6 w-px bg-border" />
      <Stat
        label="Total Acknowledged (INV/200/ACK)"
        title="Calls that completed the full INVITE / 200 OK / ACK three-way handshake. These are dialogs that fully reached the established (post-ACK) state."
        value={acknowledged.toLocaleString()}
        valueClass={acknowledged > 0 ? 'text-sky-400' : undefined}
      />
      <div className="h-6 w-px bg-border" />
      <Stat
        label="Total Completed (BYE/200)"
        title="Calls that completed the full BYE / 200 OK teardown handshake — fully successful end-to-end."
        value={uacMetrics.calls_completed.toLocaleString()}
        valueClass="text-emerald-400"
      />
      <div className="h-6 w-px bg-border" />
      <Stat
        label="Failed"
        title="Total failed calls (any reason). Equals INVITEs Sent − Completed."
        value={uacMetrics.calls_failed.toLocaleString()}
        valueClass={uacMetrics.calls_failed > 0 ? 'text-rose-500' : undefined}
      />
      <div className="h-6 w-px bg-border" />
      <Stat label="Aggregate ASR" value={`${asr.toFixed(1)}%`} valueClass={asrColor} />
    </div>
  )
}

function Stat({
  label,
  value,
  valueClass,
  title,
}: {
  label: string
  value: string
  valueClass?: string
  title?: string
}) {
  return (
    <div className="flex flex-col gap-0.5" title={title}>
      <span className="text-xs font-medium uppercase tracking-widest text-foreground/65">
        {label}
      </span>
      <span className={cn('font-mono text-base font-semibold tabular-nums', valueClass)}>
        {value}
      </span>
    </div>
  )
}
