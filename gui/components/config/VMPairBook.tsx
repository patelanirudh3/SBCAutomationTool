'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Trash2,
  Pencil,
  RotateCcw,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { VMConfigPanel, type RawVMFormValues, TAB_FIELDS } from './VMConfigPanel'
import { AdvancedSettings } from './AdvancedSettings'
import { ConfigSummaryStrip, ConfigSummaryDrawer, ConfigSummarySidebar } from './ConfigSummary'
import { VMHealthPanel } from '@/components/dashboard/VMHealthPanel'
import { VMConfigSchema, getFieldWarnings } from '@/lib/config-schema'
import { useTrafficStore } from '@/store/traffic'
import { checkHealth, getMetricsFor, putConfigFor, startNewRunFor } from '@/lib/api'
import { selectedEngineEndpoint } from '@/lib/engine-endpoint'
import { cn } from '@/lib/utils'
import type { HostHealth, VMConfig, VMPair, ReachabilityStatus, SipScheme, RtpCodec, RtpUnsupportedCodecPolicy, TLSMode, MediaSecurity, SRTPCryptoSuite, PairingPolicy } from '@/types'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'

const IS_MOCK = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: RawVMFormValues = {
  vm_id: 'traffic-local',
  vm_ip: '127.0.0.1',
  ssh_user: '',
  ssh_key_path: '',
  local_ip_mode: 'single',
  local_host: '',
  vip_interface: '',
  vip_cidr: '',
  vip_first_ip: '',
  vip_count: '',
  vip_gateway_ip: '',
  vip_sanity_target_ip: '',
  ext_start: '4001000',
  ext_end: '4001009',
  ext_count: '10',
  register_expires: '3600',
  subscribe_expires: '3600',
  subscribe_events: ['dialog'],
  subscribe_refresh_events: ['dialog'],
  subscribe_unsubscribe_events: ['dialog'],
  agent_connection_cps: '30',
  agent_regsub_cps: '30',
  t1_ms: '500',
  timer_b_seconds: '32',
  sbc_host: '10.133.63.117',
  sbc_port: '5060',
  ha_mode: 'single',
  zone_config_json: '',
  dual_registration_enabled: false,
  secondary_host: '',
  secondary_port: '5060',
  failover_enabled: false,
  failover_mode: 'graceful',
  auto_failback_enabled: false,
  failback_delay_seconds: '30',
  failover_trigger: 'per_agent',
  failover_trigger_count: '5',
  failover_trigger_pct: '20',
  failover_trigger_window_ms: '1000',
  dns_servers: '',
  sip_transport: 'TCP',
  sip_scheme: 'SIP',
  domain: 'avaya.com',
  sip_password: '123456',
  tls_mode: 'insecure',
  tls_ca_path: '',
  tls_cert_path: '',
  tls_key_path: '',
  tls_server_name: '',
  tls_min_version: '1.2',
  tls_max_version: 'auto',
  cps: '1',
  hold_time_seconds: '5',
  ramp_up_seconds: '30',
  pairing_policy: 'random',
  media_enabled: true,
  media_security: 'rtp',
  srtp_crypto_suites: ['AES_CM_128_HMAC_SHA1_80'],
  srtp_key_mode: 'auto',
  rtp_codec: 'G711_ULAW',
  rtp_unsupported_codec_policy: 'fallback_g711',
  rtp_ptime: '20',
  metrics_port: '8082',
  traffic_mode: 'smoke',
  call_count: '10',
  duration_hours: '1',
  start_time_iso: '',
}

// Fields validated for the UA form
const UA_FIELDS = [
  'vm_id', 'vm_ip', 'ext_start', 'ext_end',
  'local_ip_mode',
  'sbc_host', 'sbc_port', 'sip_transport', 'domain', 'sip_password',
  'cps', 'hold_time_seconds', 'metrics_port', 'traffic_mode', 'call_count',
  'duration_hours', 'pairing_policy',
]

// ---------------------------------------------------------------------------
// pairToRaw — restores saved VMPair.uac back into form string values
// ---------------------------------------------------------------------------

