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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { VMConfigPanel, type RawVMFormValues, TAB_FIELDS } from './VMConfigPanel'
import { AdvancedSettings } from './AdvancedSettings'
import { ConfigSummaryStrip, ConfigSummaryDrawer, ConfigSummarySidebar } from './ConfigSummary'
import { VMConfigSchema, getFieldWarnings } from '@/lib/config-schema'
import { useTrafficStore } from '@/store/traffic'
import { checkHealth, putConfigFor } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { VMConfig, VMPair, ReachabilityStatus, SipScheme, RtpCodec, TLSMode } from '@/types'
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
  ext_start: '4001000',
  ext_end: '4001009',
  ext_count: '10',
  register_expires: '3600',
  subscribe_expires: '3600',
  register_rate_cps: '10',
  t1_ms: '500',
  timer_b_seconds: '32',
  sbc_host: '10.133.63.117',
  sbc_port: '5060',
  secondary_host: '',
  secondary_port: '5060',
  failover_enabled: false,
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
  cps: '1',
  hold_time_seconds: '5',
  media_enabled: true,
  rtp_codec: 'G711_ULAW',
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
  'sbc_host', 'sbc_port', 'sip_transport', 'domain', 'sip_password',
  'cps', 'hold_time_seconds', 'metrics_port', 'traffic_mode', 'call_count',
  'duration_hours',
]

// ---------------------------------------------------------------------------
// pairToRaw — restores saved VMPair.uac back into form string values
// ---------------------------------------------------------------------------

