'use client'

import { useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Radio,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { SipLadderLive } from '@/components/scenarios/SipLadderLive'
import type { CallSpine, MediaCrossCheck } from '@/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function healthDot(status: string) {
  if (status === 'OK') return 'bg-emerald-400'
  if (status === 'WARNING' || status === 'DEGRADED') return 'bg-amber-400'
  return 'bg-rose-500'
}

function mediaLabel(leg: Record<string, unknown> | null): string {
  if (!leg) return '—'
  const verified = leg.media_verified as boolean | undefined
  const status = leg.media_status as string | undefined
  if (verified || status === 'MEDIA_VERIFIED') return 'VERIFIED'
  if (status === 'MEDIA_PARTIAL') return 'PARTIAL'
  if (status === 'MEDIA_FAILED') return 'FAILED'
  if ((leg.rtp_tx_pkts as number) > 0 || (leg.rtp_rx_pkts as number) > 0) return 'PARTIAL'
  return 'NONE'
}

function mediaClass(label: string): string {
  if (label === 'VERIFIED') return 'text-emerald-400'
  if (label === 'PARTIAL') return 'text-amber-400'
  if (label === 'FAILED') return 'text-rose-500'
  return 'text-muted-foreground'
}

function truncate(s: string, n = 12): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

const CORR_BADGE: Record<string, { label: string; cls: string }> = {
  gsid: { label: 'GSID', cls: 'bg-blue-500/15 text-blue-400' },
  ext_time: { label: 'ext+time', cls: 'bg-emerald-400/15 text-emerald-400' },
  unmatched: { label: 'unmatched', cls: 'bg-amber-400/15 text-amber-400' },
}

// ---------------------------------------------------------------------------
// RTP Cross-check Table
// ---------------------------------------------------------------------------

