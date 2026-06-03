'use client'

import { useMemo, useState } from 'react'
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
  const failed = useMemo(
    () => events.filter((e) => e.direction !== 'uas' && e.result === 'FAILED'),
    [events],
  )
  const [open, setOpen]       = useState(false)
  const [page, setPage]       = useState(1)
  const [sipCodeFilter, setSipCodeFilter] = useState('all')
  const [extensionFilter, setExtensionFilter] = useState('')
  const [peerFilter, setPeerFilter] = useState('')
  const [reasonFilter, setReasonFilter] = useState('')
  const [callIdFilter, setCallIdFilter] = useState('')
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')

  const filtered = useMemo(() => {
    const extQ = extensionFilter.trim().toLowerCase()
    const peerQ = peerFilter.trim().toLowerCase()
    const reasonQ = reasonFilter.trim().toLowerCase()
    const callQ = callIdFilter.trim().toLowerCase()
    const out = failed.filter((ev) => {
      const sipCode = String(ev.sip_code ?? '')
      const ext = String(ev.uac_ext ?? ev.ext ?? '').toLowerCase()
      const peer = String(ev.peer_ext ?? ev.uas_ext ?? '').toLowerCase()
      const reason = String(ev.failure_reason ?? '').toLowerCase()
      const callId = String(ev.call_id ?? '').toLowerCase()
      if (sipCodeFilter !== 'all') {
        if (sipCodeFilter === '4xx' && !sipCode.startsWith('4')) return false
        else if (sipCodeFilter === '5xx' && !sipCode.startsWith('5')) return false
        else if (sipCodeFilter === 'timeout' && !reason.includes('timeout')) return false
        else if (!['4xx', '5xx', 'timeout'].includes(sipCodeFilter) && sipCode !== sipCodeFilter) return false
      }
      return (!extQ || ext.includes(extQ)) &&
        (!peerQ || peer.includes(peerQ)) &&
        (!reasonQ || reason.includes(reasonQ)) &&
        (!callQ || callId.includes(callQ))
    })
    out.sort((a, b) => {
      const ta = new Date(a.ts_utc ?? a.timestamp ?? 0).getTime()
      const tb = new Date(b.ts_utc ?? b.timestamp ?? 0).getTime()
      return sortDir === 'desc' ? tb - ta : ta - tb
    })
    return out
  }, [failed, extensionFilter, peerFilter, reasonFilter, callIdFilter, sipCodeFilter, sortDir])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const pageItems  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)

  // Discrepancy detector: engine counters say there were failures but the
  // per-call records list is empty. Most often happens when the engine
  // exits before flushing call records (e.g. abrupt shutdown).
  const hasReportedButEmpty =
    failed.length === 0 &&
    typeof reportedFailedCount === 'number' &&
    reportedFailedCount > 0

  // The header pill prefers the engine-reported count when records are
  // missing so the badge stays consistent with the AggregatePanel.
  const headerCount = failed.length > 0 ? failed.length : (reportedFailedCount ?? 0)
  const hasActiveFilters =
    sipCodeFilter !== 'all' ||
    extensionFilter.trim() !== '' ||
    peerFilter.trim() !== '' ||
    reasonFilter.trim() !== '' ||
    callIdFilter.trim() !== ''

  const resetFilters = () => {
    setSipCodeFilter('all')
    setExtensionFilter('')
    setPeerFilter('')
    setReasonFilter('')
    setCallIdFilter('')
    setPage(1)
  }

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
          {open
            ? <ChevronDown className="size-4 text-slate-400" />
            : <ChevronRight className="size-4 text-slate-400" />}
        </span>
      </button>

      {/* Table body */}
      {open && (
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
              <div className="space-y-3 border-b border-slate-700/30 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={sipCodeFilter}
                    onChange={(e) => { setSipCodeFilter(e.target.value); setPage(1) }}
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                  >
                    <option value="all">All SIP codes</option>
                    <option value="500">500</option>
                    <option value="503">503</option>
                    <option value="4xx">All 4xx</option>
                    <option value="5xx">All 5xx</option>
                    <option value="timeout">Timeouts</option>
                  </select>
                  <select
                    value={sortDir}
                    onChange={(e) => { setSortDir(e.target.value as 'desc' | 'asc'); setPage(1) }}
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
                  >
                    <option value="desc">Latest first</option>
                    <option value="asc">Oldest first</option>
                  </select>
                  {hasActiveFilters && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="rounded border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
                    >
                      Clear filters
                    </button>
                  )}
                  <span className="ml-auto text-[11px] text-slate-400">
                    Showing {filtered.length.toLocaleString()} of {failed.length.toLocaleString()} failed calls
                  </span>
                </div>
                <div className="grid gap-2 sm:grid-cols-4">
                  <input
                    value={extensionFilter}
                    onChange={(e) => { setExtensionFilter(e.target.value); setPage(1) }}
                    placeholder="Extension e.g. 6000041"
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500"
                  />
                  <input
                    value={peerFilter}
                    onChange={(e) => { setPeerFilter(e.target.value); setPage(1) }}
                    placeholder="Peer e.g. 6000042"
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500"
                  />
                  <input
                    value={reasonFilter}
                    onChange={(e) => { setReasonFilter(e.target.value); setPage(1) }}
                    placeholder="Reason contains..."
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500"
                  />
                  <input
                    value={callIdFilter}
                    onChange={(e) => { setCallIdFilter(e.target.value); setPage(1) }}
                    placeholder="Call-ID contains..."
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500"
                  />
                </div>
              </div>

              {/* Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-slate-700/50 text-[10px] uppercase tracking-widest text-slate-400">
                      <th className="px-4 py-2 text-left">Extension</th>
                      <th className="px-4 py-2 text-left">VIP</th>
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
                        <td className="px-4 py-2 font-mono text-sky-300">
                          {ev.sip_local_ip
                            ? `${ev.sip_local_ip}${ev.sip_local_port ? `:${ev.sip_local_port}` : ''}`
                            : '—'}
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
              {filtered.length === 0 ? (
                <p className="border-t border-slate-700/30 px-4 py-6 text-center text-sm text-slate-400">
                  No failed calls match the current filters.
                </p>
              ) : totalPages > 1 && (
                <div className="flex items-center justify-between border-t border-slate-700/30 px-4 py-2">
                  <span className="text-[11px] text-slate-400">
                    {((safePage - 1) * PAGE_SIZE) + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length.toLocaleString()} records
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      disabled={safePage === 1}
                      className="rounded p-1 text-slate-400 hover:text-slate-200 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <ChevronLeft className="size-4" />
                    </button>
                    <span className="min-w-[60px] text-center text-[11px] font-mono text-slate-300">
                      {safePage} / {totalPages}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                      disabled={safePage === totalPages}
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
