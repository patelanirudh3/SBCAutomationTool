'use client'

import { Activity, Gauge, BarChart3, Construction, Timer, Radio, Send, Download, Percent } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AdvancedSettings } from '@/types'

export interface RtpFlowStats {
  mediaSecurity?: string | null
  srtpCryptoSuites?: string[] | null
  configuredPacketsPerDirection?: number | null
  avgTxPackets?: number | null
  avgRxFromSbcPackets?: number | null
  totalTxPackets?: number | null
  totalRxPackets?: number | null
  totalRxFromSbcPackets?: number | null
  totalExpectedPackets?: number | null
  totalLostPackets?: number | null
  totalSsrcCount?: number | null
  lossPct?: number | null
  asymmetryPct?: number | null
  asymmetryFlag?: 'OK' | 'WARNING' | 'CRITICAL' | string | null
}

interface MediaQosPanelProps {
  jitterMs?: number | null
  mosEstimate?: number | null
  qosScore?: number | null
  /** Round-trip time from RTCP SR/RR. Only meaningful when RTCP SR
   *  transmission is enabled in Advanced Settings (Phase 2). */
  rttMs?: number | null
  /** Whether RTCP SR transmission is enabled. When false, the RTT card is
   *  hidden because no SR has been sent and the value will always be 0. */
  rtcpSrEnabled?: boolean
  rtpFlow?: RtpFlowStats
}

export function computeConfiguredRtpPacketsPerDirection(
  holdSeconds: number | undefined,
  ptimeMs: number | undefined,
  settings: AdvancedSettings | undefined,
): number | null {
  if (!settings || !holdSeconds || holdSeconds <= 0) return null
  const pps = 1000 / (ptimeMs && ptimeMs > 0 ? ptimeMs : 20)

  if (settings.rtp_mode === 'continuous') {
    return Math.round(holdSeconds * pps)
  }

  if (settings.rtp_mode === '3phase_coverage') {
    const coveragePct = Math.min(Math.max(settings.rtp_media_coverage_pct ?? 25, 1), 100)
    const activeSeconds = holdSeconds * coveragePct / 100
    const idleSeconds = Math.max(holdSeconds - activeSeconds, 0)
    const keepaliveEnabled = settings.rtp_coverage_keepalive_enabled !== false
    const keepalivePps = Math.min(Math.max(settings.rtp_coverage_keepalive_pps ?? 3, 1), 5)
    return Math.round(activeSeconds * pps) + (keepaliveEnabled ? Math.round(idleSeconds * keepalivePps) : 0)
  }

  const burstSeconds = Math.max(settings.rtp_burst_seconds ?? 2, 0)
  const keepaliveInterval = Math.max(settings.rtp_keepalive_interval ?? 3, 1)
  const burstPps = 50
  const phase1Seconds = Math.min(holdSeconds, burstSeconds)
  const phase3Seconds = holdSeconds > phase1Seconds
    ? Math.min(burstSeconds, holdSeconds - phase1Seconds)
    : 0
  const keepaliveWindow = Math.max(holdSeconds - phase1Seconds - phase3Seconds, 0)
  return Math.round((phase1Seconds + phase3Seconds) * burstPps + Math.ceil(keepaliveWindow / keepaliveInterval))
}

function QosCard({
  icon: Icon,
  label,
  value,
  unit,
  pending,
}: {
  icon: React.ElementType
  label: string
  value?: number | null
  unit?: string
  pending: boolean
}) {
  return (
    <div className={cn(
      'flex flex-col items-center gap-2 rounded-xl border p-4',
      pending ? 'border-slate-700/40 bg-slate-800/30' : 'border-sky-500/25 bg-sky-500/5',
    )}>
      <Icon className={cn('size-5', pending ? 'text-slate-500' : 'text-sky-400')} />
      <div className="text-center">
        {pending || value == null ? (
          <span className="block font-mono text-lg font-bold text-slate-500">—</span>
        ) : (
          <span className="block font-mono text-lg font-bold text-sky-300">
            {typeof value === 'number' ? value.toFixed(1) : value}
            {unit && <span className="ml-0.5 text-xs text-slate-400">{unit}</span>}
          </span>
        )}
        <span className="text-[11px] text-slate-400">{label}</span>
      </div>
    </div>
  )
}

function FlowCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'success' | 'warning' | 'danger'
}) {
  const toneClass =
    tone === 'success' ? 'border-emerald-500/25 bg-emerald-500/5 text-emerald-300'
    : tone === 'warning' ? 'border-amber-500/25 bg-amber-500/5 text-amber-300'
    : tone === 'danger' ? 'border-rose-500/25 bg-rose-500/5 text-rose-300'
    : 'border-indigo-500/25 bg-indigo-500/5 text-indigo-300'

  return (
    <div className={cn('rounded-xl border p-3', toneClass)}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      </div>
      <div className="mt-2 font-mono text-lg font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

function formatCount(v?: number | null): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—'
  const rounded = Math.round(v)
  if (Math.abs(rounded) >= 1_000_000_000_000) {
    return `${(rounded / 1_000_000_000_000).toFixed(2)}T`
  }
  return rounded.toLocaleString()
}

function formatOne(v?: number | null): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—'
}

