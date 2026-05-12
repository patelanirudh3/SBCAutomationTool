'use client'

import { useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Info, X, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { RawVMFormValues } from './VMConfigPanel'
import type { AdvancedSettings } from '@/types'

// ---------------------------------------------------------------------------
// summarize() — single source of truth for both the strip and the drawer.
// Returns a categorised view that the drawer expands and the strip cherry-picks.
// ---------------------------------------------------------------------------

export interface SummaryItem {
  label: string
  value: string
  /** Optional emphasis class for the value, e.g. when defaulted vs. customized. */
  muted?: boolean
}

export interface SummaryGroups {
  server: SummaryItem[]
  extensions: SummaryItem[]
  traffic: SummaryItem[]
  registration: SummaryItem[]
  media: SummaryItem[]
  advanced: SummaryItem[]
  /** Quick getters used by the strip. */
  extCount: number
  bhcc: number | null
}

function summarize(raw: RawVMFormValues, adv?: AdvancedSettings): SummaryGroups {
  const extStart = parseInt(raw.ext_start) || 0
  const extEnd = parseInt(raw.ext_end) || 0
  const extCount = Math.max(extEnd - extStart + 1, 0)
  const cpsNum = parseFloat(raw.cps)
  const bhcc = Number.isFinite(cpsNum) && cpsNum > 0 ? Math.round(cpsNum * 3600) : null

  const server: SummaryItem[] = [
    { label: 'Host', value: raw.sbc_host || '—' },
    { label: 'Port', value: String(raw.sbc_port || '—') },
    { label: 'Transport', value: raw.sip_transport },
    { label: 'Scheme', value: raw.sip_scheme },
    { label: 'Domain', value: raw.domain || '—' },
  ]
  if (raw.sip_transport === 'TLS') {
    server.push({ label: 'TLS Mode', value: raw.tls_mode || 'insecure' })
  }
  if (raw.failover_enabled) {
    server.push({ label: 'Failover', value: `${raw.secondary_host || '—'}:${raw.secondary_port}` })
  }
  if (raw.dns_servers) {
    server.push({ label: 'DNS', value: raw.dns_servers })
  }

  const extensions: SummaryItem[] = [
    {
      label: 'Range',
      value: extCount > 0 ? `${raw.ext_start} → ${raw.ext_end}` : '—',
    },
    { label: 'Count', value: extCount > 0 ? String(extCount) : '—' },
  ]

  const traffic: SummaryItem[] = [
    { label: 'CPS', value: raw.cps },
    ...(bhcc !== null ? [{ label: 'BHCC', value: bhcc.toLocaleString(), muted: true }] : []),
    { label: 'Hold', value: `${raw.hold_time_seconds}s` },
    {
      label: 'Ramp-Up',
      // 0 (or empty) explicitly means "no ramp" — show a clear marker
      // instead of "0s" so the operator doesn't mistake it for a typo.
      value: raw.ramp_up_seconds && parseInt(raw.ramp_up_seconds) > 0
        ? `${raw.ramp_up_seconds}s`
        : 'off',
    },
    { label: 'Mode', value: raw.traffic_mode || '—' },
    ...(raw.traffic_mode === 'smoke' ? [{ label: 'Calls', value: raw.call_count }] : []),
    ...(raw.traffic_mode === 'timed' ? [{ label: 'Duration', value: `${raw.duration_hours}h` }] : []),
  ]

  const registration: SummaryItem[] = [
    { label: 'REG Expires', value: `${raw.register_expires || '3600'}s` },
    { label: 'SUB Expires', value: `${raw.subscribe_expires || '3600'}s` },
    { label: 'Reg Rate', value: `${raw.register_rate_cps || '10'} reg/s` },
    { label: 'T1 / Timer-B', value: `${raw.t1_ms || '500'}ms / ${raw.timer_b_seconds || '32'}s` },
  ]

  const media: SummaryItem[] = raw.media_enabled
    ? [
        { label: 'Codec', value: raw.rtp_codec },
        { label: 'ptime', value: `${raw.rtp_ptime || '20'}ms` },
      ]
    : [{ label: 'Media', value: 'Disabled', muted: true }]

  const advanced: SummaryItem[] = adv
    ? [
        { label: 'QoS Metrics', value: adv.qos_enabled === false ? 'off' : 'on' },
        { label: 'MOS Estimate', value: adv.qos_mos_estimation === false ? 'off' : 'on' },
        { label: 'RTCP SR', value: adv.rtcp_sr_enabled ? `on (${adv.rtcp_sr_interval_seconds}s)` : 'off' },
        { label: 'RTP Mode', value: adv.rtp_mode },
        ...(adv.rtp_pcap ? [{ label: 'PCAP', value: 'on' }] : []),
      ]
    : []

  return { server, extensions, traffic, registration, media, advanced, extCount, bhcc }
}

// ---------------------------------------------------------------------------
// SummaryPill — single key/value pill used in the strip.
// ---------------------------------------------------------------------------

function SummaryPill({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 rounded border border-slate-700/60 bg-slate-800/40 px-2 py-1">
      <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
        {label}
      </span>
      <span className="font-mono text-sm font-semibold text-slate-100">
        {String(value)}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// ConfigSummaryStrip — always-visible footer pill row above the action bar.
// Click anywhere on the strip to open the drawer with full detail.
// ---------------------------------------------------------------------------

export interface ConfigSummaryStripProps {
  raw: RawVMFormValues
  onOpenDrawer: () => void
}

export function ConfigSummaryStrip({ raw, onOpenDrawer }: ConfigSummaryStripProps) {
  const data = summarize(raw)
  const sbc = `${raw.sbc_host || '—'}:${raw.sbc_port || '—'}`

  return (
    <button
      type="button"
      onClick={onOpenDrawer}
      title="Click to review full config"
      className={cn(
        'group flex w-full items-center gap-1.5 overflow-x-auto',
        'border-t border-border bg-card/60 px-4 py-1.5 text-left',
        'transition-colors hover:bg-card cursor-pointer',
      )}
    >
      <span className="shrink-0 text-xs font-bold uppercase tracking-widest text-slate-400 group-hover:text-slate-200">
        Config
      </span>
      <span className="text-slate-700">·</span>
      <SummaryPill label="SBC"   value={`${sbc}/${raw.sip_transport}`} />
      <SummaryPill label="Ext"   value={data.extCount > 0 ? data.extCount : '—'} />
      <SummaryPill label="CPS"   value={raw.cps || '—'} />
      <SummaryPill label="Hold"  value={`${raw.hold_time_seconds || '—'}s`} />
      <SummaryPill
        label="Media"
        value={raw.media_enabled ? raw.rtp_codec.replace('G711_', 'G711-') : 'off'}
      />
      <SummaryPill label="Mode" value={raw.traffic_mode || '—'} />
      <span className="ml-auto flex shrink-0 items-center gap-1 text-xs text-slate-400 group-hover:text-emerald-400 transition-colors">
        <Info className="size-3.5" />
        Review
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// SummarySection — collapsible/labelled group inside the drawer.
// ---------------------------------------------------------------------------

function SummarySection({ title, items }: { title: string; items: SummaryItem[] }) {
  if (items.length === 0) return null
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-300">
        <span className="h-2.5 w-0.5 shrink-0 rounded-full bg-emerald-500/60" />
        {title}
        <span className="h-px flex-1 bg-slate-700/40" />
      </h3>
      <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-1 px-1 text-sm leading-relaxed">
        {items.map((it, idx) => (
          <div key={idx} className="contents">
            <dt className="text-slate-400">{it.label}</dt>
            <dd
              className={cn(
                'truncate font-mono',
                it.muted ? 'text-slate-400' : 'text-slate-100',
              )}
              title={it.value}
            >
              {it.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ConfigSummarySidebar — sticky right-side panel showing the same categorised
// breakdown as the drawer, but always visible (no toggle). Used at lg+
// viewports (>=1280px) where there is room to accommodate it; below that
// breakpoint VMPairBook keeps the footer strip + drawer combo so narrow
// windows aren't crowded.
//
// Reuses summarize() and <SummarySection> so the sidebar and drawer can
// never drift out of sync.
// ---------------------------------------------------------------------------

export interface ConfigSummarySidebarProps {
  raw: RawVMFormValues
  advancedSettings?: AdvancedSettings
}

export function ConfigSummarySidebar({ raw, advancedSettings }: ConfigSummarySidebarProps) {
  const data = summarize(raw, advancedSettings)
  return (
    <aside
      aria-label="Config Summary"
      className={cn(
        'flex flex-col rounded-xl border border-border bg-card',
        'sticky top-5 max-h-[calc(100vh-7rem)]',
      )}
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-bold uppercase tracking-widest text-emerald-400">
          Live
        </span>
        <h2 className="text-sm font-bold uppercase tracking-widest text-slate-100">
          Config Summary
        </h2>
      </header>
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        <SummarySection title="SIP Server"   items={data.server} />
        <SummarySection title="Extensions"   items={data.extensions} />
        <SummarySection title="Traffic"      items={data.traffic} />
        <SummarySection title="Registration" items={data.registration} />
        <SummarySection title="Media"        items={data.media} />
        {data.advanced.length > 0 && (
          <SummarySection title="QoS / Advanced" items={data.advanced} />
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// ConfigSummaryDrawer — right-side slide-in panel with the full categorised
// breakdown. Closes on backdrop click, ESC key, or X button.
// ---------------------------------------------------------------------------

export interface ConfigSummaryDrawerProps {
  raw: RawVMFormValues
  advancedSettings?: AdvancedSettings
  open: boolean
  onClose: () => void
}

export function ConfigSummaryDrawer({
  raw,
  advancedSettings,
  open,
  onClose,
}: ConfigSummaryDrawerProps) {
  const data = summarize(raw, advancedSettings)

  // ESC closes the drawer.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
            onClick={onClose}
          />
          {/* Drawer panel */}
          <motion.aside
            key="drawer"
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.2, ease: 'easeOut' }}
            className={cn(
              'fixed right-0 top-0 z-50 flex h-full w-[340px] flex-col',
              'border-l border-border bg-card shadow-2xl shadow-black/40',
            )}
            role="dialog"
            aria-label="Config Review"
          >
            <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs font-bold uppercase tracking-widest text-emerald-400">
                  Review
                </span>
                <h2 className="text-sm font-bold uppercase tracking-widest text-slate-100">
                  Config Summary
                </h2>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100"
                aria-label="Close"
              >
                <X className="size-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
              <SummarySection title="SIP Server"   items={data.server} />
              <SummarySection title="Extensions"   items={data.extensions} />
              <SummarySection title="Traffic"      items={data.traffic} />
              <SummarySection title="Registration" items={data.registration} />
              <SummarySection title="Media"        items={data.media} />
              {data.advanced.length > 0 && (
                <SummarySection title="QoS / Advanced" items={data.advanced} />
              )}
            </div>

            <footer className="shrink-0 border-t border-border bg-card/60 px-4 py-2.5 text-xs text-slate-500">
              <div className="flex items-center justify-between">
                <span>Press <kbd className="rounded border border-slate-700 bg-slate-800/60 px-1 font-mono text-xs">ESC</kbd> to close</span>
                <button
                  type="button"
                  onClick={onClose}
                  className="flex items-center gap-1 text-slate-400 transition-colors hover:text-emerald-400"
                >
                  Close
                  <ChevronRight className="size-3" />
                </button>
              </div>
            </footer>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  )
}
