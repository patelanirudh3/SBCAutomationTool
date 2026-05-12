'use client'

import { useState } from 'react'
import { ChevronDown, ChevronRight, XCircle, ChevronLeft, ChevronRight as ChevronRightIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CallEvent } from '@/types'

const PAGE_SIZE = 10

interface FailedCallsTableProps {
  events: CallEvent[]
  /** Optional engine-reported failure count. When provided AND larger than
   *  the per-call records list, the table renders an explanatory
   *  placeholder so the operator can see the discrepancy instead of the
   *  misleading "No failed calls" message. */
  reportedFailedCount?: number
}

export function FailedCallsTable({ events, reportedFailedCount }: FailedCallsTableProps) {
  // Filter to UAC-only so each call session shows up once (the events list
  // contains both UAC and UAS legs from /api/calls — kept for spine
  // correlation, but the failure UI counts sessions, not legs).
  const failed = events.filter((e) => e.direction !== 'uas' && e.result === 'FAILED')
  const [open, setOpen]       = useState(false)
  const [page, setPage]       = useState(1)

  const totalPages = Math.max(1, Math.ceil(failed.length / PAGE_SIZE))
  const pageItems  = failed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  // Discrepancy detector: engine counters say there were failures but the
  // per-call records list is empty. Most often happens when the engine
  // exits before flushing call records (e.g. abrupt shutdown).
  const hasReportedButEmpty =
    failed.length === 0 &&
    typeof reportedFailedCount === 'number' &&
    reportedFailedCount > 0

  // Auto-expand when failures appear OR when the discrepancy hint applies
  const autoExpand = (failed.length > 0 || hasReportedButEmpty) && !open

  // The header pill prefers the engine-reported count when records are
  // missing so the badge stays consistent with the AggregatePanel.
  const headerCount = failed.length > 0 ? failed.length : (reportedFailedCount ?? 0)

  return (
    <div className={cn(
      'rounded-xl border transition-colors',
      headerCount > 0 ? 'border-rose-500/30 bg-rose-950/10' : 'border-border bg-card',
    )}>

      {/* Header / toggle */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
      >
        <XCircle className={cn('size-4 shrink-0', headerCount > 0 ? 'text-rose-400' : 'text-muted-foreground')} />
        <span className={cn(
          'font-semibold text-sm',
          headerCount > 0 ? 'text-rose-300' : 'text-muted-foreground',
        )}>
          Failed Calls
        </span>
        {headerCount > 0 && (
          <span className="ml-1 rounded-full bg-rose-500/20 px-2 py-0.5 text-[11px] font-bold text-rose-400">
            {headerCount.toLocaleString()}
          </span>
        )}
        <span className="ml-auto">
          {open || autoExpand
            ? <ChevronDown className="size-4 text-slate-400" />
            : <ChevronRight className="size-4 text-slate-400" />}
        </span>
      </button>

      {/* Table body */}
      {(open || autoExpand) && (
        <div className="border-t border-rose-500/20">
          {failed.length === 0 ? (
            hasReportedButEmpty ? (
              <p className="px-4 py-6 text-center text-sm text-amber-300">
                {reportedFailedCount!.toLocaleString()} failed calls reported by
                the engine, but per-call records are unavailable. The engine
                likely exited before flushing call records — check engine logs
                for details.
              </p>
            ) : (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                No failed calls.
              </p>
            )
          ) : (
            <>
              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/50 text-[10px] uppercase tracking-widest text-slate-400">
                      <th className="px-4 py-2 text-left">Extension</th>
                      <th className="px-4 py-2 text-left">Call ID</th>
                      <th className="px-4 py-2 text-left">Time (UTC)</th>
                      <th className="px-4 py-2 text-left">Failure Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((ev, i) => (
                      <tr
                        key={ev.call_id ?? i}
                        className="border-b border-slate-700/30 hover:bg-rose-500/5 transition-colors"
                      >
                        <td className="px-4 py-2 font-mono text-amber-300">
                          {ev.uac_ext ?? ev.ext ?? '—'}
                        </td>
                        <td className="px-4 py-2 font-mono text-slate-300 truncate max-w-[160px]" title={ev.call_id}>
                          {ev.call_id ? ev.call_id.slice(0, 20) + (ev.call_id.length > 20 ? '…' : '') : '—'}
                        </td>
                        <td className="px-4 py-2 text-slate-400">
                          {ev.ts_utc
                            ? new Date(ev.ts_utc).toLocaleTimeString('en-GB', { hour12: false })
                            : ev.timestamp
                              ? new Date(ev.timestamp).toLocaleTimeString('en-GB', { hour12: false })
                              : '—'}
                        </td>
                        <td className="px-4 py-2 text-rose-300 max-w-[240px] truncate" title={ev.failure_reason}>
                          {ev.failure_reason ?? 'Unknown'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-slate-700/30 px-4 py-2">
                  <span className="text-[11px] text-slate-400">
                    {((page - 1) * PAGE_SIZE) + 1}–{Math.min(page * PAGE_SIZE, failed.length)} of {failed.length.toLocaleString()} records
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={page === 1}
                      className="rounded p-1 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <span className="min-w-[60px] text-center text-[11px] font-mono text-slate-300">
                      {page} / {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={page === totalPages}
                      className="rounded p-1 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronRightIcon className="size-4" />
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