function asymmetryTone(flag?: string | null): 'default' | 'success' | 'warning' | 'danger' {
  if (flag === 'CRITICAL') return 'danger'
  if (flag === 'WARNING') return 'warning'
  if (flag === 'OK') return 'success'
  return 'default'
}

export function MediaQosPanel({ jitterMs, mosEstimate, qosScore, rttMs, rtcpSrEnabled, rtpFlow }: MediaQosPanelProps) {
  const isPending = jitterMs == null && mosEstimate == null && qosScore == null
  const isSRTP = rtpFlow?.mediaSecurity === 'srtp_sdes'
  const mediaLabel = isSRTP ? 'SRTP' : 'RTP'

  // RTT card is shown only when RTCP SR is enabled — otherwise the SBC has
  // never received an SR from us so the field would always read 0/—.
  const showRtt = !!rtcpSrEnabled
  const cardCount = showRtt ? 4 : 3

  return (
    <div className="rounded-xl border border-slate-700/40 bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Activity className="size-4 text-sky-400" />
        <span className="text-sm font-semibold text-slate-200">Media &amp; QoS</span>
        <span className="rounded border border-slate-700 bg-slate-900/50 px-2 py-0.5 text-[10px] font-semibold text-slate-300">
          {isSRTP ? `SRTP (SDES${rtpFlow?.srtpCryptoSuites?.length ? ` · ${rtpFlow.srtpCryptoSuites.join(', ')}` : ''})` : 'RTP'}
        </span>
        {isPending && (
          <span className="ml-auto flex items-center gap-1 rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
            <Construction className="size-3" />
            Backend pending
          </span>
        )}
        {showRtt && !isPending && (
          <span className="ml-auto rounded border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
            RTCP SR active
          </span>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Radio className="size-3.5 text-indigo-400" />
          <span className="text-xs font-bold uppercase tracking-wide text-slate-300">{mediaLabel} Flow</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <FlowCard
            icon={Radio}
            label="Configured / Dir / Call"
            value={formatCount(rtpFlow?.configuredPacketsPerDirection)}
          />
          <FlowCard
            icon={Send}
            label="Avg TX / Dir / Call"
            value={formatOne(rtpFlow?.avgTxPackets)}
          />
          <FlowCard
            icon={Download}
            label="Avg RX / Dir / Call"
            value={formatOne(rtpFlow?.avgRxFromSbcPackets)}
            sub="from SBC"
          />
          <FlowCard
            icon={Percent}
            label={`${mediaLabel} Loss`}
            value={typeof rtpFlow?.lossPct === 'number' ? `${rtpFlow.lossPct.toFixed(2)}%` : '—'}
            sub={`${formatCount(rtpFlow?.totalLostPackets)} lost / ${formatCount(rtpFlow?.totalExpectedPackets)} expected`}
            tone={(rtpFlow?.lossPct ?? 0) > 5 ? 'danger' : (rtpFlow?.lossPct ?? 0) > 1 ? 'warning' : 'success'}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <FlowCard icon={Send} label={`Total ${mediaLabel} TX`} value={formatCount(rtpFlow?.totalTxPackets)} />
          <FlowCard icon={Download} label={`Total ${mediaLabel} RX`} value={formatCount(rtpFlow?.totalRxFromSbcPackets ?? rtpFlow?.totalRxPackets)} sub="from SBC" />
          <FlowCard
            icon={Gauge}
            label="TX/RX Asymmetry"
            value={typeof rtpFlow?.asymmetryPct === 'number' ? `${rtpFlow.asymmetryPct.toFixed(2)}%` : '—'}
            sub={rtpFlow?.asymmetryFlag ?? undefined}
            tone={asymmetryTone(rtpFlow?.asymmetryFlag)}
          />
          <FlowCard icon={Activity} label="RX SSRCs" value={formatCount(rtpFlow?.totalSsrcCount)} sub={`all RX: ${formatCount(rtpFlow?.totalRxPackets)}`} />
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Activity className="size-3.5 text-sky-400" />
          <span className="text-xs font-bold uppercase tracking-wide text-slate-300">Media Quality</span>
        </div>
      <div className={cn('grid gap-3', cardCount === 4 ? 'grid-cols-4' : 'grid-cols-3')}>
        <QosCard icon={Activity}  label="Jitter (ms)"   value={jitterMs}     unit="ms"  pending={jitterMs == null} />
        <QosCard icon={BarChart3} label="MOS Estimate"  value={mosEstimate}  unit=""    pending={mosEstimate == null} />
        <QosCard icon={Gauge}     label="QoS Score"     value={qosScore}     unit="%"   pending={qosScore == null} />
        {showRtt && (
          <QosCard icon={Timer}   label="RTT (ms)"      value={rttMs}        unit="ms"  pending={rttMs == null || rttMs === 0} />
        )}
      </div>
      </div>

      {isPending && (
        <p className="text-[11px] text-slate-500 leading-relaxed">
          Media quality metrics (jitter, MOS, QoS) will be populated once the backend implementation is complete.
          The UI is ready to display them automatically.
        </p>
      )}
    </div>
  )
}
