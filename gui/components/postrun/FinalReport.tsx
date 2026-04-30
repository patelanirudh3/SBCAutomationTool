'use client'

import { motion } from 'framer-motion'
import { CheckCircle2, XCircle, Phone, PhoneOff, PhoneMissed, PhoneIncoming, Clock, Zap, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'
import { FailedCallsTable } from '@/components/dashboard/FailedCallsTable'
import { MediaQosPanel } from '@/components/dashboard/MediaQosPanel'
import { DownloadReport } from './DownloadReport'
import { UnregisterProgressCard } from './UnregisterProgressCard'
import type { CallEvent } from '@/types'

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  color = 'default',
}: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: string
  color?: 'default' | 'success' | 'danger' | 'warning' | 'info'
}) {
  const border = {
    default:  'border-border',
    success:  'border-emerald-500/30 bg-emerald-500/5',
    danger:   'border-rose-500/30 bg-rose-500/5',
    warning:  'border-amber-500/30 bg-amber-500/5',
    info:     'border-sky-500/30 bg-sky-500/5',
  }[color]

  const valCls = {
    default:  'text-slate-100',
    success:  'text-emerald-400',
    danger:   'text-rose-400',
    warning:  'text-amber-400',
    info:     'text-sky-400',
  }[color]

  return (
    <div className={cn('rounded-xl border p-4 text-center bg-card', border)}>
      <Icon className={cn('mx-auto mb-2 size-5', valCls)} />
      <p className={cn('font-mono text-2xl font-bold', valCls)}>{String(value)}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
      {sub && <p className="mt-0.5 text-[10px] text-slate-500">{sub}</p>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-300">
      <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-emerald-400" />
      {children}
      <span className="h-px flex-1 bg-border" />
    </p>
  )
}

// ---------------------------------------------------------------------------
// FinalReport
// ---------------------------------------------------------------------------

interface FinalReportProps {
  /** Elapsed seconds captured at the moment traffic stopped — shown as Total Run Time */
  frozenElapsed?: number | null
  /** Called when user clicks Unregister / Unsubscribe in the
   *  UnregisterProgressCard (CLEANUP_READY phase). */
  onUnregister?: () => void
  /** True while the start-cleanup POST is in flight. The card itself
   *  drives all post-click visuals from `cleanupStatus` + phase. */
  unregistering?: boolean
  /** Called when the user clicks Re-Run */
  onReRun?: () => void
  /** True while a re-run navigation is in progress */
  reRunning?: boolean
  /** Optional retry hook — invoked from the result strip's
   *  "Retry failed (n)" / "Retry all" buttons. */
  onRetryFailed?: (extensions: string[]) => void
}

export function FinalReport({
  frozenElapsed,
  onUnregister,
  unregistering = false,
  onReRun,
  reRunning = false,
  onRetryFailed,
}: FinalReportProps) {
  const phase         = useTrafficStore((s) => s.phase)
  const aggregate     = useTrafficStore((s) => s.aggregate)
  const callEvents    = useTrafficStore((s) => s.callEvents) as CallEvent[]
  const uacMetrics    = useTrafficStore((s) => s.uacMetrics)
  const prePhaseStatus = useTrafficStore((s) => s.prePhaseStatus)
  const pairs          = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  const pair     = pairs[activePairIndex]
  const extCount = pair ? (pair.uac.ext_end - pair.uac.ext_start + 1) : 0

  // Registration summary values
  const regDone  = prePhaseStatus?.register_count  ?? 0
  const regTotal = prePhaseStatus?.register_total  ?? extCount
  const regFail  = prePhaseStatus?.failed_count    ?? 0
  const subDone  = prePhaseStatus?.subscribe_count ?? 0
  const subTotal = prePhaseStatus?.subscribe_total ?? extCount

  // Call traffic summary
  const attempted  = aggregate?.total_attempted  ?? uacMetrics?.calls_attempted  ?? 0
  // Prefer aggregate.total_answered, fall back to live metric, then derive
  // from event list as a last resort (handles legacy backends without the
  // calls_answered counter).
  const answered   = aggregate?.total_answered
                  ?? uacMetrics?.calls_answered
                  ?? callEvents.filter((e) => e.answered === true).length
  const completed  = aggregate?.total_completed  ?? uacMetrics?.calls_completed  ?? 0
  const failed     = aggregate?.total_failed     ?? uacMetrics?.calls_failed     ?? 0
  const asr        = aggregate?.aggregate_asr    ?? uacMetrics?.asr              ?? 0
  const avgPdd     = uacMetrics?.avg_pdd_ms      ?? null
  const avgHold    = uacMetrics?.avg_hold_ms     ?? null

  // Use the frozen snapshot; fall back to live metrics
  const elapsed = frozenElapsed ?? uacMetrics?.run_elapsed_seconds ?? null
  const durationLabel = elapsed != null
    ? `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`
    : '—'

  const isFailed = phase === 'FAILED'

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6"
    >
      {/* Title + action buttons row */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          {isFailed ? (
            <XCircle className="size-6 text-rose-400" />
          ) : (
            <CheckCircle2 className="size-6 text-emerald-400" />
          )}
          <h1 className="text-xl font-bold text-slate-100">
            {isFailed ? 'Run Failed' : 'Run Complete — Final Report'}
          </h1>
        </div>

        {/* Quick-action buttons + cleanup card */}
        <div className="flex items-start gap-2 flex-wrap">
          {/* Re-Run: restart traffic with existing registered extensions */}
          {onReRun && (
            <button
              onClick={onReRun}
              disabled={reRunning || unregistering || phase === 'CLEANING_UP'}
              className={cn(
                'flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors',
                'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
                'hover:bg-emerald-500/20 hover:text-emerald-200',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {reRunning
                ? <Loader2 className="size-4 animate-spin" />
                : <RotateCcw className="size-4" />}
              Re-Run
            </button>
          )}

          {/* Unregister card — renders idle button, live progress card,
              or final result strip depending on phase + cleanupStatus. */}
          <UnregisterProgressCard
            starting={unregistering}
            disabled={reRunning}
            onUnregister={onUnregister}
            onRetryFailed={onRetryFailed}
          />
        </div>
      </div>

      {/* Registration summary */}
      <div className="space-y-3">
        <SectionLabel>Registration &amp; Subscription</SectionLabel>
        <div className="grid grid-cols-4 gap-3">
          <StatCard icon={CheckCircle2} label="Registered"      value={regDone.toLocaleString()}  color="success" />
          <StatCard icon={XCircle}      label="Reg Failed"      value={regFail}                    color={regFail > 0 ? 'danger' : 'default'} />
          <StatCard icon={CheckCircle2} label="Subscribed"      value={subDone.toLocaleString()}   color="success" />
          <StatCard icon={XCircle}      label="Sub Failed"      value={subTotal - subDone}          color={(subTotal - subDone) > 0 ? 'danger' : 'default'} />
        </div>
      </div>

      {/* Call traffic summary */}
      <div className="space-y-3">
        <SectionLabel>Call Traffic</SectionLabel>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Phone}          label="Attempted"            value={attempted.toLocaleString()}  color="info" />
          <StatCard icon={PhoneIncoming}  label="Answered (INV/200/ACK)" value={answered.toLocaleString()}   color={answered > 0 ? 'success' : 'default'} />
          <StatCard icon={CheckCircle2}   label="Completed (BYE/200)"  value={completed.toLocaleString()}  color="success" />
          <StatCard icon={PhoneMissed}    label="Failed"               value={failed.toLocaleString()}     color={failed > 0 ? 'danger' : 'default'} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Zap}        label="ASR"            value={`${asr.toFixed(1)}%`}         color={asr >= 95 ? 'success' : asr >= 80 ? 'warning' : 'danger'} />
          <StatCard icon={Clock}      label="Avg PDD"        value={avgPdd != null ? `${avgPdd.toFixed(0)} ms` : '—'}  color="default" />
          <StatCard icon={PhoneOff}   label="Avg Hold"       value={avgHold != null ? `${(avgHold / 1000).toFixed(1)} s` : '—'} color="default" />
          <StatCard icon={Clock}      label="Total Duration" value={durationLabel} color="default" />
        </div>
      </div>

      {/* Failed calls table */}
      <div className="space-y-2">
        <SectionLabel>Failed Call Records</SectionLabel>
        <FailedCallsTable events={callEvents} />
      </div>

      {/* Media QoS */}
      <div className="space-y-2">
        <SectionLabel>Media &amp; QoS</SectionLabel>
        <MediaQosPanel />
      </div>

      {/* Download */}
      <DownloadReport />
    </motion.div>
  )
}
