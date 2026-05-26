'use client'

import { useState } from 'react'
import { Activity, Cpu, HardDrive, MemoryStick, Network, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import { setPerformanceDiagnosticsFor } from '@/lib/api'
import type { HostHealth, PerformanceDiagnosticsMode } from '@/types'

interface VMHealthPanelProps {
  health?: HostHealth | null
  variant?: 'compact' | 'full' | 'summary'
  vmIp?: string
  metricsPort?: number
  showDiagnosticsControl?: boolean
  summary?: {
    hostCpuAvg?: number | null
    hostCpuMax?: number | null
    engineCpuCoreAvg?: number | null
    engineCpuCoreMax?: number | null
    softirqCpuMax?: number | null
    iowaitCpuMax?: number | null
  }
}

function formatBytes(v?: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = v
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

function formatPct(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : '-'
}

function toneForPct(v?: number): 'default' | 'warning' | 'danger' {
  if (typeof v !== 'number') return 'default'
  if (v >= 90) return 'danger'
  if (v >= 80) return 'warning'
  return 'default'
}

function formatNumber(v?: number): string {
  return typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '-'
}

function modeLabel(mode?: PerformanceDiagnosticsMode): string {
  if (mode === 'slow') return 'Slow Scan'
  if (mode === 'off') return 'Off'
  return 'Warning Only'
}

function HealthCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon: React.ElementType
  label: string
  value: string
  sub?: string
  tone?: 'default' | 'warning' | 'danger'
}) {
  const cls =
    tone === 'danger' ? 'border-rose-500/30 bg-rose-500/5 text-rose-300'
    : tone === 'warning' ? 'border-amber-500/30 bg-amber-500/5 text-amber-300'
    : 'border-slate-700/40 bg-slate-800/30 text-slate-200'

  return (
    <div className={cn('rounded-xl border p-3', cls)}>
      <div className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</span>
      </div>
      <div className="mt-2 font-mono text-lg font-bold tabular-nums">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-500">{sub}</div>}
    </div>
  )
}

export function VMHealthPanel(props: VMHealthPanelProps) {
  return <VMHealthPanelContent {...props} />
}

