'use client'

import { useState, useMemo } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'
import type { CallEvent } from '@/types'

type SortKey = 'result' | 'pdd_ms' | null
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 20

const MEDIA_BADGE: Record<string, { label: string; cls: string }> = {
  MEDIA_VERIFIED: { label: 'VERIFIED', cls: 'text-emerald-400' },
  MEDIA_PARTIAL: { label: 'PARTIAL', cls: 'text-amber-400' },
  MEDIA_FAILED: { label: 'FAILED', cls: 'text-rose-500' },
  NO_MEDIA: { label: 'NONE', cls: 'text-muted-foreground' },
}

const CORRELATION_BADGE: Record<string, { label: string; cls: string }> = {
  gsid: { label: 'GSID', cls: 'bg-blue-500/15 text-blue-400' },
  ext_time: { label: 'ext+time', cls: 'bg-emerald-400/15 text-emerald-400' },
  unmatched: { label: 'unmatched', cls: 'bg-amber-400/15 text-amber-400' },
}

interface SpineRow {
  spineId: string
  uacExt: string
  uasExt: string
  result: 'COMPLETED' | 'FAILED'
  failureReason: string | null
  pdd_ms: number
  hold_ms: number
  uacMedia: string
  uasMedia: string
  correlationMethod: string
  legACallId: string
  legBCallId: string
}

function extractSpineRow(spine: Record<string, unknown>): SpineRow {
  const uac = (spine.uac_leg ?? {}) as Record<string, unknown>
  const uas = (spine.uas_leg ?? {}) as Record<string, unknown>
  const callIds = (spine.call_ids ?? {}) as Record<string, unknown>

  const uacSuccess = uac.success as boolean | undefined
  const uacResult = uac.result as string | undefined
  let result: 'COMPLETED' | 'FAILED' = 'FAILED'
  if (uacSuccess === true || uacResult === 'COMPLETED') result = 'COMPLETED'

  const uacMediaVerified = uac.media_verified as boolean | undefined
  let uacMedia = 'NO_MEDIA'
  if (uacMediaVerified) {
    uacMedia = 'MEDIA_VERIFIED'
  } else if (((uac.rtp_tx_pkts as number) ?? 0) > 0 || ((uac.rtp_rx_pkts as number) ?? 0) > 0) {
    uacMedia = 'MEDIA_PARTIAL'
  }

  let uasMedia = 'NO_MEDIA'
  if (uas && Object.keys(uas).length > 0) {
    const uasMediaVerified = uas.media_verified as boolean | undefined
    const uasMediaStatus = uas.media_status as string | undefined
    if (uasMediaVerified || uasMediaStatus === 'MEDIA_VERIFIED') {
      uasMedia = 'MEDIA_VERIFIED'
    } else if (
      ((uas.rtp_tx_pkts as number) ?? 0) > 0 ||
      ((uas.rtp_rx_pkts as number) ?? 0) > 0
    ) {
      uasMedia = 'MEDIA_PARTIAL'
    }
  }

  return {
    spineId: (spine.spine_id as string) ?? '',
    uacExt: (uac.caller as string) ?? (uac.ext as string) ?? '',
    uasExt: (uac.callee as string) ?? (uac.peer_ext as string) ?? '',
    result,
    failureReason: (uac.failure_reason as string) || null,
    pdd_ms: (uac.pdd_ms as number) ?? 0,
    hold_ms: (uac.hold_ms as number) ?? 0,
    uacMedia,
    uasMedia,
    correlationMethod: (spine.correlation_method as string) ?? 'unmatched',
    legACallId: (callIds.leg_a as string) ?? '',
    legBCallId: (callIds.leg_b as string) ?? '',
  }
}

function mediaBadge(status: string) {
  return MEDIA_BADGE[status] ?? MEDIA_BADGE.NO_MEDIA
}

function truncateCallId(id: string, maxLen = 10): string {
  if (!id || id.length <= maxLen) return id || '—'
  return id.slice(0, maxLen) + '\u2026'
}

function SortIcon({
  col,
  sortKey,
  dir,
}: {
  col: SortKey
  sortKey: SortKey
  dir: SortDir
}) {
  if (sortKey !== col) return <ChevronsUpDown className="size-3 text-muted-foreground/50" />
  if (dir === 'asc') return <ChevronUp className="size-3 text-emerald-400" />
  return <ChevronDown className="size-3 text-emerald-400" />
}

interface CallTableProps {
  className?: string
}