function pairToRaw(p: VMPair): RawVMFormValues {
  const u = p.uac
  const legacy = u as VMConfig & { register_rate_cps?: number }
  const extStart = u.ext_start ?? parseInt(DEFAULTS.ext_start)
  const extEnd   = u.ext_end   ?? parseInt(DEFAULTS.ext_end)
  return {
    vm_id:              u.vm_id            ?? DEFAULTS.vm_id,
    vm_ip:              u.vm_ip            ?? DEFAULTS.vm_ip,
    ssh_user:           u.ssh_user         ?? '',
    ssh_key_path:       u.ssh_key_path     ?? '',
    local_ip_mode:      u.local_ip_mode    ?? 'single',
    local_host:         u.local_host       ?? '',
    vip_interface:      u.vip_interface    ?? '',
    vip_cidr:           u.vip_cidr         ?? '',
    vip_first_ip:       u.vip_first_ip     ?? '',
    vip_count:          u.vip_count ? String(u.vip_count) : '',
    vip_gateway_ip:     u.vip_gateway_ip   ?? '',
    vip_sanity_target_ip: u.vip_sanity_target_ip ?? '',
    ext_start:          String(extStart),
    ext_end:            String(extEnd),
    ext_count:          String(Math.max(extEnd - extStart + 1, 0)),
    register_expires:   String(u.register_expires   ?? parseInt(DEFAULTS.register_expires)),
    subscribe_expires:  String(u.subscribe_expires  ?? parseInt(DEFAULTS.subscribe_expires)),
    subscribe_events:   u.subscribe_events?.length ? u.subscribe_events : (u.subscribe_event ? [u.subscribe_event] : ['dialog']),
    subscribe_refresh_events: u.subscribe_refresh_events ?? (u.subscribe_events?.length ? u.subscribe_events : (u.subscribe_event ? [u.subscribe_event] : ['dialog'])),
    subscribe_unsubscribe_events: u.subscribe_unsubscribe_events ?? (u.subscribe_events?.length ? u.subscribe_events : (u.subscribe_event ? [u.subscribe_event] : ['dialog'])),
    agent_connection_cps: String(u.agent_connection_cps ?? parseFloat(DEFAULTS.agent_connection_cps)),
    agent_regsub_cps:     String(u.agent_regsub_cps     ?? legacy.register_rate_cps ?? parseFloat(DEFAULTS.agent_regsub_cps)),
    t1_ms:              String(u.t1_ms              ?? parseInt(DEFAULTS.t1_ms)),
    timer_b_seconds:    String(u.timer_b_seconds    ?? parseInt(DEFAULTS.timer_b_seconds)),
    sbc_host:           u.sbc_host         ?? DEFAULTS.sbc_host,
    sbc_port:           String(u.sbc_port  ?? parseInt(DEFAULTS.sbc_port)),
    ha_mode:            u.ha_mode ?? (u.dual_registration_enabled ? 'dual' : 'single'),
    zone_config_json:   u.zone_config ? JSON.stringify(u.zone_config) : '',
    dual_registration_enabled: u.dual_registration_enabled ?? u.failover_enabled ?? false,
    secondary_host:     u.secondary_host   ?? '',
    secondary_port:     String(u.secondary_port ?? parseInt(DEFAULTS.secondary_port)),
    failover_enabled:   u.failover_enabled ?? false,
    failover_mode:      u.failover_mode ?? 'graceful',
    auto_failback_enabled: u.auto_failback_enabled ?? false,
    failback_delay_seconds: String(u.failback_delay_seconds ?? parseInt(DEFAULTS.failback_delay_seconds)),
    failover_trigger:   u.failover_trigger ?? 'per_agent',
    failover_trigger_count: String(u.failover_trigger_count ?? parseInt(DEFAULTS.failover_trigger_count)),
    failover_trigger_pct: String(u.failover_trigger_pct ?? parseInt(DEFAULTS.failover_trigger_pct)),
    failover_trigger_window_ms: String(u.failover_trigger_window_ms ?? parseInt(DEFAULTS.failover_trigger_window_ms)),
    dns_servers:        u.dns_servers      ?? '',
    sip_transport:      u.sip_transport    ?? 'TCP',
    sip_scheme:         (u.sip_scheme      ?? 'SIP') as SipScheme,
    domain:             u.domain           ?? DEFAULTS.domain,
    sip_password:       u.sip_password     ?? DEFAULTS.sip_password,
    tls_mode:           (u.tls_mode        ?? DEFAULTS.tls_mode) as TLSMode,
    tls_ca_path:        u.tls_ca_path      ?? '',
    tls_cert_path:      u.tls_cert_path    ?? '',
    tls_key_path:       u.tls_key_path     ?? '',
    tls_server_name:    u.tls_server_name  ?? '',
    tls_min_version:    (u.tls_min_version ?? '1.2') as '1.2' | '1.3',
    tls_max_version:    (u.tls_max_version ?? 'auto') as 'auto' | '1.2' | '1.3',
    cps:                String(u.cps               ?? parseFloat(DEFAULTS.cps)),
    hold_time_seconds:  String(u.hold_time_seconds ?? parseFloat(DEFAULTS.hold_time_seconds)),
    ramp_up_seconds:    String(u.ramp_up_seconds   ?? parseInt(DEFAULTS.ramp_up_seconds)),
    pairing_policy:     (u.pairing_policy ?? DEFAULTS.pairing_policy) as PairingPolicy,
    media_enabled:      u.media_enabled    ?? true,
    media_security:     (u.media_security   ?? 'rtp') as MediaSecurity,
    srtp_crypto_suites: (u.srtp_crypto_suites?.length ? u.srtp_crypto_suites : ['AES_CM_128_HMAC_SHA1_80']) as SRTPCryptoSuite[],
    srtp_key_mode:      u.srtp_key_mode    ?? 'auto',
    rtp_codec:          (u.rtp_codec       ?? 'G711_ULAW') as RtpCodec,
    rtp_unsupported_codec_policy: (u.rtp_unsupported_codec_policy ?? 'fallback_g711') as RtpUnsupportedCodecPolicy,
    rtp_ptime:          String(u.rtp_ptime ?? parseInt(DEFAULTS.rtp_ptime)),
    metrics_port:       String(u.metrics_port ?? parseInt(DEFAULTS.metrics_port)),
    traffic_mode:       u.traffic_mode     ?? 'smoke',
    call_count:         String(u.call_count     ?? parseInt(DEFAULTS.call_count)),
    duration_hours:     String(u.duration_hours ?? parseFloat(DEFAULTS.duration_hours)),
    start_time_iso:     u.start_time_iso   ?? '',
  }
}

// ---------------------------------------------------------------------------
// parseRaw — converts string form values to typed VMConfig
// ---------------------------------------------------------------------------

function computedExtEnd(raw: RawVMFormValues): number {
  const start = parseInt(raw.ext_start) || 0
  const count = parseInt(raw.ext_count) || 0
  return start > 0 && count > 0 ? start + count - 1 : 0
}

