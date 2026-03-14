'use client'

import { useState, useMemo } from 'react'
import { ChevronUp, ChevronDown, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'
import type { CallEvent } from '@/types'

type SortKey = 'result' | 'pdd_ms' | null
type SortDir = 'asc' | 'desc'

const PAGE_SIZE = 20

const MEDIA_BADGE: Record<CallEvent['media_status'], { label: string; cls: string }> = {
  MEDIA_VERIFIED: { label: 'MEDIA_VERIFIED ✅', cls: 'text-emerald-400' },
  MEDIA_PARTIAL: { label: 'MEDIA_PARTIAL 🟡', cls: 'text-amber-400' },
  MEDIA_FAILED: { label: 'MEDIA_FAILED 🔴', cls: 'text-rose-500' },
  NO_MEDIA: { label: 'NO_MEDIA —', cls: 'text-muted-foreground' },
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
  const callEvents = useTrafficStore((s) => s.callEvents)
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const [page, setPage] = useState(0)

  const sorted = useMemo(() => {
    if (!sortKey) return callEvents
    return [...callEvents].sort((a, b) => {
      const mul = sortDir === 'asc' ? 1 : -1
      if (sortKey === 'result') {
        return mul * a.result.localeCompare(b.result)
      }
      if (sortKey === 'pdd_ms') {
        return mul * (a.pdd_ms - b.pdd_ms)
      }
      return 0
    })
  }, [callEvents, sortKey, sortDir])

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

  if (callEvents.length === 0) return null

  return (
    <div className={cn('rounded-lg border border-border bg-card overflow-hidden', className)}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <span className="text-xs font-semibold uppercase tracking-widest text-foreground/80">
          Call Detail Records
        </span>
        <span className="text-xs font-medium text-foreground/60 font-mono">
          {sorted.length} calls
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
              <Th>Media</Th>
              <Th>Reason</Th>
            </tr>
          </thead>
          <tbody>
            {slice.map((ev, i) => {
              const rowNum = page * PAGE_SIZE + i + 1
              const media = MEDIA_BADGE[ev.media_status]
              return (
                <tr
                  key={ev.call_id}
                  className="border-b border-border/50 hover:bg-secondary/20 transition-colors"
                >
                  <Td mono muted>
                    {rowNum}
                  </Td>
                  <Td mono>{ev.uac_ext}</Td>
                  <Td mono>{ev.uas_ext}</Td>
                  <Td>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs font-bold',
                        ev.result === 'COMPLETED'
                          ? 'bg-emerald-400/10 text-emerald-400'
                          : 'bg-rose-500/10 text-rose-500'
                      )}
                    >
                      {ev.result}
                    </span>
                  </Td>
                  <Td mono>{ev.pdd_ms}</Td>
                  <Td mono>{ev.hold_ms > 0 ? ev.hold_ms.toLocaleString() : '—'}</Td>
                  <Td>
                    <span className={cn('font-mono text-xs', media.cls)}>
                      {media.label}
                    </span>
                  </Td>
                  <Td mono muted>
                    {ev.failure_reason ?? '—'}
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
              ← Prev
            </button>
            <button
              type="button"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              className="rounded px-2 py-1 text-xs text-foreground border border-border hover:bg-secondary disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Next →
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
