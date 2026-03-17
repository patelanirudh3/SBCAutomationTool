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
  offline:    'bg-zinc-700',
}

const STATE_TEXT: Record<string, string> = {
  IDLE:       'text-zinc-400',
  CONFIGURED: 'text-blue-400',
  RUNNING:    'text-amber-400',
  COMPLETE:   'text-emerald-400',
  FAILED:     'text-rose-400',
  CLI:        'text-cyan-400',
  offline:    'text-zinc-600',
}

// ---------------------------------------------------------------------------
// Individual VM row
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
  const isUAS = vm.role === 'UAS'
  const canReset =
    vm.reachable &&
    ['COMPLETE', 'FAILED', 'CONFIGURED'].includes(vm.state)
  const canShutdown = vm.reachable

  return (
    <div
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2.5',
        'transition-colors hover:bg-secondary/40',
      )}
    >
      {/* State dot */}
      <span className="relative flex size-2 shrink-0">
        {vm.state === 'RUNNING' && (
          <span
            className={cn(
              'absolute inline-flex h-full w-full rounded-full opacity-50 animate-ping',
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

      {/* Info */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span
            className={cn(
              'rounded px-1 py-px text-[9px] font-bold leading-none tracking-widest',
              isUAS
                ? 'bg-violet-500/15 text-violet-400'
                : 'bg-blue-500/15 text-blue-400',
            )}
          >
            {vm.role}
          </span>
          <span className="truncate text-xs font-medium text-foreground/80">
            {vm.vm_id}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="font-mono text-[10px] text-foreground/35">
            {vm.ip}:{vm.port}
          </span>
          <span
            className={cn(
              'text-[10px] font-semibold',
              STATE_TEXT[vm.state] ?? 'text-zinc-600',
            )}
          >
            {vm.state}
          </span>
        </div>
      </div>

      {/* Actions — visible on row hover */}
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {vm.loading ? (
          <Loader2 className="size-3 animate-spin text-foreground/30" />
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onReset}
                  disabled={!canReset}
                  className={cn(
                    'rounded-md p-1 transition-colors',
                    canReset
                      ? 'text-foreground/40 hover:bg-secondary hover:text-foreground/70'
                      : 'cursor-not-allowed text-foreground/15',
                  )}
                >
                  <RotateCcw className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Reset to IDLE
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onShutdown}
                  disabled={!canShutdown}
                  className={cn(
                    'rounded-md p-1 transition-colors',
                    canShutdown
                      ? 'text-rose-400/60 hover:bg-rose-500/10 hover:text-rose-400'
                      : 'cursor-not-allowed text-rose-400/15',
                  )}
                >
                  <Power className="size-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Shutdown process
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session Menu (dropdown from Navbar)
// ---------------------------------------------------------------------------

export function SessionMenu() {
  const [open, setOpen] = useState(false)
  const [vms, setVms] = useState<VMBackendInfo[]>([])
  const [fetching, setFetching] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { pairs } = useTrafficStore()

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node))
        setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handle)
    return () => document.removeEventListener('keydown', handle)
  }, [open])

  // Fetch live state from each backend when the panel opens
  const fetchStates = useCallback(async () => {
    setFetching(true)
    const list: VMBackendInfo[] = []

    for (const pair of pairs) {
      for (const side of [pair.uas, pair.uac]) {
        const entry: VMBackendInfo = {
          ip: side.vm_ip,
          port: side.metrics_port,
          role: side.vm_role,
          vm_id: side.vm_id,
          reachable: false,
          state: 'offline',
          loading: false,
        }
        try {
          const res = await fetch(
            `http://${side.vm_ip}:${side.metrics_port}/api/ping`,
            { signal: AbortSignal.timeout(3000) },
          )
          if (res.ok) {
            const data = await res.json()
            entry.reachable = true
            entry.state = data.state ?? 'CLI'
            entry.role =
              data.role !== 'unconfigured' ? data.role : side.vm_role
            entry.vm_id =
              data.vm_id !== 'unconfigured' ? data.vm_id : side.vm_id
          }
        } catch {
          /* offline */
        }
        list.push(entry)
      }
    }

    setVms(list)
    setFetching(false)
  }, [pairs])

  useEffect(() => {
    if (open) fetchStates()
  }, [open, fetchStates])

  // Per-VM action handler
  const handleAction = async (
    ip: string,
    port: number,
    action: 'reset' | 'shutdown',
  ) => {
    setVms((prev) =>
      prev.map((v) =>
        v.ip === ip && v.port === port ? { ...v, loading: true } : v,
      ),
    )
    try {
      if (action === 'reset') await resetTestFor(ip, port)
      else await shutdownFor(ip, port)
    } catch {
      /* best-effort */
    }
    setTimeout(fetchStates, action === 'shutdown' ? 1500 : 600)
  }

  // Bulk actions
  const handleAllAction = async (action: 'reset' | 'shutdown') => {
    for (const vm of vms) {
      if (!vm.reachable) continue
      try {
        if (action === 'reset') await resetTestFor(vm.ip, vm.port)
        else await shutdownFor(vm.ip, vm.port)
      } catch {
        /* best-effort */
      }
    }
    setTimeout(fetchStates, action === 'shutdown' ? 1500 : 600)
  }

  // Aggregate dot for the trigger button
  const aggregateColor = vms.length === 0
    ? 'bg-zinc-700'
    : vms.some((v) => v.state === 'FAILED')
      ? STATE_DOT.FAILED
      : vms.some((v) => v.state === 'RUNNING')
        ? STATE_DOT.RUNNING
        : vms.some((v) => v.state === 'COMPLETE')
          ? STATE_DOT.COMPLETE
          : vms.some((v) => v.reachable)
            ? STATE_DOT.IDLE
            : 'bg-zinc-700'

  const hasReachable = vms.some((v) => v.reachable)
  const hasResettable = vms.some(
    (v) =>
      v.reachable &&
      ['COMPLETE', 'FAILED', 'CONFIGURED'].includes(v.state),
  )

  return (
    <div ref={ref} className="relative">
      {/* ── Trigger button ──────────────────────────────────── */}
      <button
        onClick={() => setOpen((p) => !p)}
        className={cn(
          'flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors',
          open
            ? 'bg-secondary text-cyan-300'
            : 'hover:bg-secondary text-cyan-400 hover:text-cyan-300',
        )}
      >
        <Server className="size-4" />
        <span className="text-sm font-medium">Sessions</span>
        {vms.length > 0 && (
          <span className={cn('size-2 rounded-full', aggregateColor)} />
        )}
      </button>

      {/* ── Dropdown panel ──────────────────────────────────── */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            className={cn(
              'absolute right-0 top-full z-[60] mt-2',
              'w-80 rounded-xl border border-border bg-card/95 backdrop-blur-xl',
              'shadow-xl shadow-black/30',
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border/50 px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">
                Backend Sessions
              </h3>
              <button
                onClick={fetchStates}
                disabled={fetching}
                className="rounded-md p-1 text-foreground/40 transition-colors hover:bg-secondary hover:text-foreground/70 disabled:opacity-40"
              >
                <RefreshCw
                  className={cn('size-3.5', fetching && 'animate-spin')}
                />
              </button>
            </div>

            {/* VM list */}
            <div className="max-h-64 overflow-y-auto p-2">
              {fetching && vms.length === 0 ? (
                <div className="flex items-center justify-center gap-2 py-8 text-xs text-foreground/40">
                  <Loader2 className="size-3.5 animate-spin" />
                  Checking backends…
                </div>
              ) : vms.length === 0 ? (
                <p className="py-8 text-center text-xs text-foreground/40">
                  No VM pairs configured
                </p>
              ) : (
                <div className="space-y-0.5">
                  {vms.map((vm) => (
                    <VMRow
                      key={`${vm.ip}:${vm.port}`}
                      vm={vm}
                      onReset={() =>
                        handleAction(vm.ip, vm.port, 'reset')
                      }
                      onShutdown={() =>
                        handleAction(vm.ip, vm.port, 'shutdown')
                      }
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Footer actions */}
            {vms.length > 0 && (
              <div className="flex items-center gap-2 border-t border-border/50 px-4 py-3">
                <button
                  onClick={() => handleAllAction('reset')}
                  disabled={!hasResettable}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5',
                    'text-xs font-medium transition-colors',
                    hasResettable
                      ? 'bg-secondary text-foreground/80 hover:bg-secondary/80'
                      : 'cursor-not-allowed bg-secondary/30 text-foreground/25',
                  )}
                >
                  <RotateCcw className="size-3" />
                  Reset All
                </button>
                <button
                  onClick={() => handleAllAction('shutdown')}
                  disabled={!hasReachable}
                  className={cn(
                    'flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3 py-1.5',
                    'text-xs font-medium transition-colors',
                    hasReachable
                      ? 'bg-rose-500/10 text-rose-400 hover:bg-rose-500/20'
                      : 'cursor-not-allowed bg-rose-500/5 text-rose-400/25',
                  )}
                >
                  <Power className="size-3" />
                  Shutdown All
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