function parseRaw(raw: RawVMFormValues): Partial<VMConfig> {
  const extEnd = computedExtEnd(raw)
  return {
    vm_id: raw.vm_id,
    vm_ip: raw.vm_ip,
    ssh_user: raw.ssh_user || undefined,
    ssh_key_path: raw.ssh_key_path || undefined,
    local_ip_mode: raw.local_ip_mode,
    local_host: raw.local_ip_mode === 'single' ? (raw.local_host || undefined) : undefined,
    vip_interface: raw.local_ip_mode !== 'single' ? (raw.vip_interface || undefined) : undefined,
    vip_cidr: raw.local_ip_mode !== 'single' ? (raw.vip_cidr || undefined) : undefined,
    vip_first_ip: raw.local_ip_mode !== 'single' ? (raw.vip_first_ip || undefined) : undefined,
    vip_count: raw.local_ip_mode !== 'single' ? (parseInt(raw.vip_count) || undefined) : undefined,
    vip_gateway_ip: raw.local_ip_mode !== 'single' ? (raw.vip_gateway_ip || undefined) : undefined,
    vip_sanity_target_ip: raw.local_ip_mode !== 'single' ? (raw.vip_sanity_target_ip || undefined) : undefined,
    ext_start: parseInt(raw.ext_start) || 0,
    ext_end: extEnd,
    sbc_host: raw.sbc_host,
    sbc_port: parseInt(raw.sbc_port) || 0,
    ha_mode: raw.ha_mode !== 'single' ? raw.ha_mode : undefined,
    zone_config: raw.ha_mode === 'multi_zone' && raw.zone_config_json ? (() => { try { return JSON.parse(raw.zone_config_json) } catch { return undefined } })() : undefined,
    dual_registration_enabled: raw.dual_registration_enabled,
    secondary_host: raw.dual_registration_enabled ? (raw.secondary_host || undefined) : undefined,
    secondary_port: raw.dual_registration_enabled ? (parseInt(raw.secondary_port) || undefined) : undefined,
    failover_enabled: raw.dual_registration_enabled || raw.ha_mode === 'multi_zone' || undefined,
    failover_mode: (raw.dual_registration_enabled || raw.ha_mode === 'multi_zone') ? raw.failover_mode : undefined,
    auto_failback_enabled: (raw.dual_registration_enabled || raw.ha_mode === 'multi_zone') ? raw.auto_failback_enabled : undefined,
    failback_delay_seconds: (raw.dual_registration_enabled || raw.ha_mode === 'multi_zone') && raw.auto_failback_enabled ? (parseInt(raw.failback_delay_seconds) || undefined) : undefined,
    failover_trigger: (raw.dual_registration_enabled || raw.ha_mode === 'multi_zone') ? raw.failover_trigger : undefined,
    failover_trigger_count: raw.failover_trigger === 'min_agents' ? (parseInt(raw.failover_trigger_count) || undefined) : undefined,
    failover_trigger_pct: raw.failover_trigger === 'pct_agents' ? (parseInt(raw.failover_trigger_pct) || undefined) : undefined,
    failover_trigger_window_ms: (raw.failover_trigger === 'min_agents' || raw.failover_trigger === 'pct_agents') ? (parseInt(raw.failover_trigger_window_ms) || undefined) : undefined,
    dns_servers: raw.dns_servers || undefined,
    sip_transport: raw.sip_transport,
    sip_scheme: raw.sip_scheme as SipScheme,
    domain: raw.domain,
    sip_password: raw.sip_password,
    tls_mode: raw.sip_transport === 'TLS' ? (raw.tls_mode as TLSMode) : undefined,
    tls_ca_path: raw.sip_transport === 'TLS' ? (raw.tls_ca_path || undefined) : undefined,
    tls_cert_path: raw.sip_transport === 'TLS' ? (raw.tls_cert_path || undefined) : undefined,
    tls_key_path: raw.sip_transport === 'TLS' ? (raw.tls_key_path || undefined) : undefined,
    tls_server_name: raw.sip_transport === 'TLS' ? (raw.tls_server_name || undefined) : undefined,
    tls_min_version: raw.sip_transport === 'TLS' ? raw.tls_min_version : undefined,
    tls_max_version: raw.sip_transport === 'TLS' ? raw.tls_max_version : undefined,
    register_expires: raw.register_expires ? parseInt(raw.register_expires) : undefined,
    subscribe_expires: raw.subscribe_expires ? parseInt(raw.subscribe_expires) : undefined,
    subscribe_events: raw.subscribe_events,
    subscribe_refresh_events: raw.subscribe_refresh_events,
    subscribe_unsubscribe_events: raw.subscribe_unsubscribe_events,
    agent_connection_cps: raw.agent_connection_cps ? parseFloat(raw.agent_connection_cps) : undefined,
    agent_regsub_cps: raw.agent_regsub_cps ? parseFloat(raw.agent_regsub_cps) : undefined,
    t1_ms: raw.t1_ms ? parseInt(raw.t1_ms) : undefined,
    timer_b_seconds: raw.timer_b_seconds ? parseInt(raw.timer_b_seconds) : undefined,
    cps: parseFloat(raw.cps) || 0,
    hold_time_seconds: parseFloat(raw.hold_time_seconds) || 0,
    ramp_up_seconds: raw.ramp_up_seconds ? parseInt(raw.ramp_up_seconds) : undefined,
    pairing_policy: raw.pairing_policy,
    media_enabled: raw.media_enabled,
    media_security: raw.media_security === 'capneg' ? 'rtp' : raw.media_security,
    srtp_crypto_suites: raw.srtp_crypto_suites,
    srtp_key_mode: raw.srtp_key_mode,
    rtp_codec: raw.rtp_codec as RtpCodec,
    rtp_unsupported_codec_policy: raw.rtp_unsupported_codec_policy as RtpUnsupportedCodecPolicy,
    rtp_ptime: raw.rtp_ptime ? parseInt(raw.rtp_ptime) : undefined,
    metrics_port: parseInt(raw.metrics_port) || 0,
    traffic_mode: raw.traffic_mode || undefined,
    call_count: raw.call_count ? parseInt(raw.call_count) : undefined,
    duration_hours: raw.duration_hours ? parseFloat(raw.duration_hours) : undefined,
    start_time_iso: raw.start_time_iso || undefined,
  }
}