export function CallTable({ className }: CallTableProps) {
  const callSpines = useTrafficStore((s) => s.callSpines)
  const callEvents = useTrafficStore((s) => s.callEvents)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [page, setPage] = useState(0)

  const rows = useMemo(() => {
    if (callSpines.length > 0) {
      return callSpines.map(extractSpineRow)
    }
    // Fallback: derive rows from UAC call events when spines aren't available yet
    return callEvents
      .filter((ev) => ev.direction === 'uac')
      .map(
        (ev): SpineRow => ({
          spineId: ev.call_id,
          uacExt: ev.uac_ext,
          uasExt: ev.uas_ext,
          result: ev.result,
          failureReason: ev.failure_reason ?? null,
          pdd_ms: ev.pdd_ms,
          hold_ms: ev.hold_ms,
          uacMedia: ev.media_status,
          uasMedia: 'NO_MEDIA',
          correlationMethod: 'unmatched',
          legACallId: ev.call_id,
          legBCallId: '',
        })
      )
  }, [callSpines, callEvents])

  const sorted = useMemo(() => {
    if (!sortKey) return rows
    return [...rows].sort((a, b) => {
      const mul = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'result') {
        return mul * a.result.localeCompare(b.result)
      }
      if (sortKey === 'pdd_ms') {
        return mul * (a.pdd_ms - b.pdd_ms)
      }
      return 0
    })
  }, [rows, sortKey, sortDir])

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const slice = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  function handleSort(col: SortKey) {
    if (sortKey === col) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(col)
      setSortDir('asc')
    }
    setPage(0)
  }

  if (rows.length === 0) return null

  return (
    <div className={cn('rounded-lg border border-border bg-card overflow-hidden', className)}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/80">
          Call Detail Records
        </span>
        <span className="text-xs font-medium text-foreground/60 font-mono">
          {sorted.length} {sorted.length === 1 ? 'call' : 'calls'}
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-secondary/30">
              <Th>#</Th>
              <Th>UAC Ext</Th>
              <Th>UAS Ext</Th>
              <Th
                sortable
                onClick={() => handleSort('result')}
                icon={<SortIcon col="result" sortKey={sortKey} dir={sortDir} />}
              >
                Result
              </Th>
              <Th
                sortable
                onClick={() => handleSort('pdd_ms')}
                icon={<SortIcon col="pdd_ms" sortKey={sortKey} dir={sortDir} />}
              >
                PDD ms
              </Th>
              <Th>Hold ms</Th>
              <Th>UAC Media</Th>
              <Th>UAS Media</Th>
              <Th>Correlated</Th>
              <Th>Leg A / Leg B</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {slice.map((row, i) => {
              const rowNum = page * PAGE_SIZE + i + 1
              const uacM = mediaBadge(row.uacMedia)
              const uasM = mediaBadge(row.uasMedia)
              const corr = CORRELATION_BADGE[row.correlationMethod] ?? CORRELATION_BADGE.unmatched
              return (
                <tr
                  key={row.spineId || i}
                  className="border-b border-border/50 hover:bg-secondary/20 transition-colors"
                >
                  <Td mono muted>
                    {rowNum}
                  </Td>
                  <Td mono>{row.uacExt}</Td>
                  <Td mono>{row.uasExt}</Td>
                  <Td>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs font-bold',
                        row.result === 'COMPLETED'
                          ? 'bg-emerald-400/10 text-emerald-400'
                          : 'bg-rose-500/10 text-rose-500'
                      )}
                    >
                      {row.result}
                    </span>
                  </Td>
                  <Td mono>{row.pdd_ms > 0 ? row.pdd_ms.toFixed(1) : '—'}</Td>
                  <Td mono>{row.hold_ms > 0 ? row.hold_ms.toLocaleString() : '—'}</Td>
                  <Td>
                    <span className={cn('font-mono text-xs', uacM.cls)}>{uacM.label}</span>
                  </Td>
                  <Td>
                    <span className={cn('font-mono text-xs', uasM.cls)}>{uasM.label}</span>
                  </Td>
                  <Td>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                        corr.cls
                      )}
                    >
                      {corr.label}
                    </span>
                  </Td>
                  <Td mono muted>
                    <span title={row.legACallId}>{truncateCallId(row.legACallId)}</span>
                    {' / '}
                    <span title={row.legBCallId}>{truncateCallId(row.legBCallId)}</span>
                  </Td>
                  <Td mono muted>
                    {row.failureReason ?? '—'}
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5">
          <span className="text-xs font-medium text-foreground/60 font-mono">
            Page {page + 1} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              className="rounded px-2 py-1 text-xs text-foreground border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Prev
            </button>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded px-2 py-1 text-xs text-foreground border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Th({
  children,
  sortable,
  onClick,
  icon,
}: {
  children: React.ReactNode
  sortable?: boolean
  onClick?: () => void
  icon?: React.ReactNode
}) {
  return (
    <th
      className={cn(
        'px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-widest text-foreground/70 whitespace-nowrap',
        sortable && 'cursor-pointer hover:text-foreground transition-colors select-none'
      )}
      onClick={onClick}
    >
      <div className="flex items-center gap-1">
        {children}
        {icon}
      </div>
    </th>
  )
}

function Td({
  children,
  mono,
  muted,
}: {
  children: React.ReactNode
  mono?: boolean
  muted?: boolean
}) {
  return (
    <td
      className={cn(
        'px-3 py-2 whitespace-nowrap text-sm',
        mono && 'font-mono',
        muted ? 'text-foreground/55' : 'text-foreground/85'
      )}
    >
      {children}
    </td>
  )
}
