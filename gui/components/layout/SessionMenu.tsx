'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Server, Power, RotateCcw, RefreshCw, Loader2 } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTrafficStore } from '@/store/traffic'
import { resetTestFor, shutdownFor } from '@/lib/api'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface VMBackendInfo {
  ip: string
  port: number
  role: string
  vm_id: string
  reachable: boolean
  state: string
  loading: boolean
}

interface PairInfo {
  pairLabel: string
  pairId: string
  uac: VMBackendInfo
}

// ---------------------------------------------------------------------------
// Visual maps
// ---------------------------------------------------------------------------

const STATE_DOT: Record<string, string> = {
  IDLE:       'bg-zinc-500',
  CONFIGURED: 'bg-blue-400',
  RUNNING:    'bg-amber-400',
  COMPLETE:   'bg-emerald-400',
  FAILED:     'bg-rose-400',
  CLI:        'bg-cyan-400',
  offline:    'bg-rose-900',
}

const STATE_TEXT: Record<string, string> = {
  IDLE:       'text-zinc-400',
  CONFIGURED: 'text-blue-400',
  RUNNING:    'text-amber-400',
  COMPLETE:   'text-emerald-400',
  FAILED:     'text-rose-400',
  CLI:        'text-cyan-400',
  offline:    'text-rose-400/70',
}

// ---------------------------------------------------------------------------
// Single VM row (inside a pair block)
// ---------------------------------------------------------------------------