function getErrors(raw: RawVMFormValues): Record<string, string> {
  const result = VMConfigSchema.safeParse(parseRaw(raw))
  if (result.success) return {}
  const flat = result.error.flatten().fieldErrors
  return Object.fromEntries(
    Object.entries(flat).map(([k, v]) => [k, (v as string[])?.[0] ?? ''])
  )
}

// ---------------------------------------------------------------------------
// ConfigTabTrigger — TabsTrigger wrapper that adds a small red error count
// badge when fields belonging to that tab fail validation. The badge only
// appears AFTER the user has clicked Validate at least once (errCount=0
// is passed before that to keep the tab labels clean during initial entry).
// ---------------------------------------------------------------------------

/**
 * ConfigTabTrigger — filled-pill (iOS Settings / Stripe) style on dark.
 * All three pills sit inside a single slate-tinted rounded container
 * (rendered by the parent TabsList). Active pill has a solid orange
 * fill with white text and a subtle warm glow shadow; inactive pills
 * are transparent with muted-orange text.
 *
 * The `!` (important) modifier is required on the active-state classes
 * to defeat the base shadcn TabsTrigger primitive's built-in active
 * styles, which use the data-active: selector — Tailwind treats those
 * as different selectors from our data-[state=active]: so both apply
 * unless one is forced.
 */
function ConfigTabTrigger({
  value,
  label,
  errCount,
}: {
  value: 'server' | 'signaling' | 'media' | 'traffic'
  label: string
  errCount: number
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        // Layout — same size as before but rounded all corners (pill)
        // and generous padding so each pill is a comfortable click target.
        'h-9 rounded-md px-4 text-sm font-bold uppercase tracking-wide transition-colors',
        'border border-transparent',
        // Inactive — transparent fill, muted-orange text. Hover dims a
        // soft slate fill in for affordance feedback.
        'text-orange-200/70 bg-transparent',
        'hover:bg-slate-700/60 hover:text-orange-100',
        // Active — solid orange pill with white text + soft warm glow.
        // The ! modifier is mandatory here: the shadcn TabsTrigger
        // primitive sets dark:data-active:bg-input/30 and friends which
        // would otherwise win on cascade and produce the grey/white look.
        'data-[state=active]:!bg-orange-500',
        'data-[state=active]:!text-white',
        'data-[state=active]:!border-orange-600',
        'data-[state=active]:shadow-md',
        'data-[state=active]:shadow-orange-500/25',
        // Suppress the line-variant after-underline accent (white bar)
        // — pills don't use it.
        'after:!opacity-0',
      )}
    >
      <span>{label}</span>
      {errCount > 0 && (
        <span
          className="ml-2 inline-flex h-6 min-w-6 items-center justify-center rounded-full bg-rose-500/25 px-2 font-mono text-xs font-bold text-rose-300"
          title={`${errCount} validation error${errCount === 1 ? '' : 's'}`}
        >
          {errCount}
        </span>
      )}
    </TabsTrigger>
  )
}

// ---------------------------------------------------------------------------
// InlineVMIdEditor — click-to-edit replacement for the dedicated Identity
// section. The VM ID is the only field in that section and is always shown
// at the top of the UA card anyway, so editing inline saves a full row.
// ---------------------------------------------------------------------------