function pairToRaw(p: VMPair): RawVMFormValues {
  const u = p.uac
  const extStart = u.ext_start ?? parseInt(DEFAULTS.ext_start)
  const extEnd   = u.ext_end   ?? parseInt(DEFAULTS.ext_end)
  return {
    vm_id:              u.vm_id            ?? DEFAULTS.vm_id,
    vm_ip:              u.vm_ip            ?? DEFAULTS.vm_ip,
    ssh_user:           u.ssh_user         ?? '',
    ssh_key_path:       u.ssh_key_path     ?? '',
    ext_start:          String(extStart),
    ext_end:            String(extEnd),
    ext_count:          String(Math.max(extEnd - extStart + 1, 0)),
    register_expires:   String(u.register_expires   ?? parseInt(DEFAULTS.register_expires)),
    subscribe_expires:  String(u.subscribe_expires  ?? parseInt(DEFAULTS.subscribe_expires)),
    register_rate_cps:  String(u.register_rate_cps  ?? parseFloat(DEFAULTS.register_rate_cps)),
    t1_ms:              String(u.t1_ms              ?? parseInt(DEFAULTS.t1_ms)),
    timer_b_seconds:    String(u.timer_b_seconds    ?? parseInt(DEFAULTS.timer_b_seconds)),
    sbc_host:           u.sbc_host         ?? DEFAULTS.sbc_host,
    sbc_port:           String(u.sbc_port  ?? parseInt(DEFAULTS.sbc_port)),
    secondary_host:     u.secondary_host   ?? '',
    secondary_port:     String(u.secondary_port ?? parseInt(DEFAULTS.secondary_port)),
    failover_enabled:   u.failover_enabled ?? false,
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
    cps:                String(u.cps               ?? parseFloat(DEFAULTS.cps)),
    hold_time_seconds:  String(u.hold_time_seconds ?? parseFloat(DEFAULTS.hold_time_seconds)),
    media_enabled:      u.media_enabled    ?? true,
    rtp_codec:          (u.rtp_codec       ?? 'G711_ULAW') as RtpCodec,
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

function parseRaw(raw: RawVMFormValues): Partial<VMConfig> {
  return {
    vm_id: raw.vm_id,
    vm_ip: raw.vm_ip,
    ssh_user: raw.ssh_user || undefined,
    ssh_key_path: raw.ssh_key_path || undefined,
    ext_start: parseInt(raw.ext_start) || 0,
    ext_end: parseInt(raw.ext_end) || 0,
    sbc_host: raw.sbc_host,
    sbc_port: parseInt(raw.sbc_port) || 0,
    secondary_host: raw.failover_enabled ? (raw.secondary_host || undefined) : undefined,
    secondary_port: raw.failover_enabled ? (parseInt(raw.secondary_port) || undefined) : undefined,
    failover_enabled: raw.failover_enabled || undefined,
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
    register_expires: raw.register_expires ? parseInt(raw.register_expires) : undefined,
    subscribe_expires: raw.subscribe_expires ? parseInt(raw.subscribe_expires) : undefined,
    register_rate_cps: raw.register_rate_cps ? parseFloat(raw.register_rate_cps) : undefined,
    t1_ms: raw.t1_ms ? parseInt(raw.t1_ms) : undefined,
    timer_b_seconds: raw.timer_b_seconds ? parseInt(raw.timer_b_seconds) : undefined,
    cps: parseFloat(raw.cps) || 0,
    hold_time_seconds: parseFloat(raw.hold_time_seconds) || 0,
    media_enabled: raw.media_enabled,
    rtp_codec: raw.rtp_codec as RtpCodec,
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
 * ConfigTabTrigger — boxed browser-tab style on dark background.
 * Inactive tabs: subtle muted-orange text + transparent fill + thin border
 * so they unmistakably look like tabs (not labels).
 * Active tab: vivid orange text + filled bg + visible border on top/sides;
 * the bottom border merges into the form panel below to convey "this tab
 * owns the panel beneath."
 *
 * Orange (rather than rose-red or amber) was picked because rose is already
 * the error palette and amber is the warning palette — orange is the only
 * warm hue free of semantic baggage in this codebase.
 */
function ConfigTabTrigger({
  value,
  label,
  errCount,
}: {
  value: 'server' | 'traffic' | 'media'
  label: string
  errCount: number
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        // Layout — much bigger / taller so the tabs read clearly as
        // navigation rather than as labels. Increased font size and
        // generous padding make them legible across the room.
        'h-11 px-5 text-base font-bold uppercase tracking-wide transition-colors',
        // Browser-tab shape: rounded top, flat bottom, sits ON the panel.
        // border-[3px] gives the tab a thick, unmistakable outline
        // against the dark page background.
        'rounded-t-lg rounded-b-none border-[3px] border-b-0',
        // Inactive state — clearly VISIBLE orange border + medium slate
        // fill. The orange tint at /60 opacity unifies the whole tab
        // strip and reads as "this is a tab control" at a glance.
        'border-orange-500/60 bg-slate-800/70 text-orange-200/80',
        'hover:bg-slate-700/80 hover:text-orange-100 hover:border-orange-400/80',
        // Active state — full vivid orange border + brighter fill + soft
        // glow. The -mb-[3px] nudges the active trigger down 3px (matches
        // border-[3px]) so its bottom edge overlaps the panel border for
        // the "tab merges with content" effect.
        'data-[state=active]:-mb-[3px]',
        'data-[state=active]:border-orange-400',
        'data-[state=active]:bg-orange-500/20',
        'data-[state=active]:text-orange-100',
        'data-[state=active]:shadow-[0_-4px_14px_-4px_rgba(251,146,60,0.6)]',
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
  const { updatePair, activePairIndex, pairs, hydrateConfig } = useTrafficStore()

  const pair = pairs[activePairIndex]
  const [raw, setRaw] = useState<RawVMFormValues>(DEFAULTS)
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [reachability, setReachability] = useState<ReachabilityStatus | null>(null)
  const [validationPassed, setValidationPassed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [configPushError, setConfigPushError] = useState<string | null>(null)
  const [summaryOpen, setSummaryOpen] = useState(false)
  // Active config tab. Defaults to "server" — the most-edited group on a
  // first-time setup. Controlled (vs. defaultValue) so we can auto-switch
  // to the first tab containing errors after Validate is clicked.
  const [activeTab, setActiveTab] = useState<'server' | 'traffic' | 'media'>('server')
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

  // Keep ext_count derived
  useEffect(() => {
    const start = parseInt(raw.ext_start) || 0
    const end = parseInt(raw.ext_end) || 0
    const count = end >= start && start > 0 ? end - start + 1 : 0
    setRaw((prev) => ({ ...prev, ext_count: count > 0 ? String(count) : '' }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw.ext_start, raw.ext_end])

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
      const result = await checkHealth(vmIp, metricsPort)
      setReachability({ vm_id: vmId, reachable: result.reachable, checking: false, error: result.reachable ? undefined : (result.error ?? 'Connection refused') })
    },
    [raw.vm_id]
  )

  useEffect(() => {
    if (!IS_MOCK || reachabilityTriggeredRef.current) return
    reachabilityTriggeredRef.current = true
    checkReachability(DEFAULTS.vm_ip, parseInt(DEFAULTS.metrics_port))
  }, [checkReachability])

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
    (field: keyof RawVMFormValues, value: string | boolean) => {
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
    (tab: 'server' | 'traffic' | 'media') =>
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
    // user sees the offending field without having to click around.
    for (const tab of ['server', 'traffic', 'media'] as const) {
      if (tabErrCount(tab) > 0) {
        setActiveTab(tab)
        break
      }
    }
  }

  const handleSaveAndContinue = async () => {
    if (!validationPassed || isSaving) return
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
        await putConfigFor(uac.vm_ip, uac.metrics_port, payload)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to push config'
        setConfigPushError(msg)
        setIsSaving(false)
        return
      }
    }

    updatePair(activePairIndex, { ...currentPair, uac, advancedSettings: adv, validated: true, saved: true })
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

          {/* Responsive split: at lg+ (>=1280px) the sticky Config Summary
              sidebar is visible to the right; below lg the form takes the
              full canvas and the footer strip + drawer (always mounted)
              provide summary access. */}
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">

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
              onValueChange={(v) => setActiveTab(v as 'server' | 'traffic' | 'media')}
              className="gap-0"
            >
              {/* Tab strip — sits above the form panel. The boxed
                  ConfigTabTrigger is taller than the line variant, so the
                  container needs more vertical room. The bottom border of
                  this strip becomes the "shelf" the tabs visually sit on,
                  and the active tab's -mb-px overlaps it for a seamless
                  browser-tab merge with the form below. */}
              <div className="relative border-b border-border bg-card/40 px-4 pt-2 pb-0">
                <TabsList
                  variant="line"
                  className="h-auto gap-1.5 bg-transparent p-0"
                >
                  <ConfigTabTrigger value="server"  label="Server & Auth"        errCount={hasValidated ? tabErrCount('server')  : 0} />
                  <ConfigTabTrigger value="traffic" label="Traffic & Registration" errCount={hasValidated ? tabErrCount('traffic') : 0} />
                  <ConfigTabTrigger value="media"   label="Media & QoS"          errCount={hasValidated ? tabErrCount('media')   : 0} />
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

              <TabsContent value="media" className="m-0">
                <VMConfigPanel
                  raw={raw} onChange={handleChange} touched={touched} onBlur={handleBlur}
                  errors={errors} warnings={warnings}
                  reachability={reachability}
                  onCheckReachability={() => checkReachability(raw.vm_ip, parseInt(raw.metrics_port) || 0)}
                  onResetSection={handleResetSection}
                  tab="media"
                />
                {/* AdvancedSettings (Pre-Phase tuning, RTP advanced, QoS,
                    RTCP SR) lives in the Media & QoS tab — that's where
                    most of its knobs are semantically grouped. */}
                <motion.div className="overflow-hidden border-t border-border">
                  <AdvancedSettings pairIndex={activePairIndex} />
                </motion.div>
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
            disabled={!validationPassed || isSaving}
            onClick={handleSaveAndContinue}
            title="Save & Continue (⌘/Ctrl + S)"
            className={cn(
              'transition-opacity',
              (!validationPassed || isSaving) && 'cursor-not-allowed opacity-40'
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
