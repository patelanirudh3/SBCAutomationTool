'use client'

import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Users,
  AlertTriangle,
  Copy,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTrafficStore } from '@/store/traffic'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtElapsed(sec: number): string {
  if (sec < 60) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface UnregisterProgressCardProps {
  /** True while the start-cleanup POST is in flight (before the engine
   *  flips its phase to CLEANING_UP). Renders an indeterminate spinner. */
  starting?: boolean
  /** Disabled when a Re-Run navigation is in flight. */
  disabled?: boolean
  /** Called when the user clicks Unregister (CLEANUP_READY phase). */
  onUnregister?: () => void
  /** Called when the user clicks "Retry failed (n)" — passes the failed list. */
  onRetryFailed?: (extensions: string[]) => void
}

// ---------------------------------------------------------------------------
// UnregisterProgressCard
// ---------------------------------------------------------------------------

export function UnregisterProgressCard({
  starting = false,
  disabled = false,
  onUnregister,
  onRetryFailed,
}: UnregisterProgressCardProps) {
  const phase = useTrafficStore((s) => s.phase)
  const cleanupStatus = useTrafficStore((s) => s.cleanupStatus)
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)
  const pair = pairs[activePairIndex]
  const extCount = pair ? (pair.uac.ext_end - pair.uac.ext_start + 1) : 0

  const total = cleanupStatus?.total || extCount
  const count = cleanupStatus?.count ?? 0
  const failed = cleanupStatus?.failed_extensions ?? []
  const pct = total > 0 ? Math.min(100, Math.round((count / total) * 100)) : 0
  const remaining = Math.max(0, total - count)

  // ── Live unreg-rate (mirrors the reg/s tile in PrePhasePanel) ──
  const [rate, setRate] = useState<number | null>(null)
  const prevCountRef = useRef(0)
  const prevTsRef = useRef<number | null>(null)

  useEffect(() => {
    if (phase !== 'CLEANING_UP') {
      prevTsRef.current = null
      return
    }
    const now = Date.now()
    if (prevTsRef.current == null) {
      prevTsRef.current = now
      prevCountRef.current = count
      return
    }
    const dt = (now - prevTsRef.current) / 1000
    if (dt > 0.4 && count > prevCountRef.current) {
      setRate(Math.max(1, Math.round((count - prevCountRef.current) / dt)))
      prevCountRef.current = count
      prevTsRef.current = now
    }
  }, [count, phase])

  // ── Failed-list expand/collapse + copy ──
  const [showFailed, setShowFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const handleCopy = async () => {
    try {
      const unregisterFailed = cleanupStatus?.unregister_failed_extensions ?? failed
      const unsubscribeFailed = cleanupStatus?.unsubscribe_failed_extensions ?? []
      await navigator.clipboard.writeText([
        ...unregisterFailed.map((ext) => `unregister: ${ext}`),
        ...unsubscribeFailed.map((ext) => `unsubscribe: ${ext}`),
      ].join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable */ }
  }

  // ── State machine ──
  // CLEANUP_READY → idle (button)
  // CLEANING_UP   → progress bar + counts + rate + ETA
  // COMPLETE/DONE → result strip (clean | partial | total failure)
  const isIdle    = phase === 'CLEANUP_READY' && !starting
  const isRunning = phase === 'CLEANING_UP' || starting
  const isDone    = (phase === 'COMPLETE' || phase === 'FAILED') && (cleanupStatus?.total ?? 0) > 0

  // ───────────────────────────────────────────────────────────────────
  // Render — IDLE (button)
  // ───────────────────────────────────────────────────────────────────
  if (isIdle) {
    return (
      <button
        type="button"
        onClick={onUnregister}
        disabled={disabled}
        className={cn(
          'flex items-center gap-1.5 rounded-lg border px-4 py-2 text-sm font-semibold transition-colors',
          'border-sky-500/40 bg-sky-500/10 text-sky-300',
          'hover:bg-sky-500/20 hover:text-sky-200',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <Users className="size-4" />
        Unregister / Unsubscribe
      </button>
    )
  }

  // ───────────────────────────────────────────────────────────────────
  // Render — RUNNING (progress card)
  // ───────────────────────────────────────────────────────────────────
  if (isRunning) {
    const eta = rate && rate > 0 ? Math.ceil(remaining / rate) : null
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-amber-400" />
            <span className="text-sm font-semibold text-amber-200">
              {starting ? 'Starting unregister…' : 'Unregistering extensions…'}
            </span>
          </div>
          <span className="font-mono text-xs text-amber-300/80 tabular-nums">
            {count.toLocaleString()} / {total.toLocaleString()}
          </span>
        </div>

        {/* Progress bar */}
        <div className="relative h-2 w-full overflow-hidden rounded-full bg-slate-700/60">
          <div
            className="h-full rounded-full bg-amber-500 transition-all duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Rate / ETA / failed */}
        <div className="flex items-center justify-between text-[11px] font-mono text-amber-300/80 tabular-nums">
          <span>{pct}%</span>
          <div className="flex items-center gap-3">
            {rate != null && rate > 0 && <span>~{rate} unreg/s</span>}
            {eta != null && eta > 0 && <span>~{eta}s left</span>}
            {failed.length > 0 && (
              <span className="text-rose-400">{failed.length} failed</span>
            )}
          </div>
        </div>
      </motion.div>
    )
  }

  // ───────────────────────────────────────────────────────────────────
  // Render — DONE (result strip)
  // ───────────────────────────────────────────────────────────────────
  if (isDone) {
    const unregisterFailed = cleanupStatus?.unregister_failed_extensions ?? failed
    const unregisterCount = cleanupStatus?.unregister_count ?? count
    const unsubscribeFailed = cleanupStatus?.unsubscribe_failed_extensions ?? []
    const unsubscribeByEvent = cleanupStatus?.unsubscribe_by_event
    const eventUnsubscribeTotal = unsubscribeByEvent
      ? Object.values(unsubscribeByEvent).reduce((sum, stats) => sum + (stats.total ?? 0), 0)
      : 0
    const eventUnsubscribeOk = unsubscribeByEvent
      ? Object.values(unsubscribeByEvent).reduce((sum, stats) => sum + (stats.successful ?? 0), 0)
      : 0
    const eventUnsubscribeFailed = unsubscribeByEvent
      ? Object.values(unsubscribeByEvent).reduce((sum, stats) => sum + (stats.failed ?? 0), 0)
      : 0
    const unsubscribeCount = eventUnsubscribeTotal || cleanupStatus?.unsubscribe_count || 0
    const unsubscribeSkipped = cleanupStatus?.unsubscribe_skipped ?? 0
    const unregisterOk = Math.max(0, unregisterCount - unregisterFailed.length)
    const unsubscribeOk = eventUnsubscribeTotal > 0 ? eventUnsubscribeOk : Math.max(0, unsubscribeCount - unsubscribeFailed.length)
    const unsubscribeFailedCount = eventUnsubscribeTotal > 0 ? eventUnsubscribeFailed : unsubscribeFailed.length
    const allUnregistered = unregisterFailed.length === 0 && unregisterCount >= total && total > 0
    const hasUnsubscribeWork = unsubscribeCount > 0 || unsubscribeSkipped > 0 || unsubscribeFailedCount > 0
    const allClean = allUnregistered && unsubscribeFailedCount === 0
    const totalFailed = unregisterFailed.length === total
    const elapsedLabel = cleanupStatus?.elapsed_seconds != null
      ? ` (${fmtElapsed(cleanupStatus.elapsed_seconds)})`
      : ''

    if (allClean) {
      return (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-400">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="size-3.5" />
            Unregistered {unregisterOk.toLocaleString()} / {total.toLocaleString()}{elapsedLabel}
          </div>
          {hasUnsubscribeWork && (
            <div className="mt-1 font-mono text-[11px] text-emerald-300/80">
              {unsubscribeSkipped > 0
                ? `Unsubscribe skipped ${unsubscribeSkipped.toLocaleString()} / ${total.toLocaleString()} (not enabled)`
                : `Unsubscribed ${unsubscribeOk.toLocaleString()} / ${Math.max(unsubscribeCount, total).toLocaleString()}`}
            </div>
          )}
        </div>
      )
    }

    if (totalFailed) {
      return (
        <div className="w-full max-w-md rounded-xl border border-rose-500/30 bg-rose-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <XCircle className="size-4 text-rose-400" />
            <span className="text-sm font-semibold text-rose-300">
              Unregister failed for all {total} extensions
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            The SBC may be unreachable. Inspect the engine logs and retry,
            or use the Re-Run button to start over with fresh registrations.
          </p>
          {onRetryFailed && (
            <button
              type="button"
              onClick={() => onRetryFailed(unregisterFailed)}
              disabled={disabled}
              className={cn(
                'mt-1 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold',
                'border-rose-500/40 bg-rose-500/10 text-rose-300',
                'hover:bg-rose-500/20 hover:text-rose-200 transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              Retry all ({unregisterFailed.length})
            </button>
          )}
        </div>
      )
    }

    // Partial failure
    return (
      <motion.div
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-400" />
            <span className="text-sm font-semibold text-amber-200">
              Unregistered {unregisterOk} / {total}
              {elapsedLabel}
            </span>
          </div>
          {unregisterFailed.length > 0 && (
            <span className="font-mono text-xs text-rose-400 tabular-nums">
              {unregisterFailed.length} unregister failed
            </span>
          )}
        </div>

        {hasUnsubscribeWork && (
          <div className="rounded-md border border-amber-500/20 bg-slate-900/30 px-2.5 py-2 font-mono text-[11px] text-amber-100/90">
            <div>Unsubscribed {unsubscribeOk.toLocaleString()} / {Math.max(unsubscribeCount, total).toLocaleString()}</div>
            {unsubscribeSkipped > 0 && (
              <div>Unsubscribe skipped {unsubscribeSkipped.toLocaleString()} / {total.toLocaleString()} (not enabled)</div>
            )}
            {unsubscribeFailedCount > 0 && (
              <div className="text-rose-300">Unsubscribe failed {unsubscribeFailedCount.toLocaleString()} / {Math.max(unsubscribeCount, total).toLocaleString()}</div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {(unregisterFailed.length > 0 || unsubscribeFailedCount > 0) && (
            <button
              type="button"
              onClick={() => setShowFailed((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-semibold text-amber-300 hover:bg-amber-500/20"
            >
              {showFailed ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              {showFailed ? 'Hide' : 'Show'} failed extensions ({unregisterFailed.length + unsubscribeFailedCount})
            </button>
          )}
          {onRetryFailed && unregisterFailed.length > 0 && (
            <button
              type="button"
              onClick={() => onRetryFailed(unregisterFailed)}
              disabled={disabled}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-semibold',
                'border-amber-500/40 bg-amber-500/10 text-amber-200',
                'hover:bg-amber-500/20 transition-colors',
                'disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              Retry unregister failed ({unregisterFailed.length})
            </button>
          )}
        </div>

        {showFailed && (
          <div className="space-y-2">
            <div className="max-h-40 overflow-y-auto rounded-md border border-amber-500/20 bg-slate-900/40 p-2 font-mono text-[11px] text-amber-100/90">
              {unregisterFailed.map((ext) => (
                <div key={`unreg-${ext}`}>unregister: {ext}</div>
              ))}
              {unsubscribeFailed.map((ext) => (
                <div key={`unsub-${ext}`}>unsubscribe: {ext}</div>
              ))}
            </div>
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              <Copy className="size-3" />
              {copied ? 'Copied!' : 'Copy list'}
            </button>
          </div>
        )}
      </motion.div>
    )
  }

  return null
}
