'use client'

import { useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { FieldError, FieldSoftWarning } from './ConfigValidator'
import { TrafficModeSelector } from './TrafficModeSelector'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Loader2, CheckCircle, XCircle, Signal, RotateCcw, Info, ChevronDown } from 'lucide-react'
import type { TrafficMode, PairingPolicy, SipTransport, SipScheme, LocalIPMode, RtpCodec, RtpUnsupportedCodecPolicy, ReachabilityStatus, TLSMode, MediaSecurity, SRTPCryptoSuite } from '@/types'
import { SUBSCRIBE_EVENT_OPTIONS, SUBSCRIBE_EVENT_VALUES } from '@/lib/subscription-events'
import { applyVIPsFor, uploadCertificateFor, verifyTLSFor, verifyVIPsFor, type TLSVerifyResult, type VIPResult } from '@/lib/api'

// All form values stored as strings so inputs stay fully controlled
export type RawVMFormValues = {
  vm_id: string
  vm_ip: string
  ssh_user: string
  ssh_key_path: string
  local_ip_mode: LocalIPMode
  local_host: string
  vip_interface: string
  vip_cidr: string
  vip_first_ip: string
  vip_count: string
  vip_gateway_ip: string
  vip_sanity_target_ip: string
  // Unified extension pool (single range)
  ext_start: string
  ext_end: string
  ext_count: string
  static_agent_assignments_json: string
  // Registration / subscription
  register_expires: string
  subscribe_expires: string
  subscribe_events: string[]
  subscribe_refresh_events: string[]
  subscribe_unsubscribe_events: string[]
  agent_connection_cps: string
  agent_regsub_cps: string
  // RFC 3261 INVITE client-transaction timers (UAC). Empty -> backend uses RFC defaults.
  t1_ms: string
  timer_b_seconds: string
  // SIP server
  sbc_host: string
  sbc_port: string
  dual_registration_enabled: boolean
  secondary_host: string
  secondary_port: string
  failover_enabled: boolean
  failover_mode: 'graceful' | 'force'
  auto_failback_enabled: boolean
  failback_delay_seconds: string
  failover_trigger: 'per_agent' | 'min_agents' | 'pct_agents'
  failover_trigger_count: string
  failover_trigger_pct: string
  failover_trigger_window_ms: string
  dns_servers: string
  sip_transport: SipTransport
  sip_scheme: SipScheme
  domain: string
  sip_password: string
  // TLS — only meaningful when sip_transport === 'TLS'
  tls_mode: TLSMode
  tls_ca_path: string
  tls_cert_path: string
  tls_key_path: string
  tls_server_name: string
  tls_min_version: '1.2' | '1.3'
  tls_max_version: 'auto' | '1.2' | '1.3'
  // Traffic
  cps: string
  hold_time_seconds: string
  ramp_up_seconds: string
  pairing_policy: PairingPolicy
  // Media
  media_enabled: boolean
  media_security: MediaSecurity | 'capneg'
  srtp_crypto_suites: SRTPCryptoSuite[]
  srtp_key_mode: 'auto'
  rtp_codec: RtpCodec
  rtp_unsupported_codec_policy: RtpUnsupportedCodecPolicy
  rtp_ptime: string
  // Engine
  metrics_port: string
  // HA
  ha_mode: 'single' | 'dual' | 'multi_zone'
  zone_config_json: string
  // Run control
  traffic_mode: TrafficMode
  call_count: string
  duration_hours: string
  start_time_iso: string
}

/**
 * Tab identifier — selects which group of sections the panel renders.
 * "all" preserves the legacy single-page rendering and is used as the
 * fallback when the parent doesn't pass a tab. Tabs map:
 *   server    → Traffic Agent Host + Remote SIP Server (incl. TLS / Failover / DNS)
 *   signaling → Registration & SIP Timers (REGISTER/SUBSCRIBE expires + cadence,
 *               RFC 3261 timers, TCP keepalive, 100rel toggle).
 *   traffic   → Extension Pool + Call Traffic (cps, hold time, ramp-up,
 *               traffic mode, call count / duration / start time).
 *   media     → Media (RTP) + QoS / RTCP. The AdvancedSettings card is
 *               rendered separately by the parent (VMPairBook), filtered
 *               per-tab via its `tab` prop.
 */
export type VMConfigTab = 'server' | 'signaling' | 'traffic' | 'media' | 'all'

export interface VMConfigPanelProps {
  raw: RawVMFormValues
  onChange: (field: keyof RawVMFormValues, value: string | string[] | boolean) => void
  touched: Set<string>
  onBlur: (field: string) => void
  errors: Record<string, string>
  warnings: Record<string, string>
  reachability: ReachabilityStatus | null
  onCheckReachability: () => void
  onResetSection: (fields: (keyof RawVMFormValues)[]) => void
  tab?: VMConfigTab
}

/**
 * TAB_FIELDS — used by the parent to count per-tab validation errors and
 * render a small red badge on each tab trigger. Mirrors the section-to-tab
 * mapping in the panel's render block below; keep these in sync.
 */
export const TAB_FIELDS: Record<Exclude<VMConfigTab, 'all'>, ReadonlyArray<keyof RawVMFormValues>> = {
  server: [
    'vm_id', 'vm_ip', 'metrics_port', 'ssh_user', 'ssh_key_path',
    'local_ip_mode', 'local_host', 'vip_interface', 'vip_cidr', 'vip_first_ip', 'vip_count', 'vip_gateway_ip', 'vip_sanity_target_ip',
    'sbc_host', 'sbc_port', 'sip_transport', 'sip_scheme', 'domain', 'sip_password',
    'dual_registration_enabled', 'secondary_host', 'secondary_port', 'failover_mode', 'auto_failback_enabled', 'failback_delay_seconds',
    'failover_trigger', 'failover_trigger_count', 'failover_trigger_pct', 'failover_trigger_window_ms', 'dns_servers',
    'tls_mode', 'tls_ca_path', 'tls_cert_path', 'tls_key_path', 'tls_server_name', 'tls_min_version', 'tls_max_version',
  ],
  signaling: [
    'register_expires', 'subscribe_expires', 'subscribe_events', 'subscribe_refresh_events', 'subscribe_unsubscribe_events',
    't1_ms', 'timer_b_seconds',
  ],
  traffic: [
    'ext_start', 'ext_count', 'static_agent_assignments_json',
    'agent_connection_cps', 'agent_regsub_cps',
    'cps', 'hold_time_seconds', 'ramp_up_seconds',
    'pairing_policy', 'traffic_mode', 'call_count', 'duration_hours', 'start_time_iso',
  ],
  media: ['media_enabled', 'media_security', 'srtp_crypto_suites', 'srtp_key_mode', 'rtp_codec', 'rtp_unsupported_codec_policy', 'rtp_ptime'],
}

// Default values for the Registration section — used to detect "dirty" state
// and auto-expand the collapsed section when any value differs.
const DEFAULTS_REGISTRATION = {
  register_expires:  '3600',
  subscribe_expires: '3600',
  subscribe_events:  ['dialog'],
  subscribe_refresh_events: ['dialog'],
  subscribe_unsubscribe_events: ['dialog'],
  t1_ms:             '500',
  timer_b_seconds:   '32',
}

// Fields belonging to each logical section — used by per-section Reset buttons
const SECTION_FIELDS = {
  identity:       ['vm_id'] as (keyof RawVMFormValues)[],
  agent_host:     ['vm_ip', 'metrics_port', 'ssh_user', 'ssh_key_path', 'local_ip_mode', 'local_host', 'vip_interface', 'vip_cidr', 'vip_first_ip', 'vip_count', 'vip_gateway_ip', 'vip_sanity_target_ip'] as (keyof RawVMFormValues)[],
  sip_server:     ['sbc_host', 'sbc_port', 'sip_transport', 'sip_scheme', 'domain', 'sip_password',
                   'dual_registration_enabled', 'secondary_host', 'secondary_port', 'failover_mode', 'auto_failback_enabled', 'failback_delay_seconds',
                   'failover_trigger', 'failover_trigger_count', 'failover_trigger_pct', 'failover_trigger_window_ms', 'dns_servers',
                  'tls_mode', 'tls_ca_path', 'tls_cert_path', 'tls_key_path', 'tls_server_name', 'tls_min_version', 'tls_max_version'] as (keyof RawVMFormValues)[],
  extension_pool: ['ext_start', 'ext_count', 'static_agent_assignments_json'] as (keyof RawVMFormValues)[],
  registration:   ['register_expires', 'subscribe_expires', 'subscribe_events', 'subscribe_refresh_events', 'subscribe_unsubscribe_events', 't1_ms', 'timer_b_seconds'] as (keyof RawVMFormValues)[],
  register_traffic: ['agent_connection_cps', 'agent_regsub_cps'] as (keyof RawVMFormValues)[],
  call_traffic:   ['cps', 'hold_time_seconds', 'ramp_up_seconds', 'pairing_policy', 'traffic_mode', 'call_count', 'duration_hours', 'start_time_iso'] as (keyof RawVMFormValues)[],
  media:          ['media_enabled', 'media_security', 'srtp_crypto_suites', 'srtp_key_mode', 'rtp_codec', 'rtp_unsupported_codec_policy', 'rtp_ptime'] as (keyof RawVMFormValues)[],
} as const

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-200">
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className="flex items-center gap-1 text-xs normal-case tracking-normal font-normal text-slate-500 hover:text-slate-300 transition-colors"
          title="Reset section to defaults"
        >
          <RotateCcw className="size-3" />
          Reset
        </button>
      )}
    </h3>
  )
}

/**
 * CollapsibleSection — sibling of SectionHeader that wraps content in an
 * animated collapse. Use for sections that are rarely edited (Registration
 * timers, custom DNS, failover) so the form is shorter by default but the
 * fields are still one click away. The "Reset" button is rendered inside
 * the header and only acts on this section's fields.
 *
 * `dirty` (optional) shows a small dot next to the header when any field in
 * the section has been changed from defaults — encourages users to expand
 * sections that have customizations even when collapsed.
 */