function InlineVMIdEditor({
  value,
  onChange,
  onBlur,
  invalid,
}: {
  value: string
  onChange: (v: string) => void
  onBlur: () => void
  invalid?: boolean
}) {
  const [editing, setEditing] = useState(false)

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { onBlur(); setEditing(false) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === 'Escape') {
            (e.target as HTMLInputElement).blur()
          }
        }}
        placeholder="traffic-local"
        className={cn(
          'h-6 w-44 rounded border bg-background px-1.5 font-mono text-sm text-foreground',
          'focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400/40',
          invalid ? 'border-rose-500/60' : 'border-emerald-500/40',
        )}
      />
    )
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      title="Click to edit VM ID"
      className={cn(
        'group flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors',
        'hover:bg-emerald-500/10',
      )}
    >
      <span className="font-mono text-sm text-foreground">{value || 'User Agent'}</span>
      <Pencil className="size-3 text-slate-500 opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  )
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function VMPairBook() {
  const router = useRouter()
  const {
    updatePair, activePairIndex, pairs, hydrateConfig,
    setPhase, setPrePhaseStatus, setCleanupStatus,
    setCallEvents, setCallSpines, setAggregate, updateUACMetrics,
    resetRunState, uacMetrics,
  } = useTrafficStore()

  const [raw, setRaw] = useState<RawVMFormValues>(DEFAULTS)
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [reachability, setReachability] = useState<ReachabilityStatus | null>(null)
  const [configHostHealth, setConfigHostHealth] = useState<HostHealth | null>(null)
  const [validationPassed, setValidationPassed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isStartingNewRun, setIsStartingNewRun] = useState(false)
  const [configPushError, setConfigPushError] = useState<string | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  // Active config tab. Defaults to "server" — the most-edited group on a
  // first-time setup. Controlled (vs. defaultValue) so we can auto-switch
  // to the first tab containing errors after Validate is clicked.
  const [activeTab, setActiveTab] = useState<'server' | 'signaling' | 'media' | 'traffic'>('server')
  const reachabilityTriggeredRef = useRef(false)

  // Load full config from localStorage on first mount
  useEffect(() => { hydrateConfig() }, [hydrateConfig])

  // Restore form from saved pair after hydration (runs once per saved pair)
  const hasHydratedFormRef = useRef(false)
  useEffect(() => {
    if (hasHydratedFormRef.current) return
    const p = pairs[activePairIndex]
    if (!p?.saved) return
    hasHydratedFormRef.current = true
    setRaw(pairToRaw(p))
    setValidationPassed(true)
  }, [pairs, activePairIndex])

  // Keep ext_end derived from Starting Extension + # of Extensions. The
  // backend still receives ext_start/ext_end; the GUI no longer asks the
  // operator to calculate the ending extension manually.
  useEffect(() => {
    const start = parseInt(raw.ext_start) || 0
    const count = parseInt(raw.ext_count) || 0
    const end = start > 0 && count > 0 ? start + count - 1 : 0
    const nextEnd = end > 0 ? String(end) : ''
    if (raw.ext_end !== nextEnd) {
      setRaw((prev) => ({ ...prev, ext_end: nextEnd }))
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw.ext_start, raw.ext_count])

  // Keep store connection info in sync with live form
  useEffect(() => {
    const p = pairs[activePairIndex]
    if (!p) return
    const port = parseInt(raw.metrics_port) || p.uac.metrics_port
    if (
      p.uac.vm_ip === raw.vm_ip &&
      p.uac.metrics_port === port &&
      p.uac.vm_id === raw.vm_id
    ) return
    updatePair(activePairIndex, {
      ...p,
      uac: { ...p.uac, vm_ip: raw.vm_ip, metrics_port: port, vm_id: raw.vm_id },
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw.vm_ip, raw.metrics_port, raw.vm_id])

  const errors = useMemo(() => getErrors(raw), [raw])
  const warnings = useMemo(() => getFieldWarnings(raw), [raw])

  const isValid = Object.keys(errors).length === 0
  const backendPhase = (uacMetrics?.phase ?? '').toUpperCase()
  const requiresNewRun =
    backendPhase === 'DONE' ||
    backendPhase === 'COMPLETE' ||
    backendPhase === 'FAILED' ||
    backendPhase === 'CLEANUP_READY' ||
    backendPhase === 'CLEANING_UP'
  const newRunErrorActive =
    !!configPushError &&
    (configPushError.toLowerCase().includes('start new run') ||
      configPushError.toLowerCase().includes('previous run'))
  const newRunBlocked = requiresNewRun || newRunErrorActive
  const cleanupInProgress = backendPhase === 'CLEANING_UP'

  const waitForRunDone = useCallback(async (ip: string, port: number) => {
    const deadline = Date.now() + 35 * 60 * 1000
    while (Date.now() < deadline) {
      const m = await getMetricsFor(ip, port)
      const phase = (m.phase ?? '').toUpperCase()
      if (phase === 'DONE' || phase === 'COMPLETE' || phase === 'FAILED') {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('Timed out waiting for cleanup to complete')
  }, [])

  const handleStartNewRun = useCallback(async () => {
    if (isStartingNewRun) return
    const endpoint = selectedEngineEndpoint({ vm_ip: raw.vm_ip || '127.0.0.1', metrics_port: parseInt(raw.metrics_port) || 8082 })
    const vmIp = endpoint.ip
    const metricsPort = endpoint.port
    setIsStartingNewRun(true)
    setConfigPushError(null)
    try {
      if (!IS_MOCK) {
        const res = await startNewRunFor(vmIp, metricsPort)
        if (res.status === 'cleanup_started') {
          await waitForRunDone(vmIp, metricsPort)
          await startNewRunFor(vmIp, metricsPort)
        }
      }
      resetRunState()
      setPhase('IDLE')
      setPrePhaseStatus({
        vm_id: raw.vm_id || 'traffic-local',
        register_complete: false,
        register_count: 0,
        register_total: 0,
        subscribe_complete: false,
        subscribe_count: 0,
        subscribe_total: 0,
        extensions_ready: false,
        idle_count: 0,
        reg_only_count: 0,
      })
      setCleanupStatus(null)
      setCallEvents([])
      setCallSpines([])
      setAggregate(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start new run'
      setConfigPushError(msg)
    } finally {
      setIsStartingNewRun(false)
    }
  }, [
    isStartingNewRun,
    raw.vm_ip,
    raw.metrics_port,
    raw.vm_id,
    resetRunState,
    setPhase,
    setPrePhaseStatus,
    setCleanupStatus,
    setCallEvents,
    setCallSpines,
    setAggregate,
    waitForRunDone,
  ])

  // Reachability
  const checkReachability = useCallback(
    async (vmIp: string, metricsPort: number) => {
      const vmId = raw.vm_id
      if (!vmIp || !metricsPort) return
      setReachability({ vm_id: vmId, reachable: false, checking: true })
      if (IS_MOCK) {
        await new Promise((r) => setTimeout(r, 800))
        setReachability({ vm_id: vmId, reachable: true, checking: false })
        return
      }
      const endpoint = selectedEngineEndpoint({ vm_ip: vmIp, metrics_port: metricsPort })
      const result = await checkHealth(endpoint.ip, endpoint.port)
      setReachability({ vm_id: vmId, reachable: result.reachable, checking: false, error: result.reachable ? undefined : (result.error ?? 'Connection refused') })
      if (result.reachable) {
        const metrics = await getMetricsFor(endpoint.ip, endpoint.port).catch(() => null)
        setConfigHostHealth(metrics?.host_health ?? null)
      } else {
        setConfigHostHealth(null)
      }
    },
    [raw.vm_id]
  )

  useEffect(() => {
    if (reachabilityTriggeredRef.current) return
    const metricsPort = parseInt(raw.metrics_port) || 0
    if (!raw.vm_ip || !metricsPort) return
    reachabilityTriggeredRef.current = true
    checkReachability(raw.vm_ip, metricsPort)
  }, [checkReachability, raw.vm_ip, raw.metrics_port])

  useEffect(() => {
    if (IS_MOCK || !reachability?.reachable) return
    const vmIp = raw.vm_ip
    const metricsPort = parseInt(raw.metrics_port) || 0
    if (!vmIp || !metricsPort) return
    const id = setInterval(async () => {
      const endpoint = selectedEngineEndpoint({ vm_ip: vmIp, metrics_port: metricsPort })
      const metrics = await getMetricsFor(endpoint.ip, endpoint.port).catch(() => null)
      if (metrics?.host_health) setConfigHostHealth(metrics.host_health)
    }, 10000)
    return () => clearInterval(id)
  }, [reachability?.reachable, raw.vm_ip, raw.metrics_port])

  // Cmd/Ctrl+I keyboard shortcut: toggle the Config Review drawer.
  // Skipped while focus is inside a form input so users can still type "i".
  // Other shortcuts (Cmd+Enter for Validate, Cmd+S for Save) are wired via
  // a separate effect AFTER handleSaveAndContinue is declared (see below).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'i') return
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
      e.preventDefault()
      setSummaryOpen((o) => !o)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const handleChange = useCallback(
    (field: keyof RawVMFormValues, value: string | string[] | boolean) => {
      setRaw((prev) => ({ ...prev, [field]: value }))
      setValidationPassed(false)
    },
    []
  )

  const handleResetSection = useCallback(
    (fields: (keyof RawVMFormValues)[]) => {
      setRaw((prev) => {
        const next = { ...prev }
        for (const f of fields) {
          (next as Record<string, unknown>)[f] = DEFAULTS[f]
        }
        return next
      })
      setTouched((prev) => {
        const next = new Set(prev)
        for (const f of fields) next.delete(f)
        return next
      })
      setValidationPassed(false)
    },
    []
  )

  const handleClearAll = useCallback(() => {
    setRaw(DEFAULTS)
    setTouched(new Set())
    setValidationPassed(false)
  }, [])

  const handleBlur = useCallback(
    (field: string) => setTouched((prev) => new Set([...prev, field])),
    []
  )

  // Per-tab error counts — used to render small red badges on each tab
  // trigger so users see at a glance which tab needs attention.
  const tabErrCount = useCallback(
    (tab: 'server' | 'signaling' | 'media' | 'traffic') =>
      TAB_FIELDS[tab].reduce((n, f) => (errors[f] ? n + 1 : n), 0),
    [errors],
  )

  const handleValidate = () => {
    setTouched(new Set(UA_FIELDS))
    if (IS_MOCK || isValid) {
      setValidationPassed(true)
      return
    }
    // Validation failed — jump to the first tab containing an error so the
    // user sees the offending field without having to click around. Order
    // here matches the visible tab order (server → signaling → media → traffic).
    for (const tab of ['server', 'signaling', 'media', 'traffic'] as const) {
      if (tabErrCount(tab) > 0) {
        setActiveTab(tab)
        break
      }
    }
  }

  const handleSaveAndContinue = async () => {
    if (!validationPassed || isSaving) return
    if (newRunBlocked) {
      setConfigPushError('Previous run is still active or complete. Click Start New Run before continuing.')
      return
    }
    setIsSaving(true)
    setConfigPushError(null)

    const uac = parseRaw(raw) as VMConfig
    const adv = pairs[activePairIndex]?.advancedSettings ?? DEFAULT_ADVANCED_SETTINGS
    const payload = { ...uac, ...adv }

    const currentPair: VMPair = pairs[activePairIndex] ?? {
      pair_id: 'pair-1',
      pair_label: 'Pair 1',
      uac,
      advancedSettings: adv,
      validated: true,
      saved: true,
    }

    if (IS_MOCK) {
      await new Promise((r) => setTimeout(r, 600))
    } else {
      try {
        const endpoint = selectedEngineEndpoint(uac)
        await putConfigFor(endpoint.ip, endpoint.port, payload)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to push config'
        setConfigPushError(msg)
        setIsSaving(false)
        return
      }
    }

    updatePair(activePairIndex, { ...currentPair, uac, advancedSettings: adv, validated: true, saved: true })
    updateUACMetrics({
      vm_id: uac.vm_id ?? 'traffic-local',
      phase: 'IDLE',
      running: false,
      cps_actual: 0,
      concurrent_calls: 0,
      calls_invite_sent: 0,
      calls_attempted: 0,
      calls_answered: 0,
      calls_acknowledged: 0,
      calls_completed: 0,
      calls_failed: 0,
      asr: 0,
      avg_pdd_ms: 0,
      min_pdd_ms: 0,
      max_pdd_ms: 0,
      avg_hold_ms: 0,
      socket_count: 0,
      transport_connect_total: 0,
      transport_connect_done: 0,
      transport_connect_failed: 0,
      transport_connect_active: false,
      registered_count: 0,
      registered_total: 0,
      subscribed_count: 0,
      subscribed_total: 0,
      idle_count: 0,
      non_idle_count: 0,
      reg_only_count: 0,
      uac_idle_count: 0,
      uas_idle_count: 0,
      uac_assigned_count: 0,
      uas_assigned_count: 0,
      regsub_ready_count: 0,
      required_ready_count: 0,
      regsub_background_active: false,
      regsub_complete: false,
      run_elapsed_seconds: 0,
      media_quality_counts: { OK: 0, WARNING: 0, CRITICAL: 0, UNKNOWN: 0 },
      host_health: {},
      parser_health: {},
      media_security: uac.media_security ?? 'rtp',
    })
    setPhase('IDLE')
    setPrePhaseStatus({
      vm_id: uac.vm_id ?? 'traffic-local',
      register_complete: false,
      register_count: 0,
      register_total: 0,
      subscribe_complete: false,
      subscribe_count: 0,
      subscribe_total: 0,
      extensions_ready: false,
      idle_count: 0,
      reg_only_count: 0,
    })
    setCleanupStatus(null)
    setCallEvents([])
    setCallSpines([])
    setAggregate(null)
    setIsSaving(false)
    router.push('/launch')
  }

  // Keyboard shortcuts wired AFTER handleSaveAndContinue so the closure can
  // reference it. The latestRef pattern keeps the listener registered exactly
  // once — no stale closures, no per-render re-registration.
  const latestRef = useRef({ errors, validationPassed, isSaving, handleSaveAndContinue })
  useEffect(() => {
    latestRef.current = { errors, validationPassed, isSaving, handleSaveAndContinue }
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      // Cmd/Ctrl + Enter — Validate. Allowed even while focus is in an input
      // (matches the muscle-memory of "press Enter to submit").
      if (e.key === 'Enter') {
        e.preventDefault()
        setTouched(new Set(UA_FIELDS))
        if (IS_MOCK || Object.keys(latestRef.current.errors).length === 0) {
          setValidationPassed(true)
        }
        return
      }
      // Cmd/Ctrl + S — Save & Continue. Skipped silently when prerequisites
      // aren't met; the button itself is also disabled until then.
      if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        const { validationPassed: ok, isSaving: saving, handleSaveAndContinue: save } = latestRef.current
        if (ok && !saving) save()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const errorCount = Object.keys(errors).length
  const hasValidated = touched.size > 0

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto bg-background">
        {/* Single-column layout — Config Summary moved to sticky footer strip
            (always visible) plus a Config Review drawer (Cmd/Ctrl+I). The
            full-width form area gives the inputs the room they need without
            wasting 280px on a permanent sidebar. */}
        <div className="mx-auto w-full max-w-[1440px] px-6 py-5">
          {configHostHealth && (
            <div className="mb-5">
              <VMHealthPanel health={configHostHealth} variant="compact" />
            </div>
          )}
          {newRunBlocked && (
            <div className="mb-5 rounded-lg border border-amber-500/35 bg-amber-500/10 p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex gap-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" />
                  <div>
                    <p className="text-sm font-semibold text-amber-200">Previous run state is still active</p>
                    <p className="mt-1 text-xs text-amber-100/80">
                      Click <span className="font-semibold">Start New Run</span> to clear counters, cleanup status, and ready-pool state before continuing. Your config values will be kept.
                    </p>
                    {cleanupInProgress && (
                      <p className="mt-1 text-xs text-amber-100/70">Cleanup is in progress. New Run will be available after cleanup completes.</p>
                    )}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cleanupInProgress || isStartingNewRun}
                  onClick={handleStartNewRun}
                  className="gap-2 border-amber-500/50 text-amber-100 hover:bg-amber-500/10"
                >
                  {isStartingNewRun ? (
                    <><Loader2 className="size-3.5 animate-spin" />Starting…</>
                  ) : (
                    <><RotateCcw className="size-3.5" />Start New Run</>
                  )}
                </Button>
              </div>
            </div>
          )}

          {/* Responsive split: at lg+ (>=1280px) the sticky Config Summary
              sidebar is visible to the right; below lg the form takes the
              full canvas and the footer strip + drawer (always mounted)
              provide summary access. */}
          {/* Wide sidebar (480px) gives the Config Summary plenty of
              room to render long values like "10.133.63.117:5060/TCP"
              without truncation. The form column shrinks correspondingly
              — its right-sized fields and multi-field rows don't need
              the extra horizontal real estate. */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_480px]">

          {/* UA card — tabbed layout. Header (UA badge + InlineVMIdEditor)
              stays visible across all tabs; the form content is split into
              three tabs so each one fits one viewport on a typical laptop. */}
          <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">

            {/* Persistent header */}
            <div className="flex items-center border-b border-border px-4 py-2.5">
              <div className="flex flex-1 items-center gap-2 px-2">
                <span className="rounded px-2 py-0.5 text-xs font-bold tracking-widest bg-emerald-500/15 text-emerald-400">
                  UA
                </span>
                <InlineVMIdEditor
                  value={raw.vm_id}
                  onChange={(v) => handleChange('vm_id', v)}
                  onBlur={() => handleBlur('vm_id')}
                  invalid={touched.has('vm_id') && !!errors.vm_id}
                />
                {touched.has('vm_id') && errors.vm_id && (
                  <span className="text-[10px] text-rose-400">{errors.vm_id}</span>
                )}
                {hasValidated && errorCount > 0 && (
                  <span className="ml-auto text-xs font-semibold text-rose-400">
                    {errorCount} error{errorCount !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>

            {/* Tabs */}
            <Tabs
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as 'server' | 'signaling' | 'media' | 'traffic')}
              className="gap-0"
            >
              {/* Tab strip — pills inside a single slate-tinted container,
                  iOS Settings / Stripe style. The container has a thin
                  border + soft fill so the whole control reads as a tab
                  group; the active pill is solid orange (fill + white
                  text) and stands out unmistakably against the inactive
                  transparent pills. Symmetric vertical padding (py-3)
                  centers the pill row.

                  Tab order is fixed: SERVER & AUTH → SIGNALING → MEDIA & QOS
                  → TRAFFIC. Labels are intentionally UPPERCASE per UX spec. */}
              <div className="border-b border-border bg-card/40 px-4 py-3">
                <TabsList
                  variant="default"
                  className={cn(
                    'inline-flex h-auto items-center gap-1 rounded-lg p-1',
                    'border border-slate-700/60 bg-slate-800/60',
                  )}
                >
                  <ConfigTabTrigger value="server"    label="SERVER & AUTH"  errCount={hasValidated ? tabErrCount('server')    : 0} />
                  <ConfigTabTrigger value="signaling" label="SIGNALING"      errCount={hasValidated ? tabErrCount('signaling') : 0} />
                  <ConfigTabTrigger value="media"     label="MEDIA & QOS"    errCount={hasValidated ? tabErrCount('media')     : 0} />
                  <ConfigTabTrigger value="traffic"   label="TRAFFIC"        errCount={hasValidated ? tabErrCount('traffic')   : 0} />
                </TabsList>
              </div>

              <TabsContent value="server" className="m-0">
                <VMConfigPanel
                  raw={raw} onChange={handleChange} touched={touched} onBlur={handleBlur}
                  errors={errors} warnings={warnings}
                  reachability={reachability}
                  onCheckReachability={() => checkReachability(raw.vm_ip, parseInt(raw.metrics_port) || 0)}
                  onResetSection={handleResetSection}
                  tab="server"
                />
              </TabsContent>

              <TabsContent value="signaling" className="m-0">
                <VMConfigPanel
                  raw={raw} onChange={handleChange} touched={touched} onBlur={handleBlur}
                  errors={errors} warnings={warnings}
                  reachability={reachability}
                  onCheckReachability={() => checkReachability(raw.vm_ip, parseInt(raw.metrics_port) || 0)}
                  onResetSection={handleResetSection}
                  tab="signaling"
                />
                {/* SIP-side Advanced rows (REGISTER batching, retry,
                    SUBSCRIBE concurrency, TCP keepalive, 100rel) are
                    rendered here — semantically grouped with their
                    related VMConfig timer fields above. */}
                <motion.div className="overflow-hidden border-t border-border">
                  <AdvancedSettings pairIndex={activePairIndex} tab="signaling" />
                </motion.div>
              </TabsContent>

              <TabsContent value="media" className="m-0">
                <VMConfigPanel
                  raw={raw} onChange={handleChange} touched={touched} onBlur={handleBlur}
                  errors={errors} warnings={warnings}
                  reachability={reachability}
                  onCheckReachability={() => checkReachability(raw.vm_ip, parseInt(raw.metrics_port) || 0)}
                  onResetSection={handleResetSection}
                  tab="media"
                />
                {/* Media-side Advanced rows (RTP advanced, QoS, RTCP SR,
                    PCAP, metrics interval) — grouped with the Media (RTP)
                    section above. */}
                <motion.div className="overflow-hidden border-t border-border">
                  <AdvancedSettings pairIndex={activePairIndex} tab="media" />
                </motion.div>
              </TabsContent>

              <TabsContent value="traffic" className="m-0">
                <VMConfigPanel
                  raw={raw} onChange={handleChange} touched={touched} onBlur={handleBlur}
                  errors={errors} warnings={warnings}
                  reachability={reachability}
                  onCheckReachability={() => checkReachability(raw.vm_ip, parseInt(raw.metrics_port) || 0)}
                  onResetSection={handleResetSection}
                  tab="traffic"
                />
              </TabsContent>
            </Tabs>
          </div>

          {/* Sticky sidebar — visible only at lg+ (>=1280px). At narrower
              viewports the footer strip + drawer combo provides summary
              access without crowding the form. */}
          <div className="hidden lg:block">
            <ConfigSummarySidebar
              raw={raw}
              advancedSettings={pairs[activePairIndex]?.advancedSettings}
            />
          </div>

          </div>
        </div>
      </div>

      {/* Footer — sticky strip on top, action buttons below.
          The strip is hidden at lg+ where the sidebar takes its job. */}
      <div className="border-t border-border bg-card">
        <div className="lg:hidden">
          <ConfigSummaryStrip raw={raw} onOpenDrawer={() => setSummaryOpen(true)} />
        </div>
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearAll}
              className="gap-1.5 border-rose-500/30 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300"
              title="Clear all fields and reset to defaults"
            >
              <Trash2 className="size-3.5" />
              Clear All
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleValidate}
              title="Validate (⌘/Ctrl + Enter)"
            >
              Validate
            </Button>
            {hasValidated && errorCount > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-rose-400">
                <AlertTriangle className="size-3.5" />
                {errorCount} error{errorCount !== 1 ? 's' : ''}
              </span>
            )}
            {validationPassed && (
              <span className="flex items-center gap-1.5 text-xs text-emerald-400">
                <CheckCircle2 className="size-3.5" />
                All valid
              </span>
            )}
            {configPushError && (
              <span className="flex items-center gap-1.5 text-xs text-rose-400">
                <AlertTriangle className="size-3.5" />
                {configPushError}
              </span>
            )}
          </div>

          <Button
            size="sm"
            disabled={!validationPassed || isSaving || newRunBlocked}
            onClick={handleSaveAndContinue}
            title="Save & Continue (⌘/Ctrl + S)"
            className={cn(
              'transition-opacity',
              (!validationPassed || isSaving || newRunBlocked) && 'cursor-not-allowed opacity-40'
            )}
          >
            {isSaving ? (
              <><Loader2 className="mr-1.5 size-3.5 animate-spin" />Saving…</>
            ) : (
              <>Save &amp; Continue<ChevronRight className="ml-0.5 size-3.5" /></>
            )}
          </Button>
        </div>
      </div>

      {/* Config Review drawer — slides in from the right when the strip is
          clicked or Cmd/Ctrl+I is pressed. Includes the AdvancedSettings
          QoS / RTCP knobs from the active pair so the review is complete. */}
      <ConfigSummaryDrawer
        raw={raw}
        advancedSettings={pairs[activePairIndex]?.advancedSettings}
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
      />
    </div>
  )
}
