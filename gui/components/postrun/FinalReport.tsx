'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { CheckCircle2, XCircle, Phone, PhoneOff, PhoneMissed, PhoneIncoming, PhoneCall, Clock, Zap, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'
import { FailedCallsTable } from '@/components/dashboard/FailedCallsTable'
import { MediaQosPanel, computeConfiguredRtpPacketsPerDirection } from '@/components/dashboard/MediaQosPanel'
import { VMHealthPanel } from '@/components/dashboard/VMHealthPanel'
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

const CLEANUP_AUTO_START_SECONDS = 45

interface FinalReportProps {
  /** Elapsed seconds captured at the moment traffic stopped — shown as Total Run Time */
  frozenElapsed?: number | null
  /** Called when user clicks Unregister / Unsubscribe in the
   *  UnregisterProgressCard (CLEANUP_READY phase). */
  onUnregister?: () => void
  /** True while the start-cleanup POST is in flight. The card itself
   *  drives all post-click visuals from `cleanupStatus` + phase. */
  unregistering?: boolean
  /** Optional retry hook — invoked from the result strip's
   *  "Retry failed (n)" / "Retry all" buttons. */
  onRetryFailed?: (extensions: string[]) => void
}

export function FinalReport({
  frozenElapsed,
  onUnregister,
  unregistering = false,
  onRetryFailed,
}: FinalReportProps) {
  const phase         = useTrafficStore((s) => s.phase)
  const aggregate     = useTrafficStore((s) => s.aggregate)
  const callEvents    = useTrafficStore((s) => s.callEvents) as CallEvent[]
  const uacMetrics    = useTrafficStore((s) => s.uacMetrics)
  const prePhaseStatus = useTrafficStore((s) => s.prePhaseStatus)
  const cleanupStatus  = useTrafficStore((s) => s.cleanupStatus)
  const pairs          = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)

  const pair     = pairs[activePairIndex]
  const extCount = pair ? (pair.uac.ext_end - pair.uac.ext_start + 1) : 0

  // Registration summary values
  const regDone  = prePhaseStatus?.register_count  ?? 0
  const regFail  = prePhaseStatus?.failed_count    ?? 0
  const subDone  = prePhaseStatus?.subscribe_count ?? 0
  const subTotal = prePhaseStatus?.subscribe_total ?? extCount
  const cleanedUp = cleanupStatus?.complete === true && (cleanupStatus.total ?? 0) > 0
  const unregisterFailedCount =
    (cleanupStatus?.unregister_failed_extensions ?? cleanupStatus?.failed_extensions ?? []).length
  const unsubscribeByEvent = cleanupStatus?.unsubscribe_by_event
  const unsubscribeSuccessful = unsubscribeByEvent
    ? Object.values(unsubscribeByEvent).reduce((sum, stats) => sum + (stats.successful ?? 0), 0)
    : Math.max(0, (cleanupStatus?.unsubscribe_count ?? 0) - (cleanupStatus?.unsubscribe_failed_extensions ?? []).length)
  const activeRegistered = cleanedUp
    ? Math.max(0, regDone - Math.max(0, (cleanupStatus?.unregister_count ?? 0) - unregisterFailedCount))
    : regDone
  const activeSubscribed = cleanedUp
    ? Math.max(0, subDone - unsubscribeSuccessful)
    : subDone
  const unregisteredCount = cleanedUp ? Math.max(0, regDone - activeRegistered) : 0
  const unsubscribedCount = cleanedUp ? Math.max(0, subDone - activeSubscribed) : 0
  const regCardLabel = cleanedUp ? 'Registered (Active)' : 'Registered'
  const subCardLabel = cleanedUp ? 'Subscribed (Active)' : 'Subscribed'

  // Call traffic summary
  // attempted = OOD INVITEs that received 100 Trying from the remote server.
  // No-response INVITEs are diagnostic only and require newer backend builds
  // that emit calls_invite_sent.
  const noResponseInvites =
    typeof uacMetrics?.calls_invite_sent === 'number'
      ? Math.max(uacMetrics.calls_invite_sent - (uacMetrics.calls_attempted ?? 0), 0)
      : null
  const attempted  = aggregate?.total_attempted  ?? uacMetrics?.calls_attempted  ?? 0
  // Prefer aggregate, fall back to live metric, then derive from event list
  // as a last resort. UAC-only filtering keeps the totals correct (events
  // contain both UAC and UAS legs).
  //
  // answered = 200 OK seen (RFC 3261 §13.2.2.4); independent of ACK.
  // acknowledged = full INV/200/ACK three-way handshake completed.
  // The gap between them surfaces 100rel/PRACK or SBC 200-OK delivery
  // problems at a glance.
  const answered     = aggregate?.total_answered
                    ?? uacMetrics?.calls_answered
                    ?? callEvents.filter((e) => e.direction !== 'uas' && e.answered === true).length
  const hasAckMetric = typeof uacMetrics?.calls_acknowledged === 'number'
  const hasAckEvents = callEvents.some((e) => e.direction !== 'uas' && typeof e.acknowledged === 'boolean')
  const completed  = aggregate?.total_completed  ?? uacMetrics?.calls_completed  ?? 0
  const acknowledged = aggregate?.total_acknowledged
                    ?? uacMetrics?.calls_acknowledged
                    ?? (hasAckEvents
                      ? callEvents.filter((e) => e.direction !== 'uas' && e.acknowledged === true).length
                      : completed)
  const failed     = Math.max(aggregate?.total_failed ?? 0, uacMetrics?.calls_failed ?? 0)
  const asr        = aggregate?.aggregate_asr    ?? uacMetrics?.asr              ?? 0
  const csr        = uacMetrics?.csr
                    ?? (attempted > 0 ? Math.round((completed / attempted) * 10000) / 100 : 0)
  const avgPdd     = uacMetrics?.avg_pdd_ms      ?? null
  const avgHold    = uacMetrics?.avg_hold_ms     ?? null

  // Use the frozen snapshot; fall back to live metrics
  const elapsed = frozenElapsed ?? uacMetrics?.run_elapsed_seconds ?? null
  const durationLabel = elapsed != null
    ? `${Math.floor(elapsed / 60)}m ${Math.floor(elapsed % 60)}s`
    : '—'

  const isFailed = phase === 'FAILED'
  const [cleanupCountdown, setCleanupCountdown] = useState(CLEANUP_AUTO_START_SECONDS)
  const [autoCleanupFired, setAutoCleanupFired] = useState(false)
  const onUnregisterRef = useRef(onUnregister)
  const cleanupPending = phase === 'CLEANUP_READY' && !cleanedUp
  const cleanupLocked = unregistering || phase === 'CLEANING_UP' || autoCleanupFired

  useEffect(() => {
    onUnregisterRef.current = onUnregister
  }, [onUnregister])

  useEffect(() => {
    if (!cleanupPending || !onUnregisterRef.current || cleanupLocked) return
    let remaining = CLEANUP_AUTO_START_SECONDS
    const id = setInterval(() => {
      remaining -= 1
      setCleanupCountdown(remaining)
      if (remaining <= 0) {
        clearInterval(id)
        setAutoCleanupFired(true)
        onUnregisterRef.current?.()
      }
    }, 1000)
    return () => clearInterval(id)
  }, [cleanupPending, cleanupLocked])

  const rtpEvents = callEvents.filter((e) =>
    (e.rtp_tx_pkts ?? 0) > 0 ||
    (e.rtp_rx_pkts ?? 0) > 0 ||
    (e.lost_packets ?? 0) > 0
  )
  const eventRtpTx = rtpEvents.reduce((sum, e) => sum + (e.rtp_tx_pkts ?? 0), 0)
  const eventRtpRx = rtpEvents.reduce((sum, e) => sum + (e.rtp_rx_pkts ?? 0), 0)
  const eventRtpRxFromSbc = rtpEvents.reduce((sum, e) => sum + (e.rtp_rx_from_sbc_pkts ?? 0), 0)
  const eventRtpExpected = rtpEvents.reduce((sum, e) => sum + (e.rtp_expected_pkts ?? 0), 0)
  const eventRtpLost = rtpEvents.reduce((sum, e) => sum + (e.lost_packets ?? 0), 0)
  const eventRtpSsrcCount = rtpEvents.reduce((sum, e) => sum + (e.rtp_ssrc_count ?? 0), 0)
  const eventAvgRtpTx = rtpEvents.length > 0 ? Math.round((eventRtpTx / rtpEvents.length) * 100) / 100 : 0
  const eventAvgRtpRxFromSbc = rtpEvents.length > 0 ? Math.round((eventRtpRxFromSbc / rtpEvents.length) * 100) / 100 : 0
  const eventLossDenominator = eventRtpExpected > 0 ? eventRtpExpected : eventRtpRxFromSbc + eventRtpLost
  const eventLossPct = eventLossDenominator > 0
    ? Math.round((eventRtpLost / eventLossDenominator) * 10000) / 100
    : 0
  const eventEffectiveRx = eventRtpRxFromSbc > 0 ? eventRtpRxFromSbc : eventRtpRx
  const eventAsymBase = Math.max(eventRtpTx, eventEffectiveRx)
  const eventAsymPct = eventAsymBase > 0
    ? Math.round((Math.abs(eventRtpTx - eventEffectiveRx) / eventAsymBase) * 10000) / 100
    : 0
  const eventAsymFlag = eventAsymPct > 15 ? 'CRITICAL' : eventAsymPct > 5 ? 'WARNING' : 'OK'
  const mediaCounts = uacMetrics?.media_quality_counts
  const trackedMedia = mediaCounts ? mediaCounts.OK + mediaCounts.WARNING + mediaCounts.CRITICAL : 0

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6"
    >
      {/* Pool reconciliation alert — surfaced when post-drain reconciliation
          could not return all agents to idle within the 3 × 60s budget.
          Block-level red banner advises the operator to Unregister rather
          than Re-Run with stuck agents (which would compound the problem). */}
      {uacMetrics?.reconciliation_status?.failed && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 flex items-start gap-3">
          <AlertTriangle className="size-5 text-rose-400 shrink-0 mt-0.5" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-semibold text-rose-200">
              Pool reconciliation failed
            </p>
            <p className="text-xs text-rose-300/80">
              Expected {uacMetrics.reconciliation_status.expected_idle} idle
              agents, only {uacMetrics.reconciliation_status.actual_idle}{' '}
              returned to idle after 3 reconciliation windows (180 s total).{' '}
              {(uacMetrics.reconciliation_status.stuck_agents?.length ?? 0)} extension(s)
              still in non-idle state.
            </p>
            <p className="text-xs text-rose-300/80">
              <strong>Recommended:</strong> click <strong>Unregister / Unsubscribe</strong>{' '}
              for a clean slate before the next run. Re-Run is unlikely to behave
              correctly with stuck agents.
            </p>
          </div>
        </div>
      )}

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
          {cleanupPending && !cleanupLocked && (
            <div className="rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2 text-xs font-semibold text-amber-200">
              Cleanup / Unregister starts in <span className="font-mono text-amber-100">{cleanupCountdown}s</span>
            </div>
          )}
          {cleanupLocked && !cleanedUp && (
            <div className="rounded-lg border border-sky-500/35 bg-sky-500/10 px-3 py-2 text-xs font-semibold text-sky-200">
              Cleanup is running. Actions are locked until unregister completes.
            </div>
          )}
          {/* Unregister card — renders idle button, live progress card,
              or final result strip depending on phase + cleanupStatus. */}
          <UnregisterProgressCard
            starting={(unregistering || autoCleanupFired) && !cleanupStatus}
            onUnregister={onUnregister}
            onRetryFailed={onRetryFailed}
          />
        </div>
      </div>

      {/* Registration summary */}
      <div className="space-y-3">
        <SectionLabel>Registration &amp; Subscription</SectionLabel>
        <div className="grid grid-cols-4 gap-3">
          <StatCard icon={CheckCircle2} label={regCardLabel}    value={activeRegistered.toLocaleString()}  color={activeRegistered > 0 ? 'success' : 'default'} sub={cleanedUp ? `${unregisteredCount.toLocaleString()} unregistered` : undefined} />
          <StatCard icon={XCircle}      label="Reg Failed"      value={regFail}                    color={regFail > 0 ? 'danger' : 'default'} />
          <StatCard icon={CheckCircle2} label={subCardLabel}    value={activeSubscribed.toLocaleString()}   color={activeSubscribed > 0 ? 'success' : 'default'} sub={cleanedUp ? `${unsubscribedCount.toLocaleString()} unsubscribed` : undefined} />
          <StatCard icon={XCircle}      label="Sub Failed"      value={subTotal - subDone}          color={(subTotal - subDone) > 0 ? 'danger' : 'default'} />
        </div>
      </div>

      {/* Call traffic summary */}
      <div className="space-y-3">
        <SectionLabel>Call Traffic</SectionLabel>
        {/* Six-step funnel: INVITEs Sent → Attempted (got 100) → Answered
            → Acknowledged → Completed → Failed. Each gap is diagnostic:
            • Sent − Attempted = SBC didn't respond at all (network/reach)
            • Attempted − Answered = SBC didn't deliver the 200 OK
            • Answered − Acknowledged = ACK didn't reach the UAS
            • Acknowledged − Completed = BYE didn't complete */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
          <StatCard icon={Phone}          label="No Response INVITEs"         value={noResponseInvites == null ? '—' : noResponseInvites.toLocaleString()} color={noResponseInvites && noResponseInvites > 0 ? 'warning' : 'default'} sub={noResponseInvites == null ? 'unavailable' : 'no 100 Trying'} />
          <StatCard icon={Phone}          label="Attempted"                  value={attempted.toLocaleString()}     color="info"    sub="got 100 Trying" />
          <StatCard icon={PhoneIncoming}  label="Answered (INV/200)"         value={answered.toLocaleString()}      color={answered > 0 ? 'success' : 'default'} />
          <StatCard icon={PhoneCall}      label="Acknowledged (INV/200/ACK)" value={hasAckMetric || hasAckEvents ? acknowledged.toLocaleString() : `${acknowledged.toLocaleString()}+`}  color={acknowledged > 0 ? 'success' : 'default'} sub={hasAckMetric || hasAckEvents ? undefined : 'lower bound'} />
          <StatCard icon={CheckCircle2}   label="Completed (BYE/200)"        value={completed.toLocaleString()}     color="success" />
          <StatCard icon={PhoneMissed}    label="Failed"                     value={failed.toLocaleString()}        color={failed > 0 ? 'danger' : 'default'} />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard icon={Zap}        label="ASR"            value={`${asr.toFixed(1)}%`}         color={asr >= 95 ? 'success' : asr >= 80 ? 'warning' : 'danger'} sub="Answered / Attempted" />
          <StatCard icon={CheckCircle2} label="CSR"          value={`${csr.toFixed(1)}%`}         color={csr >= 95 ? 'success' : csr >= 80 ? 'warning' : 'danger'} sub="Completed / Attempted" />
          <StatCard icon={Clock}      label="Avg PDD"        value={avgPdd != null ? `${avgPdd.toFixed(0)} ms` : '—'}  color="default" />
          <StatCard icon={PhoneOff}   label="Avg Hold"       value={avgHold != null ? `${(avgHold / 1000).toFixed(1)} s` : '—'} color="default" />
          <StatCard icon={Clock}      label="Total Duration" value={durationLabel} color="default" />
        </div>
      </div>

      {/* Failed calls table */}
      <div className="space-y-2">
        <SectionLabel>Failed Call Records</SectionLabel>
        <FailedCallsTable
          events={callEvents}
          reportedFailedCount={failed}
        />
      </div>

      {/* Media QoS */}
      <div className="space-y-2">
        <SectionLabel>Media &amp; QoS</SectionLabel>
        <MediaQosPanel
          jitterMs={uacMetrics?.avg_jitter_ms ?? null}
          mosEstimate={uacMetrics?.avg_mos_score ?? null}
          qosScore={trackedMedia > 0 && mediaCounts ? (mediaCounts.OK / trackedMedia) * 100 : null}
          rttMs={uacMetrics?.avg_rtt_ms ?? null}
          rtcpSrEnabled={pair?.advancedSettings?.rtcp_sr_enabled === true}
          rtpFlow={{
            mediaSecurity: uacMetrics?.media_security ?? pair?.uac.media_security ?? 'rtp',
            srtpCryptoSuites: uacMetrics?.srtp_crypto_suites ?? pair?.uac.srtp_crypto_suites ?? null,
            configuredPacketsPerDirection: computeConfiguredRtpPacketsPerDirection(
              pair?.uac.hold_time_seconds,
              pair?.uac.rtp_ptime,
              pair?.advancedSettings,
            ),
            avgTxPackets: uacMetrics?.avg_rtp_tx_pkts ?? aggregate?.avg_rtp_tx_pkts ?? eventAvgRtpTx,
            avgRxFromSbcPackets: uacMetrics?.avg_rtp_rx_from_sbc_pkts ?? aggregate?.avg_rtp_rx_from_sbc_pkts ?? eventAvgRtpRxFromSbc,
            totalTxPackets: uacMetrics?.total_rtp_tx_pkts ?? aggregate?.total_rtp_tx_pkts ?? eventRtpTx,
            totalRxPackets: uacMetrics?.total_rtp_rx_pkts ?? aggregate?.total_rtp_rx_pkts ?? eventRtpRx,
            totalRxFromSbcPackets: uacMetrics?.total_rtp_rx_from_sbc_pkts ?? aggregate?.total_rtp_rx_from_sbc_pkts ?? eventRtpRxFromSbc,
            totalExpectedPackets: uacMetrics?.total_rtp_expected_pkts ?? aggregate?.total_rtp_expected_pkts ?? eventRtpExpected,
            totalLostPackets: uacMetrics?.total_rtp_lost_pkts ?? aggregate?.total_rtp_lost_pkts ?? eventRtpLost,
            totalSsrcCount: uacMetrics?.total_rtp_ssrc_count ?? aggregate?.total_rtp_ssrc_count ?? eventRtpSsrcCount,
            lossPct: uacMetrics?.rtp_loss_pct ?? aggregate?.rtp_loss_pct ?? eventLossPct,
            asymmetryPct: uacMetrics?.rtp_asymmetry_pct ?? aggregate?.rtp_asymmetry_pct ?? eventAsymPct,
            asymmetryFlag: uacMetrics?.rtp_asymmetry_flag ?? aggregate?.rtp_asymmetry_flag ?? eventAsymFlag,
          }}
        />
        <VMHealthPanel
          health={uacMetrics?.host_health ?? null}
          variant={phase === 'CLEANING_UP' ? 'compact' : 'summary'}
          summary={{
            hostCpuAvg: uacMetrics?.host_cpu_avg_percent ?? null,
            hostCpuMax: uacMetrics?.host_cpu_max_percent ?? null,
            engineCpuCoreAvg: uacMetrics?.process_cpu_core_avg_percent ?? null,
            engineCpuCoreMax: uacMetrics?.process_cpu_core_max_percent ?? null,
            softirqCpuMax: uacMetrics?.softirq_cpu_max_percent ?? null,
            iowaitCpuMax: uacMetrics?.iowait_cpu_max_percent ?? null,
          }}
        />
      </div>

      {/* Download */}
      <DownloadReport showNewRun={false} />
    </motion.div>
  )
}
