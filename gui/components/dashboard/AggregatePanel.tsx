'use client'

import { cn } from '@/lib/utils'
import type { TrafficMetrics } from '@/types'

interface AggregatePanelProps {
  uacMetrics: TrafficMetrics
  className?: string
}

export function AggregatePanel({ uacMetrics, className }: AggregatePanelProps) {
  const asr = uacMetrics.asr
  const csr = uacMetrics.csr ?? (
    uacMetrics.calls_attempted > 0
      ? Math.round((uacMetrics.calls_completed / uacMetrics.calls_attempted) * 10000) / 100
      : 0
  )
  const asrColor =
    asr > 90 ? 'text-emerald-400' : asr >= 80 ? 'text-amber-400' : 'text-rose-500'
  const csrColor =
    csr > 90 ? 'text-emerald-400' : csr >= 80 ? 'text-amber-400' : 'text-rose-500'

  const hasInviteSent = typeof uacMetrics.calls_invite_sent === 'number'
  const noResponseInvites = hasInviteSent
    ? Math.max((uacMetrics.calls_invite_sent ?? 0) - uacMetrics.calls_attempted, 0)
    : null
  const answered = uacMetrics.calls_answered ?? 0
  const hasAcknowledged = typeof uacMetrics.calls_acknowledged === 'number'
  const acknowledged = hasAcknowledged
    ? uacMetrics.calls_acknowledged!
    : uacMetrics.calls_completed

  // Drop-rate diagnostic: INVITEs the SBC never answered with 100 Trying.
  // A non-zero value here points to network-layer / SBC-reachability
  // issues (the request never reached the SBC's transaction layer).
  const noResponseDrops = noResponseInvites ?? 0

  return (
    <div
      className={cn(
        'space-y-3 rounded-lg border border-border bg-card px-5 py-3',
        className
      )}
    >
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="No Response"
          sub="(INV/no 100)"
          title="INVITEs transmitted but never answered with 100 Trying. Unavailable on older backend builds that do not emit calls_invite_sent."
          value={noResponseInvites == null ? '—' : noResponseInvites.toLocaleString()}
          valueClass={noResponseDrops > 0 ? 'text-amber-400' : undefined}
        />
        <Stat
          label="Attempted Call"
          sub="(INV/100)"
          title="Calls where the outbound INVITE received 100 Trying from the remote server."
          value={uacMetrics.calls_attempted.toLocaleString()}
          valueClass={noResponseDrops > 0 ? 'text-amber-400' : undefined}
        />
        <Stat
          label="Answered Call"
          sub="(INV/.../200)"
          title="Calls where UAC received 200 OK for INVITE."
          value={answered.toLocaleString()}
          valueClass={answered > 0 ? 'text-sky-400' : undefined}
        />
        <Stat
          label="Acknowledged Call"
          sub="(INV/.../ACK)"
          title={hasAcknowledged
            ? 'Calls where the UAS received ACK.'
            : 'Backend does not emit calls_acknowledged; showing completed calls as a conservative lower-bound ACK count.'}
          value={hasAcknowledged ? acknowledged.toLocaleString() : `${acknowledged.toLocaleString()}+`}
          valueClass={acknowledged > 0 ? 'text-sky-400' : undefined}
        />
        <Stat
          label="Completed Call"
          sub="(BYE/200)"
          title="Calls where UAC received 200 OK for BYE."
          value={uacMetrics.calls_completed.toLocaleString()}
          valueClass="text-emerald-400"
        />
        <Stat
          label="Failed Call"
          sub="(explicit fail)"
          title="Calls that explicitly failed due to timeout, final failure response, or call-flow error."
          value={uacMetrics.calls_failed.toLocaleString()}
          valueClass={uacMetrics.calls_failed > 0 ? 'text-rose-500' : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 border-t border-border pt-3 md:grid-cols-2">
        <RatioStat
          label="ASR"
          sub="Answered / Attempted"
          title="ASR (Answer Seizure Ratio) = Answered / Attempted × 100. Attempted means received 100 Trying; Answered means UAC received 200 OK for INVITE."
          value={asr}
          valueClass={asrColor}
        />
        <RatioStat
          label="CSR"
          sub="Completed / Attempted"
          title="CSR (Call Success Ratio) = Completed / Attempted × 100. Completed means UAC received 200 OK for BYE. During active traffic CSR can lag ASR while calls are still in hold."
          value={csr}
          valueClass={csrColor}
        />
      </div>
    </div>
  )
}

function Stat({
  label,
  sub,
  value,
  valueClass,
  title,
}: {
  label: string
  sub?: string
  value: string
  valueClass?: string
  title?: string
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-0.5 rounded-md bg-secondary/20 px-2 py-2 text-center" title={title}>
      <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">
        {label}
      </span>
      {sub && (
        <span className="text-[10px] font-medium leading-none text-foreground/45">
          {sub}
        </span>
      )}
      <span className={cn('font-mono text-lg font-semibold tabular-nums', valueClass)}>
        {value}
      </span>
    </div>
  )
}

function RatioStat({
  label,
  sub,
  value,
  valueClass,
  title,
}: {
  label: string
  sub: string
  value: number
  valueClass?: string
  title?: string
}) {
  const clamped = Math.max(0, Math.min(100, value))

  return (
    <div className="rounded-md bg-secondary/20 px-3 py-2" title={title}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/70">
            {label}
          </p>
          <p className="text-[10px] font-medium text-foreground/45">{sub}</p>
        </div>
        <span className={cn('font-mono text-xl font-semibold tabular-nums', valueClass)}>
          {value.toFixed(1)}%
        </span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500',
            clamped > 90 ? 'bg-emerald-400' : clamped >= 80 ? 'bg-amber-400' : 'bg-rose-500',
          )}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  )
}