function CollapsibleSection({
  title,
  defaultOpen = false,
  dirty = false,
  onReset,
  children,
}: {
  title: ReactNode
  defaultOpen?: boolean
  dirty?: boolean
  onReset?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-slate-200">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left transition-colors hover:text-emerald-400"
          aria-expanded={open}
        >
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 text-slate-500 transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
          <span>{title}</span>
          {dirty && (
            <span
              className="size-2 shrink-0 rounded-full bg-amber-400"
              title="Customised — click to expand"
            />
          )}
        </button>
        <span className="h-px flex-1 bg-border" />
        {onReset && open && (
          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1 text-xs normal-case tracking-normal font-normal text-slate-500 hover:text-slate-300 transition-colors"
            title="Reset section to defaults"
          >
            <RotateCcw className="size-3" />
            Reset
          </button>
        )}
      </h3>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-2 pt-1">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/**
 * InfoTooltip — small "ⓘ" icon next to a Label that reveals descriptive
 * help text on hover/focus. Replaces the old below-input FieldHint pattern
 * so each field occupies one row instead of three lines.
 */
function InfoTooltip({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground/60 transition-colors hover:text-emerald-400"
          tabIndex={-1}
        >
          <Info className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-sm leading-relaxed">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * FormRow — horizontal field layout: 140px label column on the left, input
 * on the right. Hint text moves to a tooltip icon next to the label;
 * inline error/warning sits below the input. Each row occupies ~28px
 * (one line) instead of the previous ~72px stacked Label/Input/Hint.
 */
function FormRow({
  label,
  error,
  warning,
  hint,
  children,
}: {
  label: string
  error?: string
  warning?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-start gap-3 py-1.5">
      <Label className="flex h-9 items-center gap-1.5 text-sm font-medium text-foreground/85">
        <span>{label}</span>
        {hint && <InfoTooltip>{hint}</InfoTooltip>}
      </Label>
      <div className="min-w-0 space-y-1">
        {children}
        {error && <FieldError error={error} />}
        {!error && warning && <FieldSoftWarning warning={warning} />}
      </div>
    </div>
  )
}

function TestReachabilityButton({
  vmIp,
  metricsPort,
  reachability,
  onTest,
}: {
  vmIp: string
  metricsPort: string
  reachability: ReachabilityStatus | null
  onTest: () => void
}) {
  const port = parseInt(metricsPort, 10)
  const canTest = !!vmIp && !Number.isNaN(port) && port > 0

  if (!canTest) return null

  if (reachability?.checking) {
    return (
      <Button type="button" variant="outline" size="sm" disabled className="shrink-0 gap-1.5 font-mono text-xs">
        <Loader2 className="size-3 animate-spin" />
        Checking…
      </Button>
    )
  }

  if (reachability?.reachable && !reachability.checking) {
    return (
      <Button type="button" variant="outline" size="sm"
        className="shrink-0 gap-1.5 border-emerald-500/50 bg-emerald-500/10 font-mono text-xs text-emerald-400">
        <CheckCircle className="size-3" />
        Reachable
      </Button>
    )
  }

  return (
    <Button type="button" size="sm" onClick={onTest}
      className="shrink-0 gap-1.5 border border-emerald-500/50 bg-emerald-500/10 font-mono text-xs text-emerald-400 hover:border-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300">
      <Signal className="size-3" />
      Test
    </Button>
  )
}

function ReachabilityIndicator({ status }: { status: ReachabilityStatus | null }) {
  if (!status) return null
  if (status.checking) return (
    <span className="flex items-center gap-1.5 text-xs text-amber-400">
      <Loader2 className="size-3 animate-spin" />Checking…
    </span>
  )
  if (status.reachable) return (
    <span className="flex items-center gap-1.5 text-xs text-emerald-400">
      <CheckCircle className="size-3" />Reachable
    </span>
  )
  return (
    <span className="flex items-center gap-1.5 text-xs text-rose-400">
      <XCircle className="size-3" />{status.error ?? 'Unreachable'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// CPS ↔ BHCC bidirectional sub-component
// ---------------------------------------------------------------------------

/**
 * TrafficRateField — single FormRow that combines CPS, BHCC (auto-derived
 * sibling input), and Hold Time. Replaces what used to be three separate
 * stacked rows. Either CPS or BHCC may be edited; the other auto-syncs.
 * Hold time has its own small input with an "s" suffix.
 */
function CpsBhccField({
  cps,
  onCpsChange,
  error,
  warning,
  onBlur,
  holdSeconds,
  onHoldChange,
  onHoldBlur,
  holdError,
  holdWarning,
}: {
  cps: string
  onCpsChange: (v: string) => void
  error?: string
  warning?: string
  onBlur: () => void
  holdSeconds: string
  onHoldChange: (v: string) => void
  onHoldBlur: () => void
  holdError?: string
  holdWarning?: string
}) {
  // 'cps' or 'bhcc' — which input the user last typed in
  const [inputMode, setInputMode] = useState<'cps' | 'bhcc'>('cps')
  const [bhccDraft, setBhccDraft] = useState('')

  const handleCpsChange = (v: string) => {
    setInputMode('cps')
    onCpsChange(v)
    const c = parseFloat(v)
    setBhccDraft(Number.isFinite(c) && c > 0 ? String(Math.round(c * 3600)) : '')
  }

  const handleBhccChange = (v: string) => {
    setInputMode('bhcc')
    setBhccDraft(v)
    const b = parseInt(v, 10)
    if (Number.isFinite(b) && b > 0) {
      const derivedCps = Math.ceil(b / 3600 * 100) / 100
      onCpsChange(String(derivedCps))
    }
  }

  const cpsNum = parseFloat(cps)
  const bhccNum = Number.isFinite(cpsNum) && cpsNum > 0 ? Math.round(cpsNum * 3600) : null
  const bhccValue = inputMode === 'bhcc' ? bhccDraft : (bhccNum ? String(bhccNum) : '')

  return (
    <FormRow
      label="Traffic"
      error={error}
      warning={warning}
      hint="Call rate (CPS = calls/sec or BHCC = calls/hour, either auto-derives the other) and hold time per call (seconds before BYE is sent)."
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          type="number"
          min={0.01}
          step={0.1}
          value={cps}
          onChange={(ev) => handleCpsChange(ev.target.value)}
          onBlur={onBlur}
          className={cn(
            'w-16 font-mono',
            inputMode === 'cps' ? 'ring-1 ring-emerald-500/40' : '',
          )}
        />
        <span className="text-xs font-medium text-slate-400">cps</span>
        <span className="text-slate-500">·</span>
        <Input
          type="number"
          min={1}
          step={1}
          value={bhccValue}
          onChange={(ev) => handleBhccChange(ev.target.value)}
          onBlur={onBlur}
          className={cn(
            'w-20 font-mono',
            inputMode === 'bhcc' ? 'ring-1 ring-amber-500/40' : '',
          )}
          placeholder={bhccNum ? String(bhccNum) : '—'}
        />
        <span className="text-xs font-medium text-slate-400">bhcc</span>
        <span className="text-slate-500">·</span>
        <span className="text-xs font-medium text-slate-400">call hold time</span>
        <Input
          type="number"
          min={0}
          value={holdSeconds}
          onChange={(ev) => onHoldChange(ev.target.value)}
          onBlur={onHoldBlur}
          className="w-14 font-mono"
          aria-invalid={!!holdError ? true : undefined}
        />
        <span className="text-xs font-medium text-slate-400">s</span>
        {bhccNum !== null && (
          <span className="ml-1 font-mono text-xs text-amber-400/80">
            ≈ <span className="font-bold text-amber-400">{bhccNum.toLocaleString()}</span>/hr
          </span>
        )}
      </div>
      {holdError && <FieldError error={holdError} />}
      {!holdError && holdWarning && <FieldSoftWarning warning={holdWarning} />}
    </FormRow>
  )
}

// ---------------------------------------------------------------------------
// HASection — HA Mode selector + zone configuration
// ---------------------------------------------------------------------------

function HASection({
  raw,
  onChange,
  onBlur,
  errors,
  touched,
}: {
  raw: RawVMFormValues
  onChange: VMConfigPanelProps['onChange']
  onBlur: VMConfigPanelProps['onBlur']
  errors: Record<string, string>
  touched: Set<string>
}) {
  const e = (field: string) => (touched.has(field) ? errors[field] : undefined)
  const t = (field: string) => touched.has(field)

  const effectiveHAMode: 'single' | 'dual' | 'multi_zone' =
    raw.ha_mode || (raw.dual_registration_enabled ? 'dual' : 'single')

  // Zone controller state management
  const parseZoneConfig = () => {
    try {
      if (raw.zone_config_json) return JSON.parse(raw.zone_config_json)
    } catch { /* ignore */ }
    return { zones: [{ zone_id: 'zone-a', controllers: [{ host: '', port: 5060 }] }, { zone_id: 'zone-b', controllers: [{ host: '', port: 5060 }] }], zone_distribution_pct: 50 }
  }

  const zoneConfig = parseZoneConfig()
  const zoneDistPct: number = zoneConfig.zone_distribution_pct ?? 50
  const zoneAControllers: Array<{ host: string; port: number }> =
    zoneConfig.zones?.find((z: { zone_id?: string }) => z.zone_id === 'zone-a')?.controllers ?? [{ host: '', port: 5060 }]
  const zoneBControllers: Array<{ host: string; port: number }> =
    zoneConfig.zones?.find((z: { zone_id?: string }) => z.zone_id === 'zone-b')?.controllers ?? [{ host: '', port: 5060 }]

  const serializeZoneConfig = (
    aControllers: Array<{ host: string; port: number }>,
    bControllers: Array<{ host: string; port: number }>,
    distPct: number,
  ) => {
    const cleanControllers = (controllers: Array<{ host: string; port: number }>) =>
      controllers
        .map((c) => ({ host: c.host.trim(), port: c.port || 5060 }))
        .filter((c) => c.host !== '')
    const zones = [
      { zone_id: 'zone-a', controllers: cleanControllers(aControllers) },
      { zone_id: 'zone-b', controllers: cleanControllers(bControllers) },
    ].filter((z) => z.controllers.length > 0)
    const config = {
      zones,
      zone_distribution_pct: distPct,
    }
    onChange('zone_config_json', JSON.stringify(config))
  }

  const handleZoneDistChange = (val: number) => {
    serializeZoneConfig(zoneAControllers, zoneBControllers, val)
  }

  const updateZoneAController = (i: number, field: 'host' | 'port', value: string) => {
    const updated = [...zoneAControllers]
    updated[i] = { ...updated[i], [field]: field === 'port' ? (parseInt(value) || 0) : value }
    serializeZoneConfig(updated, zoneBControllers, zoneDistPct)
  }
  const updateZoneBController = (i: number, field: 'host' | 'port', value: string) => {
    const updated = [...zoneBControllers]
    updated[i] = { ...updated[i], [field]: field === 'port' ? (parseInt(value) || 0) : value }
    serializeZoneConfig(zoneAControllers, updated, zoneDistPct)
  }
  const addZoneAController = () => serializeZoneConfig([...zoneAControllers, { host: '', port: 5060 }], zoneBControllers, zoneDistPct)
  const addZoneBController = () => serializeZoneConfig(zoneAControllers, [...zoneBControllers, { host: '', port: 5060 }], zoneDistPct)
  const removeZoneAController = (i: number) => serializeZoneConfig(zoneAControllers.filter((_, idx) => idx !== i), zoneBControllers, zoneDistPct)
  const removeZoneBController = (i: number) => serializeZoneConfig(zoneAControllers, zoneBControllers.filter((_, idx) => idx !== i), zoneDistPct)

  return (
    <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-3">
      <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-sky-300">
        <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
        Remote Server HA
      </div>

      {/* HA Mode selector */}
      <div className="flex items-center gap-2 mb-4">
        <span className="text-xs font-medium text-muted-foreground">HA Mode:</span>
        <div className="flex rounded-lg border border-slate-700 overflow-hidden">
          {(['single', 'dual', 'multi_zone'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => {
                onChange('ha_mode', mode)
                if (mode === 'dual') {
                  onChange('dual_registration_enabled', true)
                } else {
                  onChange('dual_registration_enabled', false)
                }
              }}
              className={cn(
                'px-3 py-1.5 text-xs font-medium transition-colors',
                effectiveHAMode === mode
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-950 text-slate-300 hover:bg-slate-800',
              )}
            >
              {mode === 'single' ? 'Single Controller' : mode === 'dual' ? 'Dual Controller' : 'Multi-Zone HA'}
            </button>
          ))}
        </div>
      </div>

      {/* Single mode — primary controller fields only */}
      {effectiveHAMode === 'single' && (
        <div className="space-y-2 rounded-md border border-slate-700/50 bg-slate-950/20 p-2.5">
          <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Primary Controller</div>
          <div className="space-y-1">
            <div className="text-xs font-semibold text-slate-400">Host</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Input
                value={raw.sbc_host}
                onChange={(ev) => onChange('sbc_host', ev.target.value)}
                onBlur={() => onBlur('sbc_host')}
                placeholder="x.x.x.x"
                className="w-40 font-mono"
                aria-invalid={t('sbc_host') && !!errors.sbc_host ? true : undefined}
              />
              <span className="text-slate-500">:</span>
              <Input
                type="number"
                value={raw.sbc_port}
                onChange={(ev) => onChange('sbc_port', ev.target.value)}
                onBlur={() => onBlur('sbc_port')}
                placeholder="5060"
                className="w-16 font-mono"
                aria-invalid={t('sbc_port') && !!errors.sbc_port ? true : undefined}
              />
              <Select
                value={raw.sip_transport}
                onValueChange={(v) => {
                  const transport = v as SipTransport
                  onChange('sip_transport', transport)
                  if (transport === 'TLS') onChange('sbc_port', '5061')
                  if (transport === 'TCP') {
                    onChange('sbc_port', '5060')
                    onChange('sip_scheme', 'SIP')
                    onBlur('sip_scheme')
                  }
                  onBlur('sip_transport')
                  onBlur('sbc_port')
                }}
              >
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="TCP">TCP</SelectItem>
                  <SelectItem value="TLS">TLS</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(e('sbc_host') || e('sbc_port') || e('sip_transport')) && (
              <>
                {e('sbc_host')      && <FieldError error={e('sbc_host')} />}
                {e('sbc_port')      && <FieldError error={e('sbc_port')} />}
                {e('sip_transport') && <FieldError error={e('sip_transport')} />}
              </>
            )}
          </div>
          <div className="space-y-1">
            <div className="text-xs font-semibold text-slate-400">Identity</div>
            <div className="flex flex-wrap items-center gap-1.5">
              <Select
                value={raw.sip_scheme}
                onValueChange={(v) => {
                  const scheme = v as SipScheme
                  onChange('sip_scheme', scheme)
                  if (scheme === 'SIPS') {
                    onChange('sip_transport', 'TLS')
                    onChange('sbc_port', '5061')
                    onBlur('sip_transport')
                    onBlur('sbc_port')
                  }
                  onBlur('sip_scheme')
                }}
              >
                <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="SIP">SIP</SelectItem>
                  <SelectItem value="SIPS">SIPS</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={raw.domain}
                onChange={(ev) => onChange('domain', ev.target.value)}
                onBlur={() => onBlur('domain')}
                placeholder="avaya.com"
                className="w-32 font-mono"
                aria-invalid={t('domain') && !!errors.domain ? true : undefined}
              />
            </div>
            {(e('sip_scheme') || e('domain')) && (
              <>
                {e('sip_scheme') && <FieldError error={e('sip_scheme')} />}
                {e('domain')     && <FieldError error={e('domain')} />}
              </>
            )}
            {raw.sip_scheme === 'SIPS' && raw.sip_transport !== 'TLS' && (
              <FieldError error="SIPS requires TLS transport." />
            )}
          </div>
        </div>
      )}

      {/* Dual mode — primary + secondary columns */}
      {effectiveHAMode === 'dual' && (
        <div className="grid gap-3 xl:grid-cols-2">
          <div className="space-y-2 rounded-md border border-slate-700/50 bg-slate-950/20 p-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Primary Controller</div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-400">Prim. Host</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  value={raw.sbc_host}
                  onChange={(ev) => onChange('sbc_host', ev.target.value)}
                  onBlur={() => onBlur('sbc_host')}
                  placeholder="x.x.x.x"
                  className="w-40 font-mono"
                  aria-invalid={t('sbc_host') && !!errors.sbc_host ? true : undefined}
                />
                <span className="text-slate-500">:</span>
                <Input
                  type="number"
                  value={raw.sbc_port}
                  onChange={(ev) => onChange('sbc_port', ev.target.value)}
                  onBlur={() => onBlur('sbc_port')}
                  placeholder="5060"
                  className="w-16 font-mono"
                  aria-invalid={t('sbc_port') && !!errors.sbc_port ? true : undefined}
                />
                <Select
                  value={raw.sip_transport}
                  onValueChange={(v) => {
                    const transport = v as SipTransport
                    onChange('sip_transport', transport)
                    if (transport === 'TLS') onChange('sbc_port', '5061')
                    if (transport === 'TCP') {
                      onChange('sbc_port', '5060')
                      onChange('sip_scheme', 'SIP')
                      onBlur('sip_scheme')
                    }
                    onBlur('sip_transport')
                    onBlur('sbc_port')
                  }}
                >
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="TCP">TCP</SelectItem>
                    <SelectItem value="TLS">TLS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {(e('sbc_host') || e('sbc_port') || e('sip_transport')) && (
                <>
                  {e('sbc_host')      && <FieldError error={e('sbc_host')} />}
                  {e('sbc_port')      && <FieldError error={e('sbc_port')} />}
                  {e('sip_transport') && <FieldError error={e('sip_transport')} />}
                </>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-400">Identity</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Select
                  value={raw.sip_scheme}
                  onValueChange={(v) => {
                    const scheme = v as SipScheme
                    onChange('sip_scheme', scheme)
                    if (scheme === 'SIPS') {
                      onChange('sip_transport', 'TLS')
                      onChange('sbc_port', '5061')
                      onBlur('sip_transport')
                      onBlur('sbc_port')
                    }
                    onBlur('sip_scheme')
                  }}
                >
                  <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SIP">SIP</SelectItem>
                    <SelectItem value="SIPS">SIPS</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={raw.domain}
                  onChange={(ev) => onChange('domain', ev.target.value)}
                  onBlur={() => onBlur('domain')}
                  placeholder="avaya.com"
                  className="w-32 font-mono"
                  aria-invalid={t('domain') && !!errors.domain ? true : undefined}
                />
              </div>
              {(e('sip_scheme') || e('domain')) && (
                <>
                  {e('sip_scheme') && <FieldError error={e('sip_scheme')} />}
                  {e('domain')     && <FieldError error={e('domain')} />}
                </>
              )}
              {raw.sip_scheme === 'SIPS' && raw.sip_transport !== 'TLS' && (
                <FieldError error="SIPS requires TLS transport." />
              )}
            </div>
          </div>

          <div className="space-y-2 rounded-md border border-slate-700/50 bg-slate-950/20 p-2.5">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-300">Secondary Controller</div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-400">Sec. Host</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Input
                  value={raw.secondary_host}
                  onChange={(ev) => onChange('secondary_host', ev.target.value)}
                  onBlur={() => onBlur('secondary_host')}
                  placeholder="x.x.x.x"
                  className="w-40 font-mono"
                />
                <span className="text-slate-500">:</span>
                <Input
                  type="number"
                  value={raw.secondary_port}
                  onChange={(ev) => onChange('secondary_port', ev.target.value)}
                  onBlur={() => onBlur('secondary_port')}
                  placeholder={raw.sip_transport === 'TLS' ? '5061' : '5060'}
                  className="w-16 font-mono"
                />
                <span className="rounded border border-slate-700 bg-slate-900/50 px-2.5 py-1 text-xs font-semibold text-slate-300">
                  {raw.sip_transport}
                </span>
              </div>
              {(e('secondary_host') || e('secondary_port')) && (
                <>
                  {e('secondary_host') && <FieldError error={e('secondary_host')} />}
                  {e('secondary_port') && <FieldError error={e('secondary_port')} />}
                </>
              )}
            </div>
            <div className="space-y-1">
              <div className="text-xs font-semibold text-slate-400">Failover Mode</div>
              <Select
                value={raw.failover_mode}
                onValueChange={(v) => onChange('failover_mode', v as 'graceful' | 'force')}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="graceful">Graceful Failover</SelectItem>
                  <SelectItem value="force">Force Failover</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1 rounded-md border border-slate-800/70 bg-slate-950/30 p-2">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-300">
                <Switch
                  checked={raw.auto_failback_enabled}
                  onCheckedChange={(checked) => onChange('auto_failback_enabled', checked)}
                />
                Auto failback to primary
              </label>
              <div className="flex items-center gap-2 pl-10">
                <Input
                  type="number"
                  min={1}
                  max={3600}
                  value={raw.failback_delay_seconds}
                  onChange={(ev) => onChange('failback_delay_seconds', ev.target.value)}
                  onBlur={() => onBlur('failback_delay_seconds')}
                  className="w-20 font-mono"
                  disabled={!raw.auto_failback_enabled}
                />
                <span className="text-xs text-slate-400">seconds after primary recovery</span>
              </div>
              {e('failback_delay_seconds') && <FieldError error={e('failback_delay_seconds')} />}
              {raw.auto_failback_enabled && (
                <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200">
                  Lab caution: auto failback moves subscriptions back to primary after recovery delay. Validate manual failback first.
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Multi-Zone Configuration */}
      {effectiveHAMode === 'multi_zone' && (
        <div className="space-y-4 rounded-lg border border-violet-500/30 bg-violet-950/5 p-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-violet-300">Multi-Zone Configuration</h4>
          </div>

          {/* Zone distribution slider */}
          <div className="flex items-center gap-3">
            <span className="text-xs text-slate-400 w-20">Zone-A: {zoneDistPct}%</span>
            <input
              type="range" min="10" max="90" step="5"
              value={zoneDistPct}
              onChange={(ev) => handleZoneDistChange(Number(ev.target.value))}
              className="flex-1 accent-violet-500"
            />
            <span className="text-xs text-slate-400 w-20 text-right">Zone-B: {100 - zoneDistPct}%</span>
          </div>

          {/* Two zone columns */}
          <div className="grid grid-cols-2 gap-4">
            {/* Zone-A */}
            <div className="space-y-3">
              <h5 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Zone-A</h5>
              {zoneAControllers.map((ctrl: { host: string; port: number }, i: number) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input
                    value={ctrl.host}
                    onChange={(ev) => updateZoneAController(i, 'host', ev.target.value)}
                    placeholder="Host"
                    className="flex-1 font-mono text-xs"
                  />
                  <Input
                    value={String(ctrl.port)}
                    onChange={(ev) => updateZoneAController(i, 'port', ev.target.value)}
                    placeholder="Port"
                    className="w-20 font-mono text-xs"
                    type="number"
                  />
                  {zoneAControllers.length > 1 && (
                    <button type="button" onClick={() => removeZoneAController(i)} className="text-rose-400 hover:text-rose-300 text-lg leading-none">×</button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addZoneAController} className="text-xs text-violet-400 hover:text-violet-300">
                + Add Controller
              </button>
            </div>

            {/* Zone-B */}
            <div className="space-y-3">
              <h5 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">Zone-B</h5>
              {zoneBControllers.map((ctrl: { host: string; port: number }, i: number) => (
                <div key={i} className="flex gap-2 items-center">
                  <Input
                    value={ctrl.host}
                    onChange={(ev) => updateZoneBController(i, 'host', ev.target.value)}
                    placeholder="Host"
                    className="flex-1 font-mono text-xs"
                  />
                  <Input
                    value={String(ctrl.port)}
                    onChange={(ev) => updateZoneBController(i, 'port', ev.target.value)}
                    placeholder="Port"
                    className="w-20 font-mono text-xs"
                    type="number"
                  />
                  {zoneBControllers.length > 1 && (
                    <button type="button" onClick={() => removeZoneBController(i)} className="text-rose-400 hover:text-rose-300 text-lg leading-none">×</button>
                  )}
                </div>
              ))}
              <button type="button" onClick={addZoneBController} className="text-xs text-violet-400 hover:text-violet-300">
                + Add Controller
              </button>
            </div>
          </div>

          {/* Shared settings */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-700/30">
            <div>
              <label className="text-[11px] text-muted-foreground">Failover Mode</label>
              <Select
                value={raw.failover_mode || 'graceful'}
                onValueChange={(v) => onChange('failover_mode', v as 'graceful' | 'force')}
              >
                <SelectTrigger className="w-full mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="graceful">Graceful</SelectItem>
                  <SelectItem value="force">Force</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2 pt-4">
              <Switch
                checked={raw.auto_failback_enabled}
                onCheckedChange={(checked) => onChange('auto_failback_enabled', checked)}
              />
              <span className="text-xs">Auto Failback ({raw.failback_delay_seconds || '30'}s)</span>
            </div>
          </div>

          {/* Failover Trigger */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-slate-700/30">
            <div>
              <label className="text-[11px] text-muted-foreground">Failover Trigger</label>
              <Select
                value={raw.failover_trigger || 'per_agent'}
                onValueChange={(v) => onChange('failover_trigger', v as 'per_agent' | 'min_agents' | 'pct_agents')}
              >
                <SelectTrigger className="w-full mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_agent">Per Agent (individual)</SelectItem>
                  <SelectItem value="min_agents">Minimum Agents</SelectItem>
                  <SelectItem value="pct_agents">% of Agents</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {raw.failover_trigger === 'min_agents' && (
              <div>
                <label className="text-[11px] text-muted-foreground">Min Agent Count</label>
                <input
                  type="number" min="2" max="10000"
                  value={raw.failover_trigger_count}
                  onChange={(ev) => onChange('failover_trigger_count', ev.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
                />
              </div>
            )}
            {raw.failover_trigger === 'pct_agents' && (
              <div>
                <label className="text-[11px] text-muted-foreground">Agent % (whole number)</label>
                <input
                  type="number" min="1" max="100" step="1"
                  value={raw.failover_trigger_pct}
                  onChange={(ev) => onChange('failover_trigger_pct', ev.target.value)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
                />
              </div>
            )}
            {(raw.failover_trigger === 'min_agents' || raw.failover_trigger === 'pct_agents') && (
              <div className="col-span-2">
                <label className="text-[11px] text-muted-foreground">Time Window (ms)</label>
                <input
                  type="number" min="100" max="60000" step="100"
                  value={raw.failover_trigger_window_ms}
                  onChange={(ev) => onChange('failover_trigger_window_ms', ev.target.value)}
                  className="mt-1 w-40 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200"
                />
                <span className="ml-2 text-[10px] text-slate-500">Resets within this window count toward threshold</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel — unified "User Agent (UA)" — no UAC/UAS branching
// ---------------------------------------------------------------------------

export function VMConfigPanel({
  raw,
  onChange,
  touched,
  onBlur,
  errors,
  warnings,
  reachability,
  onCheckReachability,
  onResetSection,
  tab = 'all',
}: VMConfigPanelProps) {
  // Tab gates — each section renders only when its tab is selected.
  // 'all' (the default) renders every section so the legacy single-page
  // layout still works for any caller that doesn't pass a tab prop.
  const showServer    = tab === 'all' || tab === 'server'
  const showSignaling = tab === 'all' || tab === 'signaling'
  const showTraffic   = tab === 'all' || tab === 'traffic'
  const showMedia     = tab === 'all' || tab === 'media'
  const e = (field: string) => (touched.has(field) ? errors[field] : undefined)
  const w = (field: string) => (touched.has(field) ? warnings[field] : undefined)
  const t = (field: string) => touched.has(field)

  const extCount = parseInt(raw.ext_count) || 0
  const [tlsBusy, setTLSBusy] = useState<string | null>(null)
  const [tlsVerify, setTLSVerify] = useState<TLSVerifyResult | null>(null)
  const [tlsUploadError, setTLSUploadError] = useState<string | null>(null)
  const [vipBusy, setVIPBusy] = useState<'verify' | 'apply' | null>(null)
  const [vipResult, setVIPResult] = useState<VIPResult | null>(null)
  const [vipError, setVIPError] = useState<string | null>(null)
  const uploadTLSFile = async (kind: 'ca' | 'client_cert' | 'client_key', file?: File) => {
    if (!file) return
    setTLSBusy(kind)
    setTLSUploadError(null)
    setTLSVerify(null)
    try {
      const result = await uploadCertificateFor(raw.vm_ip || '127.0.0.1', parseInt(raw.metrics_port) || 8082, kind, file)
      if (kind === 'ca') onChange('tls_ca_path', result.path)
      if (kind === 'client_cert') onChange('tls_cert_path', result.path)
      if (kind === 'client_key') onChange('tls_key_path', result.path)
    } catch (err) {
      setTLSUploadError(err instanceof Error ? err.message : 'Certificate upload failed')
    } finally {
      setTLSBusy(null)
    }
  }
  const tlsVerifyBlocked =
    raw.sip_transport === 'TLS' &&
    ((raw.tls_mode === 'server_ca' || raw.tls_mode === 'mutual') && !raw.tls_ca_path ||
      (raw.tls_mode === 'client_cert' || raw.tls_mode === 'mutual') && (!raw.tls_cert_path || !raw.tls_key_path))
  const verifyTLS = async () => {
    if (tlsVerifyBlocked) {
      setTLSVerify({ ok: false, error: 'Upload the required TLS certificate/key files before testing TLS' })
      return
    }
    setTLSBusy('verify')
    setTLSVerify(null)
    try {
      const result = await verifyTLSFor(raw.vm_ip || '127.0.0.1', parseInt(raw.metrics_port) || 8082, {
        vm_id: raw.vm_id,
        sbc_host: raw.sbc_host,
        sbc_port: parseInt(raw.sbc_port) || 5061,
        tls_mode: raw.tls_mode,
        tls_ca_path: raw.tls_ca_path,
        tls_cert_path: raw.tls_cert_path,
        tls_key_path: raw.tls_key_path,
        tls_server_name: raw.tls_server_name,
        tls_min_version: raw.tls_min_version,
        tls_max_version: raw.tls_max_version,
      })
      setTLSVerify(result)
    } catch (err) {
      setTLSVerify({ ok: false, error: err instanceof Error ? err.message : 'TLS verification failed' })
    } finally {
      setTLSBusy(null)
    }
  }

  const handleIpBlur = () => {
    onBlur('vm_ip')
    if (raw.vm_ip && raw.metrics_port) onCheckReachability()
  }

  const handleMetricsPortBlur = () => {
    onBlur('metrics_port')
    if (raw.vm_ip && raw.metrics_port) onCheckReachability()
  }

  const vipPayload = () => ({
    vip_interface: raw.vip_interface,
    vip_cidr: raw.vip_cidr,
    vip_first_ip: raw.vip_first_ip,
    vip_count: parseInt(raw.vip_count) || 0,
    vip_gateway_ip: raw.vip_gateway_ip || undefined,
    vip_sanity_target_ip: raw.vip_sanity_target_ip || raw.sbc_host || undefined,
  })

  const handleVIPAction = async (action: 'verify' | 'apply') => {
    setVIPBusy(action)
    setVIPResult(null)
    setVIPError(null)
    try {
      const fn = action === 'verify' ? verifyVIPsFor : applyVIPsFor
      const result = await fn(raw.vm_ip || '127.0.0.1', parseInt(raw.metrics_port) || 8082, vipPayload())
      setVIPResult(result)
    } catch (err) {
      setVIPError(err instanceof Error ? err.message : 'VIP operation failed')
    } finally {
      setVIPBusy(null)
    }
  }

  const ptimeNum = parseInt(raw.rtp_ptime, 10) || 20
  const ppsDisplay = Math.round(1000 / ptimeNum)

  // SUB Expires used to be hidden behind a "Customise" toggle that synced
  // it to REG Expires when off. Per UX feedback the field is now always
  // shown as a normal input alongside REG so the two fields look symmetric.

  // Heuristic for "is this a local target?" — used to hide SSH credentials
  // when they're irrelevant. Loopback or empty IP means same-host execution
  // (the engine binary runs alongside the GUI, no SSH needed).
  const isLocalAgent =
    !raw.vm_ip || raw.vm_ip === '127.0.0.1' || raw.vm_ip === 'localhost' || raw.vm_ip === '::1'

  // Hide SSH fields when local OR when neither has been touched/customised.
  // If the user previously typed a value, surface it again so they can clear/
  // edit it — never silently drop their input.
  const showSSHFields =
    !isLocalAgent || !!raw.ssh_user || !!raw.ssh_key_path

  // Heuristic: looks like a numeric IPv4/IPv6. When sbc_host is a literal
  // address, custom DNS resolution is irrelevant. Show DNS only for FQDNs
  // or when the user has previously set a value.
  const isLiteralIP = (h: string) =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || /^[0-9a-fA-F:]+$/.test(h)
  const showDNSField = !isLiteralIP(raw.sbc_host || '') || !!raw.dns_servers
  const effectiveHAMode: 'single' | 'dual' | 'multi_zone' =
    raw.ha_mode || (raw.dual_registration_enabled ? 'dual' : 'single')

  const assignmentZoneConfig = (() => {
    try {
      if (raw.zone_config_json) return JSON.parse(raw.zone_config_json)
    } catch { /* ignore */ }
    return { zones: [], zone_distribution_pct: 50 }
  })()
  type StaticAssignmentRow = {
    ext_start: number
    ext_end: number
    ext_count?: number
    primary_zone_id: string
    primary_controller: { host: string; port: number }
    secondary_zone_id?: string
    secondary_controller?: { host: string; port: number }
  }
  type ControllerOption = {
    value: string
    label: string
    zone_id: string
    controller: { host: string; port: number }
  }
  const staticRows: StaticAssignmentRow[] = (() => {
    try {
      const parsed = raw.static_agent_assignments_json ? JSON.parse(raw.static_agent_assignments_json) : []
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  })()
  const controllerOptions: ControllerOption[] = (assignmentZoneConfig.zones ?? []).flatMap((zone: { zone_id?: string; controllers?: Array<{ host: string; port: number }> }) =>
    (zone.controllers ?? []).map((ctrl) => ({
      value: `${zone.zone_id ?? ''}|${ctrl.host}|${ctrl.port}`,
      label: `${zone.zone_id ?? 'zone'} / ${ctrl.host}:${ctrl.port}`,
      zone_id: zone.zone_id ?? '',
      controller: { host: ctrl.host, port: ctrl.port },
    })),
  )
  const controllerValue = (zoneID?: string, ctrl?: { host?: string; port?: number }) =>
    ctrl?.host ? `${zoneID ?? ''}|${ctrl.host}|${ctrl.port ?? 5060}` : ''
  const serializeStaticRows = (rows: StaticAssignmentRow[]) => {
    const normalized = rows
      .map((row) => {
        const start = Number(row.ext_start) || 0
        const end = Number(row.ext_end) || (start > 0 && row.ext_count ? start + Number(row.ext_count) - 1 : 0)
        const count = start > 0 && end >= start ? end - start + 1 : (Number(row.ext_count) || 0)
        return { ...row, ext_start: start, ext_end: end, ext_count: count }
      })
      .filter((row) => row.ext_start > 0 || row.ext_end > 0 || row.primary_controller?.host)
    onChange('static_agent_assignments_json', normalized.length ? JSON.stringify(normalized) : '')
    if (normalized.length > 0) {
      const starts = normalized.map((row) => row.ext_start).filter((v) => v > 0)
      const ends = normalized.map((row) => row.ext_end).filter((v) => v > 0)
      const total = normalized.reduce((sum, row) => sum + (row.ext_count || Math.max(0, row.ext_end - row.ext_start + 1)), 0)
      if (starts.length > 0 && ends.length > 0) {
        onChange('ext_start', String(Math.min(...starts)))
        onChange('ext_count', String(total))
      }
    }
  }
  const updateStaticRow = (idx: number, patch: Partial<StaticAssignmentRow>) => {
    const rows = staticRows.map((row, i) => i === idx ? { ...row, ...patch } : row)
    serializeStaticRows(rows)
  }
  const applyControllerSelection = (idx: number, role: 'primary' | 'secondary', value: string) => {
    const option = controllerOptions.find((opt) => opt.value === value)
    if (!option) {
      if (role === 'secondary') {
        updateStaticRow(idx, { secondary_zone_id: '', secondary_controller: undefined })
      }
      return
    }
    if (role === 'primary') {
      updateStaticRow(idx, { primary_zone_id: option.zone_id, primary_controller: option.controller })
    } else {
      updateStaticRow(idx, { secondary_zone_id: option.zone_id, secondary_controller: option.controller })
    }
  }
  const addStaticRow = () => {
    const start = staticRows.length > 0 ? Math.max(...staticRows.map((row) => row.ext_end || row.ext_start || 0)) + 1 : (parseInt(raw.ext_start) || 4001000)
    const count = parseInt(raw.ext_count) || 10
    serializeStaticRows([
      ...staticRows,
      {
        ext_start: start,
        ext_count: count,
        ext_end: start + count - 1,
        primary_zone_id: controllerOptions[0]?.zone_id ?? '',
        primary_controller: controllerOptions[0]?.controller ?? { host: '', port: 5060 },
      },
    ])
  }
  const removeStaticRow = (idx: number) => serializeStaticRows(staticRows.filter((_, i) => i !== idx))

  return (
    <div className="space-y-4 px-4 py-4">

      {/* Identity (vm_id) is now click-to-edit inline in the UA card header
          — see VMPairBook.tsx. The dedicated Identity section was removed
          since it held only one field. */}

      {/* ── Traffic Agent Host (Server tab) ──────────────────── */}
      {showServer && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.agent_host)}>Traffic Agent Host</SectionHeader>
        {/* Agent endpoint — IP : Port + Test button + reachability all on
            one row. Reads naturally as "127.0.0.1 : 8082 [Test ✓]". */}
        <FormRow
          label="Agent"
          hint="IP and metrics port the GUI uses to reach the traffic agent. Click Test to verify."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={raw.vm_ip}
              onChange={(ev) => onChange('vm_ip', ev.target.value)}
              onBlur={handleIpBlur}
              placeholder="127.0.0.1"
              className="w-36 font-mono"
              aria-invalid={t('vm_ip') && !!errors.vm_ip ? true : undefined}
            />
            <span className="text-slate-500">:</span>
            <Input
              type="number"
              value={raw.metrics_port}
              onChange={(ev) => onChange('metrics_port', ev.target.value)}
              onBlur={handleMetricsPortBlur}
              placeholder="8082"
              className="w-20 font-mono"
              aria-invalid={t('metrics_port') && !!errors.metrics_port ? true : undefined}
            />
            <TestReachabilityButton
              vmIp={raw.vm_ip}
              metricsPort={raw.metrics_port}
              reachability={reachability}
              onTest={onCheckReachability}
            />
            {reachability && <ReachabilityIndicator status={reachability} />}
          </div>
          {(e('vm_ip') || e('metrics_port')) && (
            <>
              {e('vm_ip')        && <FieldError error={e('vm_ip')} />}
              {e('metrics_port') && <FieldError error={e('metrics_port')} />}
            </>
          )}
        </FormRow>
        <p className="ml-[160px] pl-3 text-xs text-slate-400">
          Health:{' '}
          <span className="font-mono text-sky-400 underline decoration-sky-400/30 underline-offset-2">
            {`http://${raw.vm_ip || '<ip>'}:${raw.metrics_port || '<port>'}/api/ping`}
          </span>
        </p>
        {/* SSH credentials — auto-hidden when the agent runs locally
            (vm_ip is loopback). Shown automatically as soon as a remote IP
            is entered, or when the user has previously typed a value.
            User + key path packed onto one row (only relevant for remote VMs). */}
        {showSSHFields && (
          <FormRow
            label="SSH"
            error={e('ssh_user') || e('ssh_key_path')}
            hint="User and private-key path for SSH access to a remote VM."
          >
            <div className="flex flex-wrap items-center gap-2">
              <Input
                value={raw.ssh_user}
                onChange={(ev) => onChange('ssh_user', ev.target.value)}
                onBlur={() => onBlur('ssh_user')}
                placeholder="ubuntu"
                className="w-32"
              />
              <Input
                value={raw.ssh_key_path}
                onChange={(ev) => onChange('ssh_key_path', ev.target.value)}
                onBlur={() => onBlur('ssh_key_path')}
                placeholder="/home/user/.ssh/id_rsa"
                className="w-72 font-mono text-xs"
              />
            </div>
          </FormRow>
        )}
      </div>
      )}

      {/* ── Remote SIP Server (Server tab) ──────────────────────── */}
      {showServer && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.sip_server)}>Remote SIP Server</SectionHeader>

        <HASection raw={raw} onChange={onChange} onBlur={onBlur} errors={errors} touched={touched} />

        {raw.sip_transport === 'TLS' && (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              TLS Settings
            </div>
            <FormRow
              label="TLS Mode"
              error={e('tls_mode')}
              hint="Choose how the SBC certificate is validated and whether to present a client cert."
            >
              <Select
                value={raw.tls_mode || 'insecure'}
                onValueChange={(v) => { onChange('tls_mode', v as TLSMode); onBlur('tls_mode') }}
              >
                <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="insecure">Insecure (skip verify) — lab/testing only</SelectItem>
                  <SelectItem value="server_ca">Server CA verification (one-way TLS)</SelectItem>
                  <SelectItem value="client_cert">Client certificate only</SelectItem>
                  <SelectItem value="mutual">Mutual TLS (CA + client cert)</SelectItem>
                </SelectContent>
              </Select>
            </FormRow>

            <FormRow label="TLS Version" error={e('tls_min_version') || e('tls_max_version')} hint="Default supports TLS 1.2 and TLS 1.3, negotiating the highest version supported by the SBC.">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-slate-400">Min</span>
                <Select
                  value={raw.tls_min_version || '1.2'}
                  onValueChange={(v) => { onChange('tls_min_version', v as '1.2' | '1.3'); onBlur('tls_min_version') }}
                >
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1.2">TLS 1.2</SelectItem>
                    <SelectItem value="1.3">TLS 1.3</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-slate-400">Max</span>
                <Select
                  value={raw.tls_max_version || 'auto'}
                  onValueChange={(v) => { onChange('tls_max_version', v as 'auto' | '1.2' | '1.3'); onBlur('tls_max_version') }}
                >
                  <SelectTrigger className="w-28"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="1.2">TLS 1.2</SelectItem>
                    <SelectItem value="1.3">TLS 1.3</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </FormRow>

            {(raw.tls_mode === 'server_ca' || raw.tls_mode === 'mutual') && (
              <FormRow
                label="CA Certificate"
                error={e('tls_ca_path')}
                hint="Upload a CA certificate PEM/CRT from your laptop. The engine stores it under its managed certs/ca directory."
              >
                <Input
                  type="file"
                  accept=".pem,.crt,.cer,.cacrt,.ca"
                  className="w-72 text-xs"
                  disabled={tlsBusy === 'ca'}
                  onChange={(ev) => uploadTLSFile('ca', ev.target.files?.[0])}
                />
                {tlsBusy === 'ca' && <p className="mt-1 text-xs text-slate-400">Uploading CA certificate...</p>}
                {raw.tls_ca_path && <p className="mt-1 text-xs text-emerald-300">CA certificate installed on engine VM.</p>}
                {raw.tls_ca_path && (
                  <details className="mt-2 text-xs text-slate-400">
                    <summary className="cursor-pointer text-slate-500">Advanced: stored CA path</summary>
                    <Input
                      value={raw.tls_ca_path}
                      onChange={(ev) => onChange('tls_ca_path', ev.target.value)}
                      onBlur={() => onBlur('tls_ca_path')}
                      placeholder="certs/ca/ca.pem"
                      className="mt-2 w-72 font-mono text-xs"
                      aria-invalid={t('tls_ca_path') && !!errors.tls_ca_path ? true : undefined}
                    />
                  </details>
                )}
              </FormRow>
            )}

            {(raw.tls_mode === 'client_cert' || raw.tls_mode === 'mutual') && (
              <>
                <FormRow
                  label="Client Certificate"
                  error={e('tls_cert_path')}
                  hint="Upload the tool's client certificate PEM/CRT. The engine stores it under certs/client."
                >
                  <Input
                    type="file"
                    accept=".pem,.crt,.cer,.cacrt,.ca"
                    className="w-72 text-xs"
                    disabled={tlsBusy === 'client_cert'}
                    onChange={(ev) => uploadTLSFile('client_cert', ev.target.files?.[0])}
                  />
                  {tlsBusy === 'client_cert' && <p className="mt-1 text-xs text-slate-400">Uploading client certificate...</p>}
                  {raw.tls_cert_path && <p className="mt-1 text-xs text-emerald-300">Client certificate installed on engine VM.</p>}
                  {raw.tls_cert_path && (
                    <details className="mt-2 text-xs text-slate-400">
                      <summary className="cursor-pointer text-slate-500">Advanced: stored client cert path</summary>
                      <Input
                        value={raw.tls_cert_path}
                        onChange={(ev) => onChange('tls_cert_path', ev.target.value)}
                        onBlur={() => onBlur('tls_cert_path')}
                        placeholder="certs/client/client.crt"
                        className="mt-2 w-72 font-mono text-xs"
                        aria-invalid={t('tls_cert_path') && !!errors.tls_cert_path ? true : undefined}
                      />
                    </details>
                  )}
                </FormRow>
                <FormRow
                  label="Client Private Key"
                  error={e('tls_key_path')}
                  hint="Upload the matching private key PEM. The engine stores it under certs/private with restricted permissions."
                >
                  <Input
                    type="file"
                    accept=".pem,.key"
                    className="w-72 text-xs"
                    disabled={tlsBusy === 'client_key'}
                    onChange={(ev) => uploadTLSFile('client_key', ev.target.files?.[0])}
                  />
                  {tlsBusy === 'client_key' && <p className="mt-1 text-xs text-slate-400">Uploading private key...</p>}
                  {raw.tls_key_path && <p className="mt-1 text-xs text-emerald-300">Private key installed on engine VM.</p>}
                  {raw.tls_key_path && (
                    <details className="mt-2 text-xs text-slate-400">
                      <summary className="cursor-pointer text-slate-500">Advanced: stored private key path</summary>
                      <Input
                        value={raw.tls_key_path}
                        onChange={(ev) => onChange('tls_key_path', ev.target.value)}
                        onBlur={() => onBlur('tls_key_path')}
                        placeholder="certs/private/client.key"
                        className="mt-2 w-72 font-mono text-xs"
                        aria-invalid={t('tls_key_path') && !!errors.tls_key_path ? true : undefined}
                      />
                    </details>
                  )}
                </FormRow>
              </>
            )}

            {raw.tls_mode && raw.tls_mode !== 'insecure' && (
              <FormRow
                label="Server Name / SNI (optional)"
                error={e('tls_server_name')}
                hint="Optional. Use only when connecting by IP or alias but the certificate is issued to a different DNS name."
              >
                <Input
                  value={raw.tls_server_name}
                  onChange={(ev) => onChange('tls_server_name', ev.target.value)}
                  onBlur={() => onBlur('tls_server_name')}
                  placeholder="sbc.example.com"
                  className="w-40 font-mono text-xs"
                />
              </FormRow>
            )}
            <FormRow label="Verify TLS">
              <div className="space-y-2">
                <Button type="button" size="sm" variant="outline" disabled={tlsBusy === 'verify'} onClick={verifyTLS}>
                  {tlsBusy === 'verify' ? 'Testing TLS...' : 'Test TLS'}
                </Button>
                {tlsUploadError && (
                  <div className="rounded-md border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">
                    Certificate upload failed: {tlsUploadError}
                  </div>
                )}
                {tlsVerifyBlocked && !tlsVerify && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
                    Upload the required TLS certificate/key files before testing TLS.
                  </div>
                )}
                {tlsVerify && (
                  <div className={cn('rounded-md border px-3 py-2 text-xs', tlsVerify.ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300')}>
                    {tlsVerify.ok
                      ? `Verified ${tlsVerify.negotiated_version ?? ''} ${tlsVerify.cipher_suite ?? ''}`
                      : `TLS verification failed: ${tlsVerify.error ?? 'unknown error'}`}
                    {tlsVerify.peer_not_after && <div className="mt-1 text-slate-400">Peer cert expires: {tlsVerify.peer_not_after}</div>}
                  </div>
                )}
              </div>
            </FormRow>
          </div>
        )}

        <FormRow label="SIP Password" error={e('sip_password')}>
          <Input
            type="password"
            value={raw.sip_password}
            onChange={(ev) => onChange('sip_password', ev.target.value)}
            onBlur={() => onBlur('sip_password')}
            placeholder="••••••••"
            className="w-36"
            aria-invalid={t('sip_password') && !!errors.sip_password ? true : undefined}
          />
        </FormRow>

        {/* DNS Servers — auto-hidden when sbc_host is a literal IP (no
            resolution needed). Surfaces automatically when an FQDN is used
            or when the user has previously set a value. */}
        {showDNSField && (
          <FormRow
            label="DNS Servers"
            hint="Optional — comma-separated IPs for FQDN resolution. Leave empty to use system DNS."
          >
            <Input
              value={raw.dns_servers}
              onChange={(ev) => onChange('dns_servers', ev.target.value)}
              onBlur={() => onBlur('dns_servers')}
              placeholder="10.0.0.53, 168.63.129.16"
              className="w-72 font-mono text-xs"
            />
          </FormRow>
        )}
      </div>
      )}

      {/* ── Extension Pool (Traffic tab) ───────────────────────── */}
      {showTraffic && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.extension_pool)}>Extension Pool</SectionHeader>
        <FormRow
          label="Pool Size"
          hint="Enter the starting extension and how many extensions to use. The ending extension is calculated automatically."
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-slate-400">Starting Extension</span>
            <Input
              type="number"
              value={raw.ext_start}
              onChange={(ev) => onChange('ext_start', ev.target.value)}
              onBlur={() => onBlur('ext_start')}
              placeholder="4001000"
              className="w-32 font-mono text-xs"
              aria-invalid={t('ext_start') && !!errors.ext_start ? true : undefined}
            />
            <span className="text-xs text-slate-400"># of Extensions</span>
            <Input
              type="number"
              min={2}
              value={raw.ext_count}
              onChange={(ev) => onChange('ext_count', ev.target.value)}
              onBlur={() => onBlur('ext_count')}
              placeholder="10"
              className="w-24 font-mono text-xs"
              aria-invalid={t('ext_count') && !!errors.ext_count ? true : undefined}
            />
            <span className="text-slate-500">·</span>
            <span className="font-mono text-xs text-slate-300">
              {extCount > 0 && raw.ext_start && raw.ext_end
                ? `${raw.ext_start} → ${raw.ext_end} (${extCount} ext)`
                : '—'}
            </span>
          </div>
          {(e('ext_start') || e('ext_count') || e('ext_end')) && null /* errors shown below */}
        </FormRow>
        {/* Inline per-field errors when start/count are individually invalid */}
        {(e('ext_start') || e('ext_count') || e('ext_end')) && (
          <div className="ml-[160px] pl-3 space-y-1">
            {e('ext_start') && <FieldError error={e('ext_start')} />}
            {e('ext_count') && <FieldError error={e('ext_count')} />}
            {e('ext_end')   && <FieldError error={e('ext_end')} />}
          </div>
        )}
        {effectiveHAMode === 'multi_zone' && (
          <div className="rounded-lg border border-violet-500/25 bg-violet-950/10 p-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-violet-300">
                  Static Extension-to-Controller Assignment
                </div>
                <p className="mt-1 text-[11px] text-slate-400">
                  Optional. When rows are present, the engine uses these ranges instead of zone percentage distribution.
                </p>
              </div>
              <button
                type="button"
                onClick={addStaticRow}
                disabled={controllerOptions.length === 0}
                className="rounded border border-violet-500/40 px-2.5 py-1 text-xs text-violet-200 hover:bg-violet-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                + Add Range
              </button>
            </div>
            {staticRows.length > 0 ? (
              <div className="space-y-2">
                <div className="grid grid-cols-[110px_100px_110px_1fr_1fr_44px] gap-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                  <span>Start Ext</span>
                  <span># Ext</span>
                  <span>End Ext</span>
                  <span>Primary Controller</span>
                  <span>Secondary Controller</span>
                  <span />
                </div>
                {staticRows.map((row, idx) => (
                  <div key={idx} className="grid grid-cols-[110px_100px_110px_1fr_1fr_44px] items-center gap-2">
                    <Input
                      type="number"
                      value={row.ext_start || ''}
                      onChange={(ev) => {
                        const start = parseInt(ev.target.value) || 0
                        const count = row.ext_count || (row.ext_end >= row.ext_start ? row.ext_end - row.ext_start + 1 : 0)
                        updateStaticRow(idx, { ext_start: start, ext_count: count, ext_end: start > 0 && count > 0 ? start + count - 1 : row.ext_end })
                      }}
                      className="font-mono text-xs"
                    />
                    <Input
                      type="number"
                      min={1}
                      value={row.ext_count || ''}
                      onChange={(ev) => {
                        const count = parseInt(ev.target.value) || 0
                        updateStaticRow(idx, { ext_count: count, ext_end: row.ext_start > 0 && count > 0 ? row.ext_start + count - 1 : row.ext_end })
                      }}
                      className="font-mono text-xs"
                    />
                    <Input
                      type="number"
                      value={row.ext_end || ''}
                      onChange={(ev) => {
                        const end = parseInt(ev.target.value) || 0
                        updateStaticRow(idx, { ext_end: end, ext_count: row.ext_start > 0 && end >= row.ext_start ? end - row.ext_start + 1 : row.ext_count })
                      }}
                      className="font-mono text-xs"
                    />
                    <Select
                      value={controllerValue(row.primary_zone_id, row.primary_controller)}
                      onValueChange={(value) => applyControllerSelection(idx, 'primary', value)}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Primary zone/controller" /></SelectTrigger>
                      <SelectContent>
                        {controllerOptions.map((opt) => (
                          <SelectItem key={`p-${opt.value}`} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={controllerValue(row.secondary_zone_id, row.secondary_controller)}
                      onValueChange={(value) => applyControllerSelection(idx, 'secondary', value)}
                    >
                      <SelectTrigger className="h-9 text-xs"><SelectValue placeholder="Optional secondary" /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">No secondary</SelectItem>
                        {controllerOptions.map((opt) => (
                          <SelectItem key={`s-${opt.value}`} value={opt.value}>{opt.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      onClick={() => removeStaticRow(idx)}
                      className="rounded border border-rose-500/30 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/10"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">
                No static ranges configured. The current zone distribution logic will be used.
              </p>
            )}
            {(e('static_agent_assignments') || e('static_agent_assignments_json')) && (
              <div className="mt-2">
                {e('static_agent_assignments') && <FieldError error={e('static_agent_assignments')} />}
                {e('static_agent_assignments_json') && <FieldError error={e('static_agent_assignments_json')} />}
              </div>
            )}
            {!e('static_agent_assignments_json') && w('static_agent_assignments_json') && (
              <div className="mt-2">
                <FieldSoftWarning warning={w('static_agent_assignments_json')} />
              </div>
            )}
          </div>
        )}
        <FormRow
          label="Local IP Mode"
          error={e('local_ip_mode')}
          hint="Single IP uses the current design. Unique VIPs assigns one local source IP per extension. Augmented VIP Pool shares a VIP range across extensions."
        >
          <Select
            value={raw.local_ip_mode}
            onValueChange={(v) => onChange('local_ip_mode', v as LocalIPMode)}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">Single IP</SelectItem>
              <SelectItem value="unique_vip">Unique VIPs</SelectItem>
              <SelectItem value="vip_pool">Augmented VIP Pool</SelectItem>
            </SelectContent>
          </Select>
        </FormRow>
        {raw.local_ip_mode === 'single' && (
          <FormRow
            label="Source IP"
            error={e('local_host')}
            hint="Optional local source IP for all SIP/RTP sockets. Leave empty for auto-detect."
          >
            <Input
              value={raw.local_host}
              onChange={(ev) => onChange('local_host', ev.target.value)}
              onBlur={() => onBlur('local_host')}
              placeholder="auto-detect"
              className="w-40 font-mono"
            />
          </FormRow>
        )}
        {raw.local_ip_mode !== 'single' && (
          <div className="rounded-lg border border-slate-700/50 bg-slate-950/25 p-3">
            <div className="grid gap-3 md:grid-cols-2">
              <FormRow label="VIP Interface" error={e('vip_interface')}>
                <Input value={raw.vip_interface} onChange={(ev) => onChange('vip_interface', ev.target.value)} onBlur={() => onBlur('vip_interface')} placeholder="eth0" className="w-32 font-mono" />
              </FormRow>
              <FormRow label="VIP CIDR" error={e('vip_cidr')}>
                <Input value={raw.vip_cidr} onChange={(ev) => onChange('vip_cidr', ev.target.value)} onBlur={() => onBlur('vip_cidr')} placeholder="10.71.16.0/21" className="w-44 font-mono" />
              </FormRow>
              <FormRow label="First VIP" error={e('vip_first_ip')}>
                <Input value={raw.vip_first_ip} onChange={(ev) => onChange('vip_first_ip', ev.target.value)} onBlur={() => onBlur('vip_first_ip')} placeholder="10.71.17.101" className="w-40 font-mono" />
              </FormRow>
              <FormRow label="VIP Count" error={e('vip_count')}>
                <Input type="number" min={1} value={raw.vip_count} onChange={(ev) => onChange('vip_count', ev.target.value)} onBlur={() => onBlur('vip_count')} placeholder={raw.local_ip_mode === 'unique_vip' ? String(extCount || '') : '100'} className="w-24 font-mono" />
              </FormRow>
              <FormRow label="Gateway Check" error={e('vip_gateway_ip')}>
                <Input value={raw.vip_gateway_ip} onChange={(ev) => onChange('vip_gateway_ip', ev.target.value)} onBlur={() => onBlur('vip_gateway_ip')} placeholder="optional gateway IP" className="w-40 font-mono" />
              </FormRow>
              <FormRow label="SBC Check" error={e('vip_sanity_target_ip')}>
                <Input value={raw.vip_sanity_target_ip} onChange={(ev) => onChange('vip_sanity_target_ip', ev.target.value)} onBlur={() => onBlur('vip_sanity_target_ip')} placeholder={raw.sbc_host || 'optional SBC IP'} className="w-40 font-mono" />
              </FormRow>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 pl-[172px]">
              <Button type="button" size="sm" variant="outline" disabled={!!vipBusy} onClick={() => handleVIPAction('verify')} className="gap-1.5">
                {vipBusy === 'verify' && <Loader2 className="size-3 animate-spin" />}
                Verify VIPs
              </Button>
              <Button type="button" size="sm" disabled={!!vipBusy} onClick={() => handleVIPAction('apply')} className="gap-1.5">
                {vipBusy === 'apply' && <Loader2 className="size-3 animate-spin" />}
                Add / Verify VIPs
              </Button>
              <span className="text-xs text-slate-400">
                {raw.local_ip_mode === 'unique_vip' ? 'Requires one VIP per extension.' : 'VIPs are shared round-robin across extensions.'}
              </span>
            </div>
            {vipResult && (
              <div className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
                Requested {vipResult.requested}; already present {vipResult.already_present}; newly added {vipResult.newly_added}; missing {vipResult.missing}; failed {vipResult.failed}.
                {vipResult.sanity_checks?.length ? (
                  <div className="mt-2 space-y-1">
                    {vipResult.sanity_checks.map((check) => (
                      <div key={`${check.name}-${check.target_ip ?? check.source_ip}`} className={check.ok ? 'text-emerald-200' : 'text-amber-200'}>
                        {check.name}: {check.ok ? 'OK' : 'FAILED'} from {check.source_ip}
                        {check.target_ip ? ` to ${check.target_ip}` : ''}
                        {check.error ? ` (${check.error})` : ''}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            {vipError && (
              <div className="mt-3 rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-200">
                {vipError}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {/* ── Registration & SIP Timers (Signaling tab, collapsed default) ─ */}
      {showSignaling && (() => {
        const regDirty =
          raw.register_expires !== DEFAULTS_REGISTRATION.register_expires ||
          raw.subscribe_expires !== DEFAULTS_REGISTRATION.subscribe_expires ||
          raw.subscribe_events.join(',') !== DEFAULTS_REGISTRATION.subscribe_events.join(',') ||
          raw.subscribe_refresh_events.join(',') !== DEFAULTS_REGISTRATION.subscribe_refresh_events.join(',') ||
          raw.subscribe_unsubscribe_events.join(',') !== DEFAULTS_REGISTRATION.subscribe_unsubscribe_events.join(',') ||
          raw.t1_ms !== DEFAULTS_REGISTRATION.t1_ms ||
          raw.timer_b_seconds !== DEFAULTS_REGISTRATION.timer_b_seconds
        return (
          <CollapsibleSection
            title="Registration & SIP Timers"
            defaultOpen={regDirty}
            dirty={regDirty}
            onReset={() => onResetSection(SECTION_FIELDS.registration)}
          >
            {/* Expiry — compact REG/SUB row.
                Each input keeps an inline mini-label (REG / SUB)
                so the values stay self-describing. */}
            <FormRow
              label="Expiry"
              hint="REGISTER and SUBSCRIBE Expires headers in seconds. Defaults: 3600 / 3600."
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                {/* REG Expires */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-400">REG</span>
                  <Input
                    type="number"
                    min={60}
                    step={60}
                    value={raw.register_expires}
                    onChange={(ev) => onChange('register_expires', ev.target.value)}
                    onBlur={() => onBlur('register_expires')}
                    placeholder="3600"
                    className="w-20 font-mono"
                    aria-invalid={t('register_expires') && !!errors.register_expires ? true : undefined}
                  />
                  <span className="text-xs text-slate-400">s</span>
                </div>
                <span className="text-slate-600">·</span>
                {/* SUB Expires — same shape as REG Expires for visual
                    symmetry. Defaults to 3600 from DEFAULTS but can be
                    set independently. */}
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-400">SUB</span>
                  <Input
                    type="number"
                    min={60}
                    step={60}
                    value={raw.subscribe_expires}
                    onChange={(ev) => onChange('subscribe_expires', ev.target.value)}
                    onBlur={() => onBlur('subscribe_expires')}
                    placeholder="3600"
                    className="w-20 font-mono"
                    aria-invalid={t('subscribe_expires') && !!errors.subscribe_expires ? true : undefined}
                  />
                  <span className="text-xs text-slate-400">s</span>
                </div>
              </div>
              {(e('register_expires') || e('subscribe_expires')) && (
                <>
                  {e('register_expires')   && <FieldError error={e('register_expires')} />}
                  {e('subscribe_expires')  && <FieldError error={e('subscribe_expires')} />}
                </>
              )}
            </FormRow>

            <FormRow
              label="SUBSCRIBE Events"
              hint="Event packages to subscribe after REGISTER. Badges: R = refresh before expiry, U = unsubscribe during cleanup."
            >
              <label className="mb-2 flex w-fit cursor-pointer items-center gap-2 rounded-md border border-slate-700 bg-slate-900/40 px-2.5 py-1.5 text-xs font-semibold text-slate-200">
                <input
                  type="checkbox"
                  checked={raw.subscribe_events.length === SUBSCRIBE_EVENT_VALUES.length}
                  onChange={(ev) => {
                    const next = ev.target.checked ? [...SUBSCRIBE_EVENT_VALUES] : []
                    onChange('subscribe_events', next)
                    onChange('subscribe_refresh_events', next)
                    onChange('subscribe_unsubscribe_events', next)
                    onBlur('subscribe_events')
                  }}
                  className="size-3.5 rounded border-slate-600 bg-slate-950 text-emerald-500 accent-emerald-500"
                />
                <span>All events</span>
              </label>
              <div className="flex flex-wrap gap-2">
                {SUBSCRIBE_EVENT_OPTIONS.map((option) => {
                  const selected = raw.subscribe_events.includes(option.event)
                  const refreshSelected = raw.subscribe_refresh_events.includes(option.event)
                  const unsubscribeSelected = raw.subscribe_unsubscribe_events.includes(option.event)
                  return (
                    <label
                      key={option.event}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors',
                        selected
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-slate-100'
                          : 'border-slate-700 bg-slate-900/30 text-slate-400 hover:border-slate-500 hover:text-slate-200',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={(ev) => {
                          const next = ev.target.checked
                            ? [...raw.subscribe_events, option.event]
                            : raw.subscribe_events.filter((v) => v !== option.event)
                          const nextRefresh = ev.target.checked
                            ? Array.from(new Set([...raw.subscribe_refresh_events, option.event]))
                            : raw.subscribe_refresh_events.filter((v) => v !== option.event)
                          const nextUnsubscribe = ev.target.checked
                            ? Array.from(new Set([...raw.subscribe_unsubscribe_events, option.event]))
                            : raw.subscribe_unsubscribe_events.filter((v) => v !== option.event)
                          onChange('subscribe_events', next)
                          onChange('subscribe_refresh_events', nextRefresh)
                          onChange('subscribe_unsubscribe_events', nextUnsubscribe)
                          onBlur('subscribe_events')
                        }}
                        className="size-3.5 rounded border-slate-600 bg-slate-950 text-emerald-500 accent-emerald-500"
                      />
                      <span title={`${option.serverGroup}: ${option.event}`}>{option.label}</span>
                      {option.refresh && (
                        <span
                          className={cn(
                            'flex items-center gap-1 rounded bg-sky-500/15 px-1 text-[10px] font-bold text-sky-300',
                            !selected && 'opacity-45',
                          )}
                          title="R = Refresh: when enabled, the engine refreshes this SUBSCRIBE before it expires"
                        >
                          <input
                            type="checkbox"
                            checked={selected && refreshSelected}
                            disabled={!selected}
                            onClick={(ev) => ev.stopPropagation()}
                            onChange={(ev) => {
                              const next = ev.target.checked
                                ? Array.from(new Set([...raw.subscribe_refresh_events, option.event]))
                                : raw.subscribe_refresh_events.filter((v) => v !== option.event)
                              onChange('subscribe_refresh_events', next)
                              onBlur('subscribe_refresh_events')
                            }}
                            className="size-3 rounded border-slate-600 bg-slate-950 accent-sky-500"
                          />
                          <span>R</span>
                        </span>
                      )}
                      {option.unsubscribe && (
                        <span
                          className={cn(
                            'flex items-center gap-1 rounded bg-amber-500/15 px-1 text-[10px] font-bold text-amber-300',
                            !selected && 'opacity-45',
                          )}
                          title="U = Unsubscribe: when enabled, cleanup sends SUBSCRIBE with Expires: 0 for this event"
                        >
                          <input
                            type="checkbox"
                            checked={selected && unsubscribeSelected}
                            disabled={!selected}
                            onClick={(ev) => ev.stopPropagation()}
                            onChange={(ev) => {
                              const next = ev.target.checked
                                ? Array.from(new Set([...raw.subscribe_unsubscribe_events, option.event]))
                                : raw.subscribe_unsubscribe_events.filter((v) => v !== option.event)
                              onChange('subscribe_unsubscribe_events', next)
                              onBlur('subscribe_unsubscribe_events')
                            }}
                            className="size-3 rounded border-slate-600 bg-slate-950 accent-amber-500"
                          />
                          <span>U</span>
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
              {e('subscribe_events') && <FieldError error={e('subscribe_events')} />}
              {e('subscribe_refresh_events') && <FieldError error={e('subscribe_refresh_events')} />}
              {e('subscribe_unsubscribe_events') && <FieldError error={e('subscribe_unsubscribe_events')} />}
            </FormRow>

            {/* SIP Timers — T1 and Timer-B with explicit per-input labels. */}
            <FormRow
              label="SIP Timers"
              hint="RFC 3261 §17.1.1 INVITE client transaction timers. T1 is the UDP retransmit interval (default 500 ms); Timer-B is the overall INVITE transaction timeout (default 64*T1 = 32 s)."
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-400">T1</span>
                  <Input
                    type="number"
                    min={100}
                    max={5000}
                    step={50}
                    value={raw.t1_ms}
                    onChange={(ev) => onChange('t1_ms', ev.target.value)}
                    onBlur={() => onBlur('t1_ms')}
                    placeholder="500"
                    className="w-20 font-mono"
                    aria-invalid={t('t1_ms') && !!errors.t1_ms ? true : undefined}
                  />
                  <span className="text-xs text-slate-400">ms</span>
                </div>
                <span className="text-slate-600">·</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-xs font-medium text-slate-400">Timer-B</span>
                  <Input
                    type="number"
                    min={1}
                    max={300}
                    step={1}
                    value={raw.timer_b_seconds}
                    onChange={(ev) => onChange('timer_b_seconds', ev.target.value)}
                    onBlur={() => onBlur('timer_b_seconds')}
                    placeholder="32"
                    className="w-20 font-mono"
                    aria-invalid={t('timer_b_seconds') && !!errors.timer_b_seconds ? true : undefined}
                  />
                  <span className="text-xs text-slate-400">s</span>
                </div>
              </div>
              {(e('t1_ms') || e('timer_b_seconds')) && (
                <>
                  {e('t1_ms') && <FieldError error={e('t1_ms')} />}
                  {e('timer_b_seconds') && <FieldError error={e('timer_b_seconds')} />}
                </>
              )}
            </FormRow>
          </CollapsibleSection>
        )
      })()}

      {/* ── Registration/Subscription Traffic (Traffic tab) ───────────────── */}
      {showTraffic && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.register_traffic)}>Registration/Subscription Traffic</SectionHeader>
        <FormRow
          label="Agent Setup Rates"
          hint="Agent Conn Rate limits TCP/TLS connection starts per second. Agent Reg/Sub Rate limits logical agent setup flows per second; in HA modes a flow can include primary REGISTER, secondary REGISTER, and primary SUBSCRIBE."
        >
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-slate-400">Agent Conn Rate</span>
              <Input
                type="number"
                min={1}
                step={1}
                value={raw.agent_connection_cps}
                onChange={(ev) => onChange('agent_connection_cps', ev.target.value)}
                onBlur={() => onBlur('agent_connection_cps')}
                placeholder="30"
                className="w-16 font-mono"
                aria-invalid={t('agent_connection_cps') && !!errors.agent_connection_cps ? true : undefined}
              />
              <span className="text-xs text-slate-400">/s</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium text-slate-400">Agent Reg/Sub Rate</span>
              <Input
                type="number"
                min={1}
                step={1}
                value={raw.agent_regsub_cps}
                onChange={(ev) => onChange('agent_regsub_cps', ev.target.value)}
                onBlur={() => onBlur('agent_regsub_cps')}
                placeholder="30"
                className="w-16 font-mono"
                aria-invalid={t('agent_regsub_cps') && !!errors.agent_regsub_cps ? true : undefined}
              />
              <span className="text-xs text-slate-400">/s</span>
            </div>
          </div>
          {(e('agent_connection_cps') || e('agent_regsub_cps')) && (
            <>
              {e('agent_connection_cps') && <FieldError error={e('agent_connection_cps')} />}
              {e('agent_regsub_cps') && <FieldError error={e('agent_regsub_cps')} />}
            </>
          )}
        </FormRow>
      </div>
      )}

      {/* ── Call Traffic (Traffic tab) ─────────────────────────── */}
      {showTraffic && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.call_traffic)}>Call Traffic</SectionHeader>

        {/* Combined Traffic row — CPS + BHCC + Hold all on one line. */}
        <CpsBhccField
          cps={raw.cps}
          onCpsChange={(v) => onChange('cps', v)}
          error={t('cps') ? errors.cps : undefined}
          warning={t('cps') ? warnings.cps : undefined}
          onBlur={() => onBlur('cps')}
          holdSeconds={raw.hold_time_seconds}
          onHoldChange={(v) => onChange('hold_time_seconds', v)}
          onHoldBlur={() => onBlur('hold_time_seconds')}
          holdError={e('hold_time_seconds')}
          holdWarning={w('hold_time_seconds')}
        />

        {/* Ramp-up duration (wall-clock seconds). Engine ramps cps from
            0 → configured cps linearly over this window. Set 0 to fire
            at full cps from t=0. */}
        <FormRow
          label="Ramp-Up"
          hint="Wall-clock seconds to climb from 0 cps to the configured cps. 0 = no ramp (full speed immediately)."
        >
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={0}
              max={3600}
              step={1}
              value={raw.ramp_up_seconds}
              onChange={(ev) => onChange('ramp_up_seconds', ev.target.value)}
              onBlur={() => onBlur('ramp_up_seconds')}
              placeholder="30"
              className="w-20 font-mono"
              aria-invalid={t('ramp_up_seconds') && !!errors.ramp_up_seconds ? true : undefined}
            />
            <span className="text-xs text-slate-400">s</span>
          </div>
          {e('ramp_up_seconds') && <FieldError error={e('ramp_up_seconds')} />}
        </FormRow>

        <FormRow
          label="Call Pairing"
          hint="Initial call pairing policy. You can still change this dynamically from the run page while traffic is active."
        >
          <Select
            value={raw.pairing_policy || 'random'}
            onValueChange={(v) => {
              onChange('pairing_policy', v as PairingPolicy)
              onBlur('pairing_policy')
            }}
          >
            <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="random">Random</SelectItem>
              <SelectItem value="cross_zone">Cross Zone Only</SelectItem>
              <SelectItem value="same_zone">Same Zone</SelectItem>
              <SelectItem value="same_controller">Same Controller</SelectItem>
            </SelectContent>
          </Select>
          {e('pairing_policy') && <FieldError error={e('pairing_policy')} />}
        </FormRow>

        {/* Traffic mode: smoke / timed / unlimited */}
        <div className="space-y-2 pt-1">
          <TrafficModeSelector
            value={raw.traffic_mode as TrafficMode}
            onChange={(m) => onChange('traffic_mode', m)}
            callCount={raw.call_count}
            onCallCountChange={(v) => onChange('call_count', v)}
            durationHours={raw.duration_hours}
            onDurationHoursChange={(v) => onChange('duration_hours', v)}
            cps={raw.cps}
            startTimeIso={raw.start_time_iso}
            onStartTimeIsoChange={(v) => onChange('start_time_iso', v)}
            errors={{
              call_count: t('call_count') ? errors.call_count : undefined,
              duration_hours: t('duration_hours') ? errors.duration_hours : undefined,
            }}
            warnings={{
              call_count: t('call_count') ? warnings.call_count : undefined,
              duration_hours: t('duration_hours') ? warnings.duration_hours : undefined,
            }}
            touched={{
              call_count: t('call_count'),
              duration_hours: t('duration_hours'),
            }}
            onBlur={(field) => onBlur(field)}
          />
        </div>
      </div>
      )}

      {/* ── Media (RTP) (Media tab) ────────────────────────────── */}
      {showMedia && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.media)}>Media (RTP)</SectionHeader>

        <FormRow
          label="RTP Media"
          hint="Disable for signaling-only test runs (no RTP packets transmitted)."
        >
          <div className="flex items-center gap-3">
            <Switch
              checked={raw.media_enabled}
              onCheckedChange={(checked) => onChange('media_enabled', checked)}
            />
            <span className="text-xs text-slate-400">
              {raw.media_enabled ? 'RTP enabled' : 'Signaling-only — no RTP'}
            </span>
          </div>
        </FormRow>

        {raw.media_enabled && (
          <>
            <FormRow
              label="Media Type"
              hint="RTP is the default. SRTP (SDES) currently negotiates SDP crypto lines; media encryption is planned for the next phase. CAPNEG is shown for future support."
            >
              <div className="flex flex-wrap gap-2">
                {[
                  { value: 'rtp', label: 'RTP', disabled: false },
                  { value: 'srtp_sdes', label: 'SRTP (SDES)', disabled: false },
                  { value: 'capneg', label: 'CAPNEG (future)', disabled: true },
                ].map((option) => (
                  <label
                    key={option.value}
                    className={cn(
                      'flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-semibold',
                      option.disabled
                        ? 'cursor-not-allowed border-slate-800 bg-slate-900/20 text-slate-600'
                        : raw.media_security === option.value
                          ? 'border-emerald-500/50 bg-emerald-500/10 text-slate-100'
                          : 'cursor-pointer border-slate-700 bg-slate-900/30 text-slate-400 hover:border-slate-500 hover:text-slate-200',
                    )}
                  >
                    <input
                      type="radio"
                      name="media_security"
                      checked={raw.media_security === option.value}
                      disabled={option.disabled}
                      onChange={() => {
                        if (!option.disabled) {
                          onChange('media_security', option.value as MediaSecurity)
                          onBlur('media_security')
                        }
                      }}
                      className="size-3.5 accent-emerald-500"
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
              {e('media_security') && <FieldError error={e('media_security')} />}
            </FormRow>
            <FormRow
              label="SRTP Crypto Suite"
              hint="Select one or more SDES crypto suites to advertise when SRTP is selected."
            >
              <div className="flex flex-wrap gap-2">
                {(['AES_CM_128_HMAC_SHA1_80', 'AES_CM_128_HMAC_SHA1_32'] as SRTPCryptoSuite[]).map((suite) => {
                  const enabled = raw.media_security === 'srtp_sdes'
                  const checked = raw.srtp_crypto_suites.includes(suite)
                  return (
                    <label
                      key={suite}
                      className={cn(
                        'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs font-medium',
                        enabled
                          ? 'cursor-pointer border-slate-700 bg-slate-900/30 text-slate-300 hover:border-slate-500'
                          : 'cursor-not-allowed border-slate-800 bg-slate-900/20 text-slate-600',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!enabled}
                        onChange={(ev) => {
                          const next = ev.target.checked
                            ? Array.from(new Set([...raw.srtp_crypto_suites, suite]))
                            : raw.srtp_crypto_suites.filter((v) => v !== suite)
                          onChange('srtp_crypto_suites', next)
                          onBlur('srtp_crypto_suites')
                        }}
                        className="size-3.5 accent-emerald-500"
                      />
                      <span>{suite}</span>
                    </label>
                  )
                })}
              </div>
              {e('srtp_crypto_suites') && <FieldError error={e('srtp_crypto_suites')} />}
            </FormRow>
            <FormRow label="SRTP Key Mode" hint="Keying material is generated per call and is never shown in logs or reports.">
              <span className={cn(
                'rounded-md border px-3 py-1.5 text-xs font-semibold',
                raw.media_security === 'srtp_sdes'
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-slate-800 bg-slate-900/20 text-slate-600',
              )}>
                Auto-generate per call
              </span>
            </FormRow>
            <FormRow label="Codec">
              <Select
                value={raw.rtp_codec}
                onValueChange={(v) => {
                  const codec = v as RtpCodec
                  onChange('rtp_codec', codec)
                  if (codec === 'G729' || codec === 'G729_AUDIO') {
                    onChange('rtp_ptime', '20')
                    onBlur('rtp_ptime')
                  }
                  onBlur('rtp_codec')
                }}
              >
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="G711_ULAW">G.711 μ-law (PCMU)</SelectItem>
                  <SelectItem value="G711_ALAW">G.711 A-law (PCMA)</SelectItem>
                  <SelectItem value="G729">G.729 - pre-encoded frame</SelectItem>
                  <SelectItem value="G729_AUDIO">G.729 pre-encoded audio</SelectItem>
                </SelectContent>
              </Select>
            </FormRow>
            <FormRow
              label="Unsupported codec offer"
              hint="Single-codec mode: controls what UAS does when the INVITE offer does not include the selected codec."
            >
              <Select
                value={raw.rtp_unsupported_codec_policy}
                onValueChange={(v) => {
                  onChange('rtp_unsupported_codec_policy', v as RtpUnsupportedCodecPolicy)
                  onBlur('rtp_unsupported_codec_policy')
                }}
              >
                <SelectTrigger className="w-72"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="fallback_g711">Fallback to offered G.711</SelectItem>
                  <SelectItem value="reject_488">Reject with 488 Not Acceptable Here</SelectItem>
                </SelectContent>
              </Select>
            </FormRow>
            <FormRow
              label="ptime"
              hint={`Packet interval (ms). 1000 ÷ ptime = packets per second.`}
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={10}
                  max={80}
                  step={10}
                  value={raw.rtp_ptime}
                  onChange={(ev) => onChange('rtp_ptime', ev.target.value)}
                  onBlur={() => onBlur('rtp_ptime')}
                  placeholder="20"
                  className="w-20 font-mono"
                />
                <span className="text-xs text-slate-400">ms</span>
                <span className="text-slate-500">·</span>
                <span className="font-mono text-xs text-emerald-400">
                  {ppsDisplay} pps
                </span>
              </div>
            </FormRow>
          </>
        )}
      </div>
      )}

    </div>
  )
}