function RtpCrossCheck({ check }: { check: MediaCrossCheck }) {
  const { uac_tx_vs_uas_rx: a2b, uas_tx_vs_uac_rx: b2a } = check
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-border bg-secondary/30">
            <th className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-widest text-foreground/60">Direction</th>
            <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-widest text-foreground/60">TX</th>
            <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-widest text-foreground/60">RX (filtered)</th>
            <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-widest text-foreground/60">Delta %</th>
            <th className="px-3 py-2 text-center text-[10px] font-bold uppercase tracking-widest text-foreground/60">Flag</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-border/50">
            <td className="px-3 py-2 font-mono text-foreground/70">UAC→UAS</td>
            <td className="px-3 py-2 text-right font-mono">{a2b.uac_tx ?? '—'}</td>
            <td className="px-3 py-2 text-right font-mono">{a2b.uas_rx ?? '—'}</td>
            <td className="px-3 py-2 text-right font-mono">{a2b.delta_pct}%</td>
            <td className="px-3 py-2 text-center">
              <FlagBadge flag={a2b.flag} />
            </td>
          </tr>
          <tr>
            <td className="px-3 py-2 font-mono text-foreground/70">UAS→UAC</td>
            <td className="px-3 py-2 text-right font-mono">{b2a.uas_tx ?? '—'}</td>
            <td className="px-3 py-2 text-right font-mono">{b2a.uac_rx ?? '—'}</td>
            <td className="px-3 py-2 text-right font-mono">{b2a.delta_pct}%</td>
            <td className="px-3 py-2 text-center">
              <FlagBadge flag={b2a.flag} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

function FlagBadge({ flag }: { flag: string }) {
  const cls =
    flag === 'OK'
      ? 'bg-emerald-400/15 text-emerald-400'
      : flag === 'WARNING'
        ? 'bg-amber-400/15 text-amber-400'
        : 'bg-rose-500/15 text-rose-500'
  return (
    <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-bold uppercase', cls)}>
      {flag}
    </span>
  )
}

// ---------------------------------------------------------------------------
// CallSpineCard
// ---------------------------------------------------------------------------

interface CallSpineCardProps {
  spine: CallSpine
  index: number
  className?: string
}

export function CallSpineCard({ spine, index, className }: CallSpineCardProps) {
  const [expanded, setExpanded] = useState(false)

  const uac = (spine.uac_leg ?? {}) as Record<string, unknown>
  const uas = spine.uas_leg as Record<string, unknown> | null

  const uacExt = (uac.caller as string) ?? (uac.ext as string) ?? ''
  const uasExt = (uac.callee as string) ?? (uac.peer_ext as string) ?? ''
  const result = (uac.success as boolean) || (uac.result as string) === 'COMPLETED'
  const pddMs = (uac.pdd_ms as number) ?? 0
  const holdMs = (uac.hold_ms as number) ?? 0
  const uacMedia = mediaLabel(uac)
  const uasMedia = mediaLabel(uas)
  const overall = spine.media_cross_check?.overall_status ?? 'OK'
  const corr = CORR_BADGE[spine.correlation_method] ?? CORR_BADGE.unmatched

  return (
    <div className={cn('rounded-xl border border-border bg-card overflow-hidden', className)}>
      {/* Summary row — always visible */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-secondary/20 transition-colors text-left"
      >
        {/* Expand icon */}
        {expanded
          ? <ChevronDown className="size-4 text-muted-foreground shrink-0" />
          : <ChevronRight className="size-4 text-muted-foreground shrink-0" />
        }

        {/* Index */}
        <span className="text-xs font-mono text-muted-foreground w-6">#{index + 1}</span>

        {/* Extensions */}
        <span className="text-sm font-mono font-semibold text-foreground">
          {uacExt} → {uasExt}
        </span>

        {/* Result badge */}
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-bold',
            result
              ? 'bg-emerald-400/10 text-emerald-400'
              : 'bg-rose-500/10 text-rose-500'
          )}
        >
          {result ? 'COMPLETED' : 'FAILED'}
        </span>

        {/* PDD */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">PDD</span>
          <span className="text-xs font-mono font-semibold text-foreground">
            {pddMs > 0 ? `${pddMs.toFixed(0)}ms` : '—'}
          </span>
        </div>

        {/* Hold */}
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground">Hold</span>
          <span className="text-xs font-mono font-semibold text-foreground">
            {holdMs > 0 ? `${(holdMs / 1000).toFixed(1)}s` : '—'}
          </span>
        </div>

        {/* Media */}
        <div className="flex items-center gap-1.5">
          <Radio className="size-3 text-muted-foreground" />
          <span className={cn('text-[10px] font-bold', mediaClass(uacMedia))}>{uacMedia}</span>
          <span className="text-muted-foreground/40">/</span>
          <span className={cn('text-[10px] font-bold', mediaClass(uasMedia))}>{uasMedia}</span>
        </div>

        {/* RTP health dot */}
        <span className={cn('size-2 rounded-full shrink-0', healthDot(overall))} />

        {/* Spacer */}
        <div className="flex-1" />

        {/* Correlation badge */}
        <span className={cn('rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide', corr.cls)}>
          {corr.label}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="border-t border-border px-4 py-4 flex flex-col gap-4">
          {/* Call IDs */}
          <div className="flex items-center gap-4 text-xs">
            <GitBranch className="size-3.5 text-violet-400 shrink-0" />
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Leg A:</span>
              <span className="font-mono text-foreground" title={spine.call_ids.leg_a}>
                {truncate(spine.call_ids.leg_a, 16)}
              </span>
            </div>
            <div className="h-3 w-px bg-border" />
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground">Leg B:</span>
              <span className="font-mono text-foreground" title={spine.call_ids.leg_b ?? ''}>
                {spine.call_ids.leg_b ? truncate(spine.call_ids.leg_b, 16) : '—'}
              </span>
            </div>
            <div className="h-3 w-px bg-border" />
            <span className="text-muted-foreground/60">{spine.call_ids.b2bua_boundary}</span>
          </div>

          {/* SIP Ladder — static mode from spine */}
          <SipLadderLive spine={spine} />

          {/* RTP Cross-check */}
          {spine.media_cross_check ? (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-widest text-foreground/60 mb-2">
                RTP Cross-Check
              </h4>
              <RtpCrossCheck check={spine.media_cross_check} />
            </div>
          ) : null}

          {/* Scenario assertions (if present) */}
          {Array.isArray(uac.scenario_assertions) ? (
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-widest text-foreground/60 mb-2">
                Scenario Assertions
              </h4>
              <div className="flex flex-wrap gap-2">
                {(uac.scenario_assertions as { name: string; passed: boolean }[]).map((a) => (
                  <span
                    key={a.name}
                    className={cn(
                      'rounded px-2 py-1 text-[10px] font-semibold',
                      a.passed
                        ? 'bg-emerald-400/15 text-emerald-400'
                        : 'bg-rose-500/15 text-rose-500'
                    )}
                  >
                    {a.name}: {a.passed ? 'PASS' : 'FAIL'}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}
