'use client'

import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'

interface FailureAnalysisProps {
  className?: string
}

export function FailureAnalysis({ className }: FailureAnalysisProps) {
  const callEvents = useTrafficStore((s) => s.callEvents)
  const aggregate = useTrafficStore((s) => s.aggregate)

  const failedCalls = callEvents.filter((e) => e.result === 'FAILED')
  if (failedCalls.length === 0 || !aggregate) return null

  // Derive root cause from the most common failure reason
  const reasonCounts: Record<string, number> = {}
  for (const ev of failedCalls) {
    const reason = ev.failure_reason ?? 'Unknown error'
    reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1
  }
  const topReason = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])[0]

  // Pick two supporting evidence lines from failed calls — alternate UAS/UAC role labels
  // per spec: "[HH:MM:SS] UAS: <log line>" then "[HH:MM:SS] UAC: <log line>"
  const evidence = failedCalls.slice(0, 2).map((ev, i) => ({
    ts: new Date(ev.timestamp).toLocaleTimeString('en-US', { hour12: false }),
    role: i === 0 ? 'UAS' : 'UAC',
    line: `[${ev.uac_ext} → ${ev.uas_ext}] ${ev.failure_reason ?? 'No reason'} (${ev.media_status})`,
  }))

  const recommendation = topReason?.[0]?.includes('404')
    ? 'Verify UAS extension range matches UAC dial plan — destination extension not found.'
    : topReason?.[0]?.includes('408') || topReason?.[0]?.includes('Timeout')
      ? 'Check SBC reachability and SIP transport. Response timeout indicates network or config issue.'
      : 'Review SBC logs for INVITE rejection details and verify SIP credentials.'

  return (
    <div
      className={cn(
        'rounded-lg border border-rose-500/30 bg-rose-500/5 p-5 flex flex-col gap-3',
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <AlertTriangle className="size-4 text-rose-400 shrink-0" />
        <span className="text-xs font-bold uppercase tracking-widest text-rose-400">
          Failure Analysis
        </span>
      </div>

      {/* Root cause */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/70">
          Root Cause (most likely)
        </span>
        <p className="font-mono text-sm text-foreground">
          → {topReason?.[0] ?? 'Unknown'}{' '}
          <span className="text-foreground/55">
            ({topReason?.[1] ?? 0} occurrence{(topReason?.[1] ?? 0) !== 1 ? 's' : ''})
          </span>
        </p>
      </div>

      {/* Supporting evidence */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/70">
          Supporting Evidence
        </span>
        {evidence.map((ev, i) => (
          <div key={i} className="font-mono text-xs text-foreground/70">
            <span className="text-amber-400">[{ev.ts}]</span>{' '}
            <span className={ev.role === 'UAS' ? 'text-violet-400' : 'text-blue-400'}>
              {ev.role}:
            </span>{' '}
            {ev.line}
          </div>
        ))}
      </div>

      {/* Recommendation */}
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/70">
          Recommendation
        </span>
        <p className="font-mono text-sm text-foreground">→ {recommendation}</p>
      </div>
    </div>
  )
}
