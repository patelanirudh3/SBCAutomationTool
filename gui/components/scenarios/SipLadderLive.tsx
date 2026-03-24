'use client'

import { useMemo } from 'react'
import { cn } from '@/lib/utils'
import type { SipMilestones, LadderEvent, LadderColumnId, CallSpine } from '@/types'

// ---------------------------------------------------------------------------
// Column layout — 5 equal columns within the arrow area
// Positions are percentages of the arrow container width
// ---------------------------------------------------------------------------

const COLUMNS: { id: LadderColumnId; label: string; sub: string }[] = [
  { id: 'uac', label: 'UAC', sub: 'Caller' },
  { id: 'sbcL', label: 'SBC + Kam', sub: 'Leg A' },
  { id: 'cm', label: 'CM', sub: 'B2BUA' },
  { id: 'sbcR', label: 'SBC + Kam', sub: 'Leg B' },
  { id: 'uas', label: 'UAS', sub: 'Callee' },
]

const COL_PCT: Record<LadderColumnId, number> = {
  uac: 10, sbcL: 30, cm: 50, sbcR: 70, uas: 90,
}

const ESTIMATED_TRANSIT_MS = 30

// ---------------------------------------------------------------------------
// Color helpers
// ---------------------------------------------------------------------------

function arrowColor(ev: LadderEvent): string {
  if (ev.inferred) return 'oklch(0.78 0.02 250)'
  if (ev.code) {
    if (ev.code >= 400) return 'oklch(0.65 0.22 25)'
    if (ev.code >= 200) return 'oklch(0.60 0.19 160)'
    if (ev.code >= 100) return 'oklch(0.62 0.04 250)'
  }
  return 'oklch(0.65 0.18 250)'
}

function arrowColorClass(ev: LadderEvent): string {
  if (ev.inferred) return 'text-muted-foreground'
  if (ev.code) {
    if (ev.code >= 400) return 'text-rose-400'
    if (ev.code >= 200) return 'text-emerald-400'
    if (ev.code >= 100) return 'text-foreground/50'
  }
  return 'text-blue-400'
}

// ---------------------------------------------------------------------------
// Build ladder events from a call spine
// ---------------------------------------------------------------------------

