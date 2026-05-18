'use client'

import { Activity, Cpu, HardDrive, MemoryStick, Network, Server } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { HostHealth } from '@/types'

interface VMHealthPanelProps {
  health?: HostHealth | null
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

export function VMHealthPanel({ health }: VMHealthPanelProps) {
  return (
    <div className="rounded-xl border border-slate-700/40 bg-card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Server className="size-4 text-emerald-400" />
        <span className="text-sm font-semibold text-slate-200">Traffic Engine VM Health</span>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-300">VM Health</div>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <HealthCard
          icon={Cpu}
          label="Host CPU"
          value={formatPct(health?.cpu_percent)}
          sub={`load ${health?.load1?.toFixed(2) ?? '-'} / ${health?.load5?.toFixed(2) ?? '-'} / ${health?.load15?.toFixed(2) ?? '-'}`}
          tone={toneForPct(health?.cpu_percent)}
        />
        <HealthCard
          icon={MemoryStick}
          label="Host Memory"
          value={formatPct(health?.mem_used_percent)}
          sub={`${formatBytes(health?.mem_available_bytes)} free`}
          tone={toneForPct(health?.mem_used_percent)}
        />
        <HealthCard
          icon={HardDrive}
          label="Disk"
          value={formatPct(health?.disk_used_percent)}
          sub={`${formatBytes(health?.disk_free_bytes)} free`}
          tone={toneForPct(health?.disk_used_percent)}
        />
        <HealthCard
          icon={Network}
          label="UDP Errors"
          value={`${health?.udp_in_errors ?? 0}`}
          sub={`rcvbuf ${health?.udp_rcvbuf_errors ?? 0}`}
          tone={(health?.udp_in_errors ?? 0) > 0 || (health?.udp_rcvbuf_errors ?? 0) > 0 ? 'warning' : 'default'}
        />
        <HealthCard
          icon={Network}
          label="Network I/O"
          value={formatBytes(health?.net_rx_bytes)}
          sub={`${formatBytes(health?.net_tx_bytes)} TX`}
        />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-xs font-bold uppercase tracking-wide text-slate-300">Traffic Engine Process</div>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <HealthCard
            icon={Cpu}
            label="Process CPU"
            value={formatPct(health?.process_cpu_percent)}
            tone={toneForPct(health?.process_cpu_percent)}
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
      </div>
    </div>
  )
}