export function VMHealthPanelContent({
  health,
  variant = 'full',
  vmIp,
  metricsPort,
  showDiagnosticsControl = false,
  summary,
}: VMHealthPanelProps) {
  const [pendingMode, setPendingMode] = useState<PerformanceDiagnosticsMode | null>(null)
  const [modeError, setModeError] = useState<string | null>(null)
  const mode = pendingMode ?? health?.top_process_mode ?? 'warning_only'
  const engineCPUCore = health?.process_cpu_percent_core ?? (
    typeof health?.process_cpu_percent === 'number' ? health.process_cpu_percent : undefined
  )
  const engineCPUVM = health?.process_cpu_percent_vm ?? health?.process_cpu_percent
  const topProcess = health?.top_processes?.[0]
  const isCompact = variant === 'compact'
  const isSummary = variant === 'summary'
  const canSetMode = !!vmIp && !!metricsPort

  const setMode = async (next: PerformanceDiagnosticsMode) => {
    if (!canSetMode) return
    setModeError(null)
    setPendingMode(next)
    try {
      await setPerformanceDiagnosticsFor(vmIp, metricsPort, next)
    } catch (err) {
      setModeError(err instanceof Error ? err.message : 'Failed to update CPU attribution mode')
      setPendingMode(null)
    }
  }

  return (
    <div className="rounded-xl border border-slate-700/40 bg-card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Server className="size-4 text-emerald-400" />
        <span className="text-sm font-semibold text-slate-200">Traffic Engine VM Health</span>
        {showDiagnosticsControl && (
          <div className="ml-auto flex flex-wrap items-center gap-1 text-[11px]">
            <span className="mr-1 text-slate-400">CPU Attribution:</span>
            {(['warning_only', 'slow', 'off'] as PerformanceDiagnosticsMode[]).map((m) => (
              <button
                key={m}
                type="button"
                disabled={!canSetMode}
                onClick={() => setMode(m)}
                className={cn(
                  'rounded border px-2 py-0.5 font-semibold transition',
                  mode === m
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                    : 'border-slate-700 bg-slate-900/50 text-slate-400 hover:text-slate-200',
                  !canSetMode && 'cursor-not-allowed opacity-60',
                )}
              >
                {modeLabel(m)}
              </button>
            ))}
          </div>
        )}
      </div>

      {modeError && (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {modeError}
        </div>
      )}

      {health?.performance_warnings?.length ? (
        <div className="rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          {health.performance_warnings[0]}
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-300">
          {isSummary ? 'Run CPU Summary' : 'VM Readiness'}
        </div>
        {isSummary && summary ? (
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <HealthCard icon={Cpu} label="Avg Host CPU" value={formatPct(summary.hostCpuAvg ?? undefined)} />
            <HealthCard icon={Cpu} label="Max Host CPU" value={formatPct(summary.hostCpuMax ?? undefined)} tone={toneForPct(summary.hostCpuMax ?? undefined)} />
            <HealthCard icon={Cpu} label="Avg Engine CPU" value={formatPct(summary.engineCpuCoreAvg ?? undefined)} sub="% core" />
            <HealthCard icon={Cpu} label="Max Engine CPU" value={formatPct(summary.engineCpuCoreMax ?? undefined)} sub="% core" tone={toneForPct(summary.engineCpuCoreMax ?? undefined)} />
            <HealthCard icon={Network} label="Max SoftIRQ" value={formatPct(summary.softirqCpuMax ?? undefined)} tone={toneForPct((summary.softirqCpuMax ?? 0) * 8)} />
            <HealthCard icon={HardDrive} label="Max IOWait" value={formatPct(summary.iowaitCpuMax ?? undefined)} />
          </div>
        ) : (
        <div className={cn('grid gap-3', isCompact ? 'sm:grid-cols-4' : 'sm:grid-cols-3 lg:grid-cols-6')}>
        <HealthCard
          icon={Cpu}
          label="Host CPU"
          value={formatPct(health?.cpu_percent)}
          sub={`load ${health?.load1?.toFixed(2) ?? '-'} / ${health?.load5?.toFixed(2) ?? '-'} / ${health?.load15?.toFixed(2) ?? '-'}`}
          tone={toneForPct(health?.cpu_percent)}
        />
        <HealthCard
          icon={Cpu}
          label="Engine CPU"
          value={formatPct(engineCPUCore)}
          sub="% of one core"
          tone={toneForPct(engineCPUCore)}
        />
        <HealthCard
          icon={MemoryStick}
          label="Host Memory"
          value={formatPct(health?.mem_used_percent)}
          sub={`${formatBytes(health?.mem_available_bytes)} free`}
          tone={toneForPct(health?.mem_used_percent)}
        />
        {!isCompact && (
          <HealthCard
            icon={HardDrive}
            label="Disk"
            value={formatPct(health?.disk_used_percent)}
            sub={`${formatBytes(health?.disk_free_bytes)} free`}
            tone={toneForPct(health?.disk_used_percent)}
          />
        )}
        <HealthCard
          icon={Network}
          label="UDP Errors"
          value={`${health?.udp_in_errors ?? 0}`}
          sub={`rcvbuf ${health?.udp_rcvbuf_errors ?? 0}`}
          tone={(health?.udp_in_errors ?? 0) > 0 || (health?.udp_rcvbuf_errors ?? 0) > 0 ? 'warning' : 'default'}
        />
        {!isCompact && (
          <>
            <HealthCard
              icon={Network}
              label="SoftIRQ CPU"
              value={formatPct(health?.cpu_softirq_percent)}
              sub="kernel network"
              tone={toneForPct((health?.cpu_softirq_percent ?? 0) * 8)}
            />
            <HealthCard
              icon={Activity}
              label="Top Process"
              value={topProcess ? topProcess.name : mode === 'off' ? 'Off' : 'Not sampled'}
              sub={topProcess ? `${formatPct(topProcess.cpu_percent_core)} core · ${formatBytes(topProcess.rss_bytes)}` : modeLabel(mode)}
            />
          </>
        )}
        </div>
        )}
      </div>

      {!isCompact && !isSummary && (
        <details className="group rounded-lg border border-slate-700/40 bg-slate-900/20 p-3">
          <summary className="cursor-pointer text-xs font-bold uppercase tracking-wide text-slate-300">
            Details
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <HealthCard
            icon={Cpu}
            label="Engine CPU (% VM)"
            value={formatPct(engineCPUVM)}
            tone={toneForPct(engineCPUVM)}
          />
          <HealthCard
            icon={MemoryStick}
            label="RSS Memory"
            value={formatBytes(health?.process_rss_bytes)}
            sub={`VMS ${formatBytes(health?.process_vms_bytes)}`}
          />
          <HealthCard
            icon={Activity}
            label="Threads"
            value={formatNumber(health?.process_threads)}
            sub={`${formatNumber(health?.goroutines)} goroutines`}
          />
          <HealthCard
            icon={Activity}
            label="Open FDs"
            value={formatNumber(health?.open_fds)}
          />
          <HealthCard
            icon={HardDrive}
            label="Disk Read"
            value={formatBytes(health?.process_read_bytes)}
            sub={`${formatNumber(health?.process_read_syscalls)} syscalls`}
          />
          <HealthCard
            icon={HardDrive}
            label="Disk Write"
            value={formatBytes(health?.process_write_bytes)}
            sub={`${formatNumber(health?.process_write_syscalls)} syscalls`}
          />
            </div>
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <HealthCard icon={Cpu} label="System CPU" value={formatPct(health?.cpu_system_percent)} />
              <HealthCard icon={HardDrive} label="IOWait CPU" value={formatPct(health?.cpu_iowait_percent)} />
              <HealthCard icon={Activity} label="Steal CPU" value={formatPct(health?.cpu_steal_percent)} />
              <HealthCard icon={Activity} label="IRQ CPU" value={formatPct(health?.cpu_irq_percent)} />
              <HealthCard icon={Network} label="Network RX" value={formatBytes(health?.net_rx_bytes)} />
              <HealthCard icon={Network} label="Network TX" value={formatBytes(health?.net_tx_bytes)} />
            </div>
            {health?.top_processes?.length ? (
              <div className="rounded-lg border border-slate-700/40 bg-slate-950/30 p-3">
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-300">Top CPU Processes</div>
                <div className="grid gap-2">
                  {health.top_processes.map((p) => (
                    <div key={p.pid} className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/40 px-3 py-2 text-xs">
                      <span className="font-mono text-slate-200">{p.name}</span>
                      <span className="text-slate-400">pid {p.pid} · {formatPct(p.cpu_percent_core)} core · {formatBytes(p.rss_bytes)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </details>
      )}
        </div>
  )
}