function buildEventsFromSpine(spine: CallSpine): LadderEvent[] {
  const events: LadderEvent[] = []

  const uacLeg = (spine.uac_leg ?? {}) as Record<string, unknown>
  const uasLeg = (spine.uas_leg ?? {}) as Record<string, unknown>
  const uacM = (uacLeg.sip_milestones ?? {}) as Partial<SipMilestones>
  const uasM = (uasLeg.sip_milestones ?? {}) as Partial<SipMilestones>

  const uacInviteUtc = (uacM.invite_ts_utc ?? '') as string
  const uasInviteUtc = (uasM.uas_invite_ts_utc ?? uasM.invite_ts_utc ?? '') as string

  const offset =
    uacInviteUtc && uasInviteUtc
      ? Date.parse(uasInviteUtc) - Date.parse(uacInviteUtc)
      : 0

  // --- Leg A (UAC ↔ SBC+Kam Left) ---

  if (uacM.invite_sent_ms != null) {
    events.push({
      t: uacM.invite_sent_ms,
      label: 'INVITE',
      from: 'uac',
      to: 'sbcL',
      callId: spine.call_ids.leg_a,
    })
  }

  if (uacM.trying_100_ms) {
    events.push({
      t: uacM.trying_100_ms,
      label: '100 Trying',
      from: 'sbcL',
      to: 'uac',
      code: 100,
    })
  }

  if (uacM.ringing_180_ms) {
    events.push({
      t: uacM.ringing_180_ms,
      label: '180 Ringing',
      from: 'sbcL',
      to: 'uac',
      code: 180,
      annotation: `PDD: ${uacM.ringing_180_ms.toFixed(0)}ms`,
    })
  }

  if (uacM.prack_sent_ms) {
    events.push({
      t: uacM.prack_sent_ms,
      label: 'PRACK',
      from: 'uac',
      to: 'sbcL',
    })
  }

  if (uacM.prack_200_ms) {
    events.push({
      t: uacM.prack_200_ms,
      label: '200 PRACK',
      from: 'sbcL',
      to: 'uac',
      code: 200,
    })
  }

  if (uacM.ok_200_ms) {
    events.push({
      t: uacM.ok_200_ms,
      label: '200 OK',
      from: 'sbcL',
      to: 'uac',
      code: 200,
    })
  }

  if (uacM.ack_sent_ms) {
    events.push({
      t: uacM.ack_sent_ms,
      label: 'ACK',
      from: 'uac',
      to: 'sbcL',
    })
  }

  // --- B2BUA Divider ---
  const legBCallId = spine.call_ids.leg_b ?? ''
  const truncId = legBCallId.length > 12 ? legBCallId.slice(0, 12) + '…' : legBCallId

  events.push({
    t: (uacM.ack_sent_ms ?? uacM.ok_200_ms ?? 0) + 0.5,
    label: `B2BUA: CM generates new Call-ID [${truncId}]`,
    type: 'divider',
  })

  // --- Leg B (CM ↔ SBC+Kam Right ↔ UAS) ---
  if (uasM.invite_received_ms != null && offset !== 0) {
    const cmInviteMs = (uasM.invite_received_ms ?? 0) + offset - ESTIMATED_TRANSIT_MS
    events.push({
      t: cmInviteMs,
      label: 'INVITE',
      from: 'cm',
      to: 'sbcR',
      callId: legBCallId,
      inferred: true,
    })
  }

  if (uasM.invite_received_ms != null) {
    events.push({
      t: (uasM.invite_received_ms ?? 0) + offset,
      label: 'INVITE',
      from: 'sbcR',
      to: 'uas',
      callId: legBCallId,
    })
  }

  if (uasM.ringing_180_sent_ms) {
    events.push({
      t: uasM.ringing_180_sent_ms + offset,
      label: '180 Ringing',
      from: 'uas',
      to: 'sbcR',
      code: 180,
    })
  }

  if (uasM.ok_200_sent_ms) {
    events.push({
      t: uasM.ok_200_sent_ms + offset,
      label: '200 OK',
      from: 'uas',
      to: 'sbcR',
      code: 200,
    })
  }

  if (uasM.ack_received_ms) {
    events.push({
      t: uasM.ack_received_ms + offset,
      label: 'ACK',
      from: 'sbcR',
      to: 'uas',
    })
  }

  // --- RTP bar ---
  if (uacM.rtp_start_ms) {
    events.push({
      t: uacM.rtp_start_ms,
      label: 'RTP ACTIVE',
      type: 'rtp',
      state: 'active',
    })
  }

  // --- BYE (Leg A) ---
  if (uacM.bye_sent_ms) {
    events.push({
      t: uacM.bye_sent_ms,
      label: 'BYE',
      from: 'uac',
      to: 'sbcL',
    })
  }

  if (uacM.bye_200_ms) {
    events.push({
      t: uacM.bye_200_ms,
      label: '200 BYE',
      from: 'sbcL',
      to: 'uac',
      code: 200,
    })
  }

  events.sort((a, b) => a.t - b.t)
  return events
}

// ---------------------------------------------------------------------------
// Arrow Row
// ---------------------------------------------------------------------------

