'use client'

import { cn } from '@/lib/utils'
import { CPSGauge } from './CPSGauge'
import type { TrafficMetrics, VMRole, RunPhase } from '@/types'

const PHASE_LABEL: Record<RunPhase, string> = {
  IDLE: 'IDLE',
  PRE_PHASE: 'PRE-PHASE',
  PRE_REGISTER: 'REGISTERING',
  TRAFFIC_READY: 'TRAFFIC READY',
  TRAFFIC: 'TRAFFIC',
  STOPPING: 'STOPPING',
  CLEANUP_READY: 'CLEANUP READY',
  CLEANING_UP: 'CLEANING UP',
  COMPLETE: 'COMPLETE',
  DONE: 'DONE',
  FAILED: 'FAILED',
}

const PHASE_COLOR: Record<RunPhase, string> = {
  IDLE: 'text-muted-foreground',
  PRE_PHASE: 'text-amber-400',
  PRE_REGISTER: 'text-amber-400',
  TRAFFIC_READY: 'text-sky-400',
  TRAFFIC: 'text-emerald-400',
  STOPPING: 'text-amber-400',
  CLEANUP_READY: 'text-sky-400',
  CLEANING_UP: 'text-amber-400',
  COMPLETE: 'text-emerald-400',
  DONE: 'text-emerald-400',
  FAILED: 'text-rose-500',
}

const PHASE_DOT: Record<RunPhase, string> = {
  IDLE: 'bg-muted-foreground',
  PRE_PHASE: 'bg-amber-400',
  PRE_REGISTER: 'bg-amber-400',
  TRAFFIC_READY: 'bg-sky-400',
  TRAFFIC: 'bg-emerald-400',
  STOPPING: 'bg-amber-400',
  CLEANUP_READY: 'bg-sky-400',
  CLEANING_UP: 'bg-amber-400',
  COMPLETE: 'bg-emerald-400',
  DONE: 'bg-emerald-400',
  FAILED: 'bg-rose-500',
}

function MetricRow({
  label,
  value,
  valueClass,
  label2,
  value2,
  valueClass2,
}: {
  label: string
  value: React.ReactNode
  valueClass?: string
  label2?: string
  value2?: React.ReactNode
  valueClass2?: string
}) {
  return (
    <div className="grid grid-cols-2 gap-x-4">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-foreground/65">{label}</span>
        <span className={cn('font-mono text-sm font-semibold tabular-nums', valueClass)}>
          {value}
        </span>
      </div>
      {label2 != null && (
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium text-foreground/65">{label2}</span>
          <span className={cn('font-mono text-sm font-semibold tabular-nums', valueClass2)}>
            {value2}
          </span>
        </div>
      )}
    </div>
  )
}

interface VMMetricsCardProps {
  role: VMRole
  metrics: TrafficMetrics
  configuredCps?: number
  className?: string
}

export function VMMetricsCard({
  role,
  metrics,
  configuredCps = 2,
  className,
}: VMMetricsCardProps) {
  const isUAC = role === 'UAC'
  const phase = metrics.phase
  const hasFailures = metrics.calls_failed > 0

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-card p-4 flex flex-col gap-3',
        className
      )}
    >
      {/* Card header */}
      <div className="flex items-center justify-between border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-bold tracking-widest',
              isUAC
                ? 'bg-blue-500/15 text-blue-400'
                : 'bg-violet-500/15 text-violet-400'
            )}
          >
            {role}
          </span>
          <span className="font-mono text-sm text-foreground">{metrics.vm_id}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={cn('size-1.5 rounded-full', PHASE_DOT[phase])} />
          <span className={cn('text-xs font-semibold tracking-wide', PHASE_COLOR[phase])}>
            {PHASE_LABEL[phase]}
          </span>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="flex flex-col gap-2">
        {isUAC ? (
          <>
            <MetricRow
              label="Attempted"
              value={metrics.calls_attempted.toLocaleString()}
              label2="Completed"
              value2={metrics.calls_completed.toLocaleString()}
              valueClass2="text-emerald-400"
            />
            <MetricRow
              label="Failed"
              value={
                <span className={hasFailures ? 'text-rose-500' : undefined}>
                  {metrics.calls_failed.toLocaleString()}
                  {hasFailures ? ' 🔴' : ''}
                </span>
              }
              label2="PDD avg"
              value2={`${metrics.avg_pdd_ms}ms`}
            />
            <MetricRow
              label="Hold avg"
              value={`${(metrics.avg_hold_ms / 1000).toFixed(1)}s`}
              label2="Sockets"
              value2={metrics.socket_count.toLocaleString()}
            />
            {/* CPS gauge bar */}
            <CPSGauge
              actual={metrics.cps_actual}
              configured={configuredCps}
              className="mt-1"
            />
          </>
        ) : (
          <>
            <MetricRow
              label="Answered"
              value={metrics.calls_completed.toLocaleString()}
              valueClass="text-emerald-400"
              label2="Failed"
              value2={
                <span className={metrics.calls_failed > 0 ? 'text-rose-500' : undefined}>
                  {metrics.calls_failed.toLocaleString()}
                </span>
              }
            />
            <MetricRow
              label="ASR"
              value={
                <span
                  className={
                    metrics.asr > 90
                      ? 'text-emerald-400'
                      : metrics.asr >= 80
                        ? 'text-amber-400'
                        : 'text-rose-500'
                  }
                >
                  {metrics.asr.toFixed(1)}%
                  {metrics.asr > 90 ? ' 🟢' : metrics.asr >= 80 ? ' 🟡' : ' 🔴'}
                </span>
              }
              label2="Registered"
              value2={`${metrics.registered_count}/${metrics.socket_count}`}
            />
            <MetricRow
              label="Sockets"
              value={metrics.socket_count.toLocaleString()}
            />
          </>
        )}
      </div>
    </div>
  )
}