function VMRow({
  vm,
  onReset,
  onShutdown,
}: {
  vm: VMBackendInfo
  onReset: () => void
  onShutdown: () => void
}) {
  const canReset =
    vm.reachable && ['COMPLETE', 'FAILED', 'CONFIGURED'].includes(vm.state)
  const canShutdown = vm.reachable

  return (
    <div className="group flex items-center gap-3 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/5">
      {/* State dot */}
      <span className="relative flex size-2 shrink-0">
        {vm.state === 'RUNNING' && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping',
              STATE_DOT[vm.state],
            )}
          />
        )}
        <span
          className={cn(
            'relative inline-flex size-2 rounded-full',
            STATE_DOT[vm.state] ?? 'bg-zinc-700',
          )}
        />
      </span>

      {/* Role badge + vm_id + ip:port */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className="rounded px-1.5 py-px text-[9px] font-bold leading-none tracking-widest bg-emerald-500/20 text-emerald-300"
          >
            {vm.role}
          </span>
          <span className="truncate text-xs font-semibold text-slate-200">
            {vm.vm_id}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="font-mono text-[10px] font-medium text-cyan-400/80">
            {vm.ip}:{vm.port}
          </span>
          <span className={cn('text-[10px] font-semibold', STATE_TEXT[vm.state] ?? STATE_TEXT.offline)}>
            {vm.state}
          </span>
        </div>
      </div>

      {/* Per-VM actions — always visible, grayed when disabled */}
      <div className="flex shrink-0 items-center gap-0.5">
        {vm.loading ? (
          <Loader2 className="size-3 animate-spin text-foreground/40 mx-1" />
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onReset}
                  disabled={!canReset}
                  className={cn(
                    'rounded-md p-1 transition-all',
                    canReset
                      ? 'text-slate-400 hover:bg-white/10 hover:text-slate-200 active:scale-90'
                      : 'cursor-not-allowed text-slate-700',
                  )}
                >
                  <RotateCcw className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {canReset ? 'Reset to IDLE' : `Cannot reset: state is ${vm.state}`}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onShutdown}
                  disabled={!canShutdown}
                  className={cn(
                    'rounded-md p-1 transition-all',
                    canShutdown
                      ? 'text-rose-400/70 hover:bg-rose-500/10 hover:text-rose-300 active:scale-90'
                      : 'cursor-not-allowed text-rose-900',
                  )}
                >
                  <Power className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                {canShutdown ? 'Shutdown process' : 'Process offline'}
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// VM Pair block (single UA per pair)
// ---------------------------------------------------------------------------

function PairBlock({
  pair,
  onAction,
}: {
  pair: PairInfo
  onAction: (ip: string, port: number, action: 'reset' | 'shutdown') => void
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-white/[0.03] overflow-hidden">
      {/* Pair header */}
      <div className="flex items-center gap-2 border-b border-border/50 bg-white/[0.03] px-3 py-1.5">
        <span className="size-1.5 rounded-full bg-cyan-500/60" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-cyan-400/70">
          {pair.pairLabel}
        </span>
      </div>

      {/* UA row */}
      <div className="px-1 py-1">
        <VMRow
          vm={pair.uac}
          onReset={() => onAction(pair.uac.ip, pair.uac.port, 'reset')}
          onShutdown={() => onAction(pair.uac.ip, pair.uac.port, 'shutdown')}
        />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session Menu
// ---------------------------------------------------------------------------

export function SessionMenu() {
  const [open, setOpen] = useState(false)
  const [pairData, setPairData] = useState<PairInfo[]>([])
  const [fetching, setFetching] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { pairs } = useTrafficStore()

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handle = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open])

  const pingVM = async (ip: string, port: number): Promise<Partial<VMBackendInfo>> => {
    try {
      const res = await fetch(`http://${ip}:${port}/api/ping`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json()
        return {
          reachable: true,
          state: data.state ?? 'CLI',
          role: data.role !== 'unconfigured' ? data.role : undefined,
          vm_id: data.vm_id !== 'unconfigured' ? data.vm_id : undefined,
        }
      }
    } catch { /* offline */ }
    return { reachable: false, state: 'offline' }
  }

  const fetchStates = useCallback(async () => {
    setFetching(true)
    const result: PairInfo[] = []

    for (const pair of pairs) {
      const uacRes = await pingVM(pair.uac.vm_ip, pair.uac.metrics_port)

      result.push({
        pairLabel: pair.pair_label,
        pairId: pair.pair_id,
        uac: {
          ip: pair.uac.vm_ip,
          port: pair.uac.metrics_port,
          role: uacRes.role ?? pair.uac.vm_role ?? 'UA',
          vm_id: uacRes.vm_id ?? pair.uac.vm_id,
          reachable: uacRes.reachable ?? false,
          state: uacRes.state ?? 'offline',
          loading: false,
        },
      })
    }

    setPairData(result)
    setFetching(false)
  }, [pairs])

  useEffect(() => { if (open) fetchStates() }, [open, fetchStates])

  const setLoading = (ip: string, port: number, val: boolean) => {
    setPairData((prev) =>
      prev.map((p) => ({
        ...p,
        uac: p.uac.ip === ip && p.uac.port === port ? { ...p.uac, loading: val } : p.uac,
      })),
    )
  }

  const handleAction = async (ip: string, port: number, action: 'reset' | 'shutdown') => {
    setLoading(ip, port, true)
    try {
      if (action === 'reset') await resetTestFor(ip, port)
      else await shutdownFor(ip, port)
    } catch { /* best-effort */ }
    setTimeout(fetchStates, action === 'shutdown' ? 1500 : 600)
  }

  const allVMs = pairData.map((p) => p.uac)
  const hasReachable = allVMs.some((v) => v.reachable)
  const hasResettable = allVMs.some(
    (v) => v.reachable && ['COMPLETE', 'FAILED', 'CONFIGURED'].includes(v.state),
  )

  const handleAllAction = async (action: 'reset' | 'shutdown') => {
    for (const vm of allVMs) {
      if (!vm.reachable) continue
      try {
        if (action === 'reset') await resetTestFor(vm.ip, vm.port)
        else await shutdownFor(vm.ip, vm.port)
      } catch { /* best-effort */ }
    }
    setTimeout(fetchStates, action === 'shutdown' ? 1500 : 600)
  }

  // Aggregate dot color
  const aggregateColor =
    allVMs.some((v) => v.state === 'FAILED')
      ? STATE_DOT.FAILED
      : allVMs.some((v) => v.state === 'RUNNING')
        ? STATE_DOT.RUNNING
        : allVMs.some((v) => v.state === 'COMPLETE')
          ? STATE_DOT.COMPLETE
          : allVMs.some((v) => v.reachable)
            ? STATE_DOT.IDLE
            : 'bg-zinc-600'

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger ─────────────────────────────────────────── */}
      <button
        onClick={() => setOpen((p) => !p)}
        className={cn(
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors',
          open
            ? 'bg-secondary text-cyan-300'
            : 'text-cyan-400 hover:bg-secondary hover:text-cyan-300',
        )}
      >
        <Server className="size-4" />
        <span className="text-sm font-medium">Sessions</span>
        {pairData.length > 0 && (
          <span className={cn('size-2 rounded-full', aggregateColor)} />
        )}
      </button>

      {/* ── Dropdown ─────────────────────────────────────────── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className={cn(
              'absolute right-0 top-full z-[60] mt-2',
              'w-[22rem] rounded-xl border border-border bg-card/95 backdrop-blur-xl',
              'shadow-2xl shadow-black/40',
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">Backend Sessions</h3>
              <button
                onClick={fetchStates}
                disabled={fetching}
                className="rounded-md p-1 text-foreground/50 transition-colors hover:bg-secondary hover:text-foreground/80 disabled:opacity-30 active:scale-90"
              >
                <RefreshCw className={cn('size-3.5', fetching && 'animate-spin')} />
              </button>
            </div>

            {/* Body */}
            <div className="max-h-72 overflow-y-auto p-3">
              {fetching && pairData.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-foreground/40">
                  <Loader2 className="size-3.5 animate-spin" />
                  Checking backends…
                </div>
              ) : pairData.length === 0 ? (
                <p className="py-8 text-center text-xs text-foreground/40">
                  No VM pairs configured
                </p>
              ) : (
                <div className="space-y-2">
                  {pairData.map((pair) => (
                    <PairBlock
                      key={pair.pairId}
                      pair={pair}
                      onAction={handleAction}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Footer */}
            {pairData.length > 0 && (
              <div className="flex items-center gap-2 border-t border-border px-4 py-3">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleAllAction('reset')}
                      disabled={!hasResettable}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-1.5',
                        'rounded-lg border px-3 py-1.5 text-xs font-medium',
                        'transition-all active:scale-[0.97]',
                        hasResettable
                          ? 'border-zinc-600 bg-zinc-700/60 text-slate-300 hover:bg-zinc-600/80 hover:text-slate-100'
                          : 'cursor-not-allowed border-zinc-700/40 bg-zinc-800/30 text-slate-600',
                      )}
                    >
                      <RotateCcw className="size-3" />
                      Reset All
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {hasResettable ? 'Reset all COMPLETE/FAILED backends to IDLE' : 'No backends in resettable state'}
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => handleAllAction('shutdown')}
                      disabled={!hasReachable}
                      className={cn(
                        'flex flex-1 items-center justify-center gap-1.5',
                        'rounded-lg border px-3 py-1.5 text-xs font-medium',
                        'transition-all active:scale-[0.97]',
                        hasReachable
                          ? 'border-rose-500/40 bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 hover:text-rose-200'
                          : 'cursor-not-allowed border-rose-900/30 bg-rose-950/10 text-rose-800',
                      )}
                    >
                      <Power className="size-3" />
                      Shutdown All
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-xs">
                    {hasReachable ? 'Shutdown all reachable backend processes' : 'No backends reachable'}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