function ArrowRow({ event }: { event: LadderEvent }) {
  if (!event.from || !event.to) return null

  const from = COL_PCT[event.from]
  const to = COL_PCT[event.to]
  const leftPct = Math.min(from, to)
  const widthPct = Math.abs(to - from)
  const goingRight = to > from
  const midPct = leftPct + widthPct / 2
  const color = arrowColor(event)
  const colorClass = arrowColorClass(event)
  const isResponse = !goingRight

  return (
    <div className="flex h-10 items-center group">
      {/* Time */}
      <div className="w-16 shrink-0 text-right pr-3">
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
          {event.t >= 0 ? `${Math.round(event.t)}` : ''}
        </span>
      </div>

      {/* Arrow area */}
      <div className="flex-1 relative h-full">
        {/* Arrow line */}
        <div
          className="absolute top-1/2"
          style={{
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            borderTopWidth: event.inferred ? '1.5px' : '2px',
            borderTopStyle: isResponse || event.inferred ? 'dashed' : 'solid',
            borderTopColor: color,
          }}
        >
          {/* Arrowhead at destination */}
          <div
            className="absolute top-1/2 -translate-y-1/2"
            style={{ [goingRight ? 'right' : 'left']: '-1px' }}
          >
            <div
              style={{
                width: 0,
                height: 0,
                borderTop: '4px solid transparent',
                borderBottom: '4px solid transparent',
                ...(goingRight
                  ? { borderLeft: `7px solid ${color}` }
                  : { borderRight: `7px solid ${color}` }),
              }}
            />
          </div>

          {/* Dot at origin */}
          <div
            className="absolute top-1/2 -translate-y-1/2 size-[5px] rounded-full"
            style={{
              [goingRight ? 'left' : 'right']: '-2.5px',
              backgroundColor: color,
            }}
          />
        </div>

        {/* Label above arrow */}
        <div
          className="absolute top-0 -translate-x-1/2 flex flex-col items-center leading-none pointer-events-none"
          style={{ left: `${midPct}%` }}
        >
          <span className={cn('text-[10px] font-semibold whitespace-nowrap', colorClass)}>
            {event.label}
          </span>
          {event.annotation && (
            <span className="text-[9px] text-emerald-400/70 whitespace-nowrap">
              {event.annotation}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// B2BUA Divider Row
// ---------------------------------------------------------------------------

function DividerRow({ event }: { event: LadderEvent }) {
  return (
    <div className="flex h-10 items-center">
      <div className="w-16 shrink-0" />
      <div className="flex-1 relative flex items-center gap-3">
        <div className="flex-1 border-t-2 border-dashed border-violet-500/40" />
        <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-violet-400/80 px-2">
          {event.label}
        </span>
        <div className="flex-1 border-t-2 border-dashed border-violet-500/40" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RTP Bar Row
// ---------------------------------------------------------------------------

function RtpBar({ event }: { event: LadderEvent }) {
  const isHeld = event.state === 'held'
  return (
    <div className="flex h-10 items-center">
      <div className="w-16 shrink-0 text-right pr-3">
        <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
          {Math.round(event.t)}
        </span>
      </div>
      <div className="flex-1 flex items-center gap-2 px-2">
        <div
          className={cn(
            'flex-1 h-3.5 rounded-sm flex items-center justify-center transition-colors',
            isHeld ? 'bg-amber-500/20 border border-amber-500/30' : 'bg-emerald-500/15 border border-emerald-500/25'
          )}
        >
          <span
            className={cn(
              'text-[10px] font-bold uppercase tracking-[0.15em]',
              isHeld ? 'text-amber-400' : 'text-emerald-400'
            )}
          >
            {isHeld ? '── RTP HELD ──' : '══ RTP ACTIVE ══'}
          </span>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Event Row dispatcher
// ---------------------------------------------------------------------------

function EventRow({ event }: { event: LadderEvent }) {
  if (event.type === 'divider') return <DividerRow event={event} />
  if (event.type === 'rtp') return <RtpBar event={event} />
  return <ArrowRow event={event} />
}

// ---------------------------------------------------------------------------
// Vertical timeline lines (background)
// ---------------------------------------------------------------------------

function TimelineLines({ rowCount }: { rowCount: number }) {
  return (
    <div
      className="absolute pointer-events-none"
      style={{ left: 64, right: 0, top: 0, bottom: 0 }}
    >
      {COLUMNS.map((col) => (
        <div
          key={col.id}
          className="absolute top-0 bottom-0 w-px border-l border-dashed border-border/30"
          style={{ left: `${COL_PCT[col.id]}%` }}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SipLadderLiveProps {
  spine: CallSpine
  className?: string
}

export function SipLadderLive({ spine, className }: SipLadderLiveProps) {
  const events = useMemo(() => buildEventsFromSpine(spine), [spine])

  if (events.length === 0) {
    return (
      <div className={cn('text-center py-8 text-sm text-muted-foreground', className)}>
        No SIP milestone data available for this call.
      </div>
    )
  }

  return (
    <div className={cn('rounded-xl border border-border bg-card overflow-hidden', className)}>
      {/* Column headers */}
      <div className="flex items-end border-b border-border/60 bg-secondary/20 py-2.5">
        <div className="w-16 shrink-0 text-right pr-3">
          <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">
            ms
          </span>
        </div>
        <div className="flex-1 flex">
          {COLUMNS.map((col) => (
            <div
              key={col.id}
              className="flex-1 flex flex-col items-center gap-0.5"
            >
              <span className="text-[10px] font-bold uppercase tracking-widest text-foreground/80">
                {col.label}
              </span>
              <span className="text-[9px] text-muted-foreground/60">{col.sub}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Timeline body */}
      <div className="relative py-1">
        <TimelineLines rowCount={events.length} />
        {events.map((ev, i) => (
          <EventRow key={i} event={ev} />
        ))}
      </div>
    </div>
  )
}
