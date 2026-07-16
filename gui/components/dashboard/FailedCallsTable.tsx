'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, XCircle, ChevronLeft, ChevronRight as ChevronRightIcon, Copy, Check } from 'lucide-react'
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

function formatAddrTruncated(ip?: string, port?: number, maxLen = 21): string {
  if (!ip) return ''
  const full = port ? `${ip}:${port}` : ip
  if (full.length <= maxLen) return full
  return full.slice(0, maxLen - 3) + '...'
}

function formatAddrFull(ip?: string, port?: number): string {
  if (!ip) return ''
  return port ? `${ip}:${port}` : ip
}

function formatController(host?: string, port?: number): string {
  return formatAddrFull(host, port) || '—'
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
  const [copied, setCopied]   = useState(false)

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

  const hasReportedButEmpty =
    failed.length === 0 &&
    typeof reportedFailedCount === 'number' &&
    reportedFailedCount > 0

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

  const handleCopyAll = async () => {
    const records = filtered.map((ev) => ({
      call_id: ev.call_id ?? '',
      uac_ext: ev.uac_ext ?? ev.ext ?? '',
      uac_ip: formatAddrFull(ev.sip_local_ip, ev.sip_local_port),
      uac_controller: formatController(ev.uac_controller_host, ev.uac_controller_port),
      uac_agent_group_id: ev.uac_agent_group_id ?? ev.agent_group_id ?? '',
      uac_zone_id: ev.uac_zone_id ?? '',
      uas_ext: ev.uas_ext ?? ev.peer_ext ?? '',
      uas_ip: formatAddrFull(ev.sip_remote_ip, ev.sip_remote_port),
      uas_controller: formatController(ev.uas_controller_host, ev.uas_controller_port),
      uas_agent_group_id: ev.uas_agent_group_id ?? '',
      uas_zone_id: ev.uas_zone_id ?? '',
      failure_controller_role: ev.failure_controller_role ?? '',
      failure_controller: formatController(ev.failure_controller_host, ev.failure_controller_port),
      sip_code: ev.sip_code ?? 0,
      failure_reason: ev.failure_reason ?? '',
      server_header: ev.sip_server_header ?? '',
      user_agent_header: ev.sip_user_agent_header ?? '',
      timestamp: ev.ts_utc ?? ev.timestamp ?? '',
    }))
    try {
      await navigator.clipboard.writeText(JSON.stringify(records, null, 2))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch { /* clipboard unavailable */ }
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
                  <button
                    type="button"
                    onClick={handleCopyAll}
                    className={cn(
                      'flex items-center gap-1 rounded border px-2 py-1 text-xs transition-colors',
                      copied
                        ? 'border-emerald-600 text-emerald-400'
                        : 'border-slate-700 text-slate-300 hover:bg-slate-800',
                    )}
                    title="Copy all filtered failed call records as JSON"
                  >
                    {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                    {copied ? 'Copied!' : 'Copy All'}
                  </button>
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
                      <th className="px-4 py-2 text-left">Call ID</th>
                      <th className="px-4 py-2 text-left">UAC# / IP:Port</th>
                      <th className="px-4 py-2 text-left">UAC Controller</th>
                      <th className="px-4 py-2 text-left">UAS# / IP:Port</th>
                      <th className="px-4 py-2 text-left">UAS Controller</th>
                      <th className="px-4 py-2 text-left">Failure Controller</th>
                      <th className="px-4 py-2 text-left">Error Code / Reason</th>
                      <th className="px-4 py-2 text-left">Server Header</th>
                      <th className="px-4 py-2 text-left">User-Agent Header</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((ev, i) => {
                      const uacExt = ev.uac_ext ?? ev.ext ?? '—'
                      const uacAddr = formatAddrFull(ev.sip_local_ip, ev.sip_local_port)
                      const uacAddrShort = formatAddrTruncated(ev.sip_local_ip, ev.sip_local_port)
                      const uacController = formatController(ev.uac_controller_host, ev.uac_controller_port)
                      const uasExt = ev.uas_ext ?? ev.peer_ext ?? '—'
                      const uasAddr = formatAddrFull(ev.sip_remote_ip, ev.sip_remote_port)
                      const uasAddrShort = formatAddrTruncated(ev.sip_remote_ip, ev.sip_remote_port)
                      const uasController = formatController(ev.uas_controller_host, ev.uas_controller_port)
                      const failureController = formatController(ev.failure_controller_host, ev.failure_controller_port)
                      const sipCode = ev.sip_code ? String(ev.sip_code) : ''
                      const reason = ev.failure_reason ?? 'Unknown'
                      const errorDisplay = sipCode ? `${sipCode} / ${reason}` : reason
                      return (
                        <tr
                          key={ev.call_id ?? i}
                          className="border-b border-slate-700/30 hover:bg-rose-500/5 transition-colors"
                        >
                          <td className="px-4 py-2 font-mono text-slate-300 break-all min-w-[180px]">
                            {ev.call_id || '—'}
                          </td>
                          <td className="px-4 py-2 min-w-[130px]">
                            <span className="font-mono text-amber-300">{uacExt}</span>
                            {uacAddr && (
                              <span className="block text-[10px] text-sky-400/70 font-mono" title={uacAddr}>
                                {uacAddrShort}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 min-w-[145px]">
                            <span className="font-mono text-sky-300" title={uacController}>{uacController}</span>
                            {(ev.uac_agent_group_id || ev.uac_zone_id) && (
                              <span className="block text-[10px] text-slate-500">
                                {[ev.uac_zone_id, ev.uac_agent_group_id].filter(Boolean).join(' / ')}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 min-w-[130px]">
                            <span className="font-mono text-amber-300">{uasExt}</span>
                            {uasAddr && (
                              <span className="block text-[10px] text-sky-400/70 font-mono" title={uasAddr}>
                                {uasAddrShort}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 min-w-[145px]">
                            <span className="font-mono text-sky-300" title={uasController}>{uasController}</span>
                            {(ev.uas_agent_group_id || ev.uas_zone_id) && (
                              <span className="block text-[10px] text-slate-500">
                                {[ev.uas_zone_id, ev.uas_agent_group_id].filter(Boolean).join(' / ')}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 min-w-[145px]">
                            <span className="font-mono text-rose-300" title={failureController}>{failureController}</span>
                            {ev.failure_controller_role && (
                              <span className="block text-[10px] uppercase tracking-wide text-rose-400/70">
                                {ev.failure_controller_role}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2 text-rose-300 min-w-[180px]">
                            {errorDisplay}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-slate-300 min-w-[180px] break-all">
                            {ev.sip_server_header || '—'}
                          </td>
                          <td className="px-4 py-2 font-mono text-[11px] text-slate-300 min-w-[180px] break-all">
                            {ev.sip_user_agent_header || '—'}
                          </td>
                        </tr>
                      )
                    })}
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
