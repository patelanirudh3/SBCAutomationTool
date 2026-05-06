'use client'

import { useState, useEffect, type ReactNode } from 'react'
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
import { deriveExtCount } from '@/lib/config-schema'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Loader2, CheckCircle, XCircle, Signal, RotateCcw, Info, ChevronDown } from 'lucide-react'
import type { TrafficMode, SipTransport, SipScheme, RtpCodec, ReachabilityStatus, TLSMode } from '@/types'

// All form values stored as strings so inputs stay fully controlled
export type RawVMFormValues = {
  vm_id: string
  vm_ip: string
  ssh_user: string
  ssh_key_path: string
  // Unified extension pool (single range)
  ext_start: string
  ext_end: string
  ext_count: string
  // Registration / subscription
  register_expires: string
  subscribe_expires: string
  register_rate_cps: string
  // RFC 3261 INVITE client-transaction timers (UAC). Empty -> backend uses RFC defaults.
  t1_ms: string
  timer_b_seconds: string
  // SIP server
  sbc_host: string
  sbc_port: string
  secondary_host: string
  secondary_port: string
  failover_enabled: boolean
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
  // Traffic
  cps: string
  hold_time_seconds: string
  // Media
  media_enabled: boolean
  rtp_codec: RtpCodec
  rtp_ptime: string
  // Engine
  metrics_port: string
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
 *   server  → Traffic Agent Host + Remote SIP Server (incl. TLS / Failover / DNS)
 *   traffic → Extension Pool + Call Traffic + Registration & SIP Timers
 *   media   → Media (RTP). The AdvancedSettings card is rendered separately
 *             by the parent (VMPairBook) inside the same Media & QoS tab.
 */
export type VMConfigTab = 'server' | 'traffic' | 'media' | 'all'

export interface VMConfigPanelProps {
  raw: RawVMFormValues
  onChange: (field: keyof RawVMFormValues, value: string | boolean) => void
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
    'sbc_host', 'sbc_port', 'sip_transport', 'sip_scheme', 'domain', 'sip_password',
    'secondary_host', 'secondary_port', 'failover_enabled', 'dns_servers',
    'tls_mode', 'tls_ca_path', 'tls_cert_path', 'tls_key_path', 'tls_server_name',
  ],
  traffic: [
    'ext_start', 'ext_end',
    'cps', 'hold_time_seconds', 'traffic_mode', 'call_count', 'duration_hours', 'start_time_iso',
    'register_expires', 'subscribe_expires', 'register_rate_cps', 't1_ms', 'timer_b_seconds',
  ],
  media: ['media_enabled', 'rtp_codec', 'rtp_ptime'],
}

// Default values for the Registration section — used to detect "dirty" state
// and auto-expand the collapsed section when any value differs.
const DEFAULTS_REGISTRATION = {
  register_expires:  '3600',
  subscribe_expires: '3600',
  register_rate_cps: '10',
  t1_ms:             '500',
  timer_b_seconds:   '32',
}

// Fields belonging to each logical section — used by per-section Reset buttons
const SECTION_FIELDS = {
  identity:       ['vm_id'] as (keyof RawVMFormValues)[],
  agent_host:     ['vm_ip', 'metrics_port', 'ssh_user', 'ssh_key_path'] as (keyof RawVMFormValues)[],
  sip_server:     ['sbc_host', 'sbc_port', 'sip_transport', 'sip_scheme', 'domain', 'sip_password',
                   'secondary_host', 'secondary_port', 'failover_enabled', 'dns_servers',
                   'tls_mode', 'tls_ca_path', 'tls_cert_path', 'tls_key_path', 'tls_server_name'] as (keyof RawVMFormValues)[],
  extension_pool: ['ext_start', 'ext_end'] as (keyof RawVMFormValues)[],
  registration:   ['register_expires', 'subscribe_expires', 'register_rate_cps', 't1_ms', 'timer_b_seconds'] as (keyof RawVMFormValues)[],
  call_traffic:   ['cps', 'hold_time_seconds', 'traffic_mode', 'call_count', 'duration_hours', 'start_time_iso'] as (keyof RawVMFormValues)[],
  media:          ['media_enabled', 'rtp_codec', 'rtp_ptime'] as (keyof RawVMFormValues)[],
} as const

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return (
    <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-300">
      <span>{children}</span>
      <span className="h-px flex-1 bg-border" />
      {onReset && (
        <button
          type="button"
          onClick={onReset}
          className="flex items-center gap-1 text-[10px] normal-case tracking-normal font-normal text-slate-500 hover:text-slate-300 transition-colors"
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
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-300">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left transition-colors hover:text-emerald-400"
          aria-expanded={open}
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 text-slate-500 transition-transform duration-200',
              open && 'rotate-180',
            )}
          />
          <span>{title}</span>
          {dirty && (
            <span
              className="size-1.5 shrink-0 rounded-full bg-amber-400"
              title="Customised — click to expand"
            />
          )}
        </button>
        <span className="h-px flex-1 bg-border" />
        {onReset && open && (
          <button
            type="button"
            onClick={onReset}
            className="flex items-center gap-1 text-[10px] normal-case tracking-normal font-normal text-slate-500 hover:text-slate-300 transition-colors"
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
          <Info className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
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
    <div className="grid grid-cols-[140px_1fr] items-start gap-3 py-1">
      <Label className="flex h-8 items-center gap-1 text-xs font-medium text-foreground/80">
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
  const [showSuccess, setShowSuccess] = useState(false)
  const port = parseInt(metricsPort, 10)
  const canTest = !!vmIp && !Number.isNaN(port) && port > 0

  useEffect(() => {
    if (reachability?.reachable && !reachability.checking) {
      setShowSuccess(true)
      const t = setTimeout(() => setShowSuccess(false), 3000)
      return () => clearTimeout(t)
    }
  }, [reachability?.reachable, reachability?.checking])

  if (!canTest) return null

  if (reachability?.checking) {
    return (
      <Button type="button" variant="outline" size="sm" disabled className="shrink-0 gap-1.5 font-mono text-xs">
        <Loader2 className="size-3 animate-spin" />
        Checking…
      </Button>
    )
  }

  if (showSuccess && reachability?.reachable) {
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

  // Keep bhcc display in sync when cps changes externally (e.g., from store load)
  useEffect(() => {
    if (inputMode === 'cps') {
      const c = parseFloat(cps)
      if (Number.isFinite(c) && c > 0) {
        setBhccDraft(String(Math.round(c * 3600)))
      } else {
        setBhccDraft('')
      }
    }
  }, [cps, inputMode])

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
        <span className="text-[10px] font-medium text-slate-400">cps</span>
        <span className="text-slate-500">·</span>
        <Input
          type="number"
          min={1}
          step={1}
          value={bhccDraft}
          onChange={(ev) => handleBhccChange(ev.target.value)}
          onBlur={onBlur}
          className={cn(
            'w-20 font-mono',
            inputMode === 'bhcc' ? 'ring-1 ring-amber-500/40' : '',
          )}
          placeholder={bhccNum ? String(bhccNum) : '—'}
        />
        <span className="text-[10px] font-medium text-slate-400">bhcc</span>
        <span className="text-slate-500">·</span>
        <Input
          type="number"
          min={0}
          value={holdSeconds}
          onChange={(ev) => onHoldChange(ev.target.value)}
          onBlur={onHoldBlur}
          className="w-14 font-mono"
          aria-invalid={!!holdError ? true : undefined}
        />
        <span className="text-[10px] font-medium text-slate-400">s hold</span>
        {bhccNum !== null && (
          <span className="ml-1 font-mono text-[11px] text-amber-400/80">
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
  const showServer  = tab === 'all' || tab === 'server'
  const showTraffic = tab === 'all' || tab === 'traffic'
  const showMedia   = tab === 'all' || tab === 'media'
  const e = (field: string) => (touched.has(field) ? errors[field] : undefined)
  const w = (field: string) => (touched.has(field) ? warnings[field] : undefined)
  const t = (field: string) => touched.has(field)

  const extCount = deriveExtCount(parseInt(raw.ext_start), parseInt(raw.ext_end))

  const handleIpBlur = () => {
    onBlur('vm_ip')
    if (raw.vm_ip && raw.metrics_port) onCheckReachability()
  }

  const handleMetricsPortBlur = () => {
    onBlur('metrics_port')
    if (raw.vm_ip && raw.metrics_port) onCheckReachability()
  }

  const ptimeNum = parseInt(raw.rtp_ptime, 10) || 20
  const ppsDisplay = Math.round(1000 / ptimeNum)

  // Subscribe Expires is identical to Register Expires in 99% of deployments.
  // Hide it behind a "Customise" toggle that's auto-on when the values differ
  // (so previously-customised configs keep showing the field on reload).
  const [customSub, setCustomSub] = useState(
    raw.subscribe_expires !== '' && raw.subscribe_expires !== raw.register_expires,
  )
  // When the toggle is OFF, keep subscribe_expires in lock-step with
  // register_expires so the value stored / saved is still correct.
  useEffect(() => {
    if (!customSub && raw.subscribe_expires !== raw.register_expires) {
      onChange('subscribe_expires', raw.register_expires)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customSub, raw.register_expires])

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

  return (
    <div className="space-y-4 px-4 py-4">

      {/* Identity (vm_id) is now click-to-edit inline in the UA card header
          — see VMPairBook.tsx. The dedicated Identity section was removed
          since it held only one field. */}

      {/* ── Traffic Agent Host (Server tab) ──────────────────── */}
      {showServer && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.agent_host)}>Traffic Agent Host</SectionHeader>
        <FormRow label="IP Address" error={e('vm_ip')}>
          <Input
            value={raw.vm_ip}
            onChange={(ev) => onChange('vm_ip', ev.target.value)}
            onBlur={handleIpBlur}
            placeholder="127.0.0.1"
            className="w-36 font-mono"
            aria-invalid={t('vm_ip') && !!errors.vm_ip ? true : undefined}
          />
        </FormRow>
        <FormRow label="Metrics Port" error={e('metrics_port')} warning={w('metrics_port')}>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              value={raw.metrics_port}
              onChange={(ev) => onChange('metrics_port', ev.target.value)}
              onBlur={handleMetricsPortBlur}
              placeholder="8082"
              className="w-24 font-mono"
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
        </FormRow>
        <p className="ml-[140px] pl-3 text-[11px] text-slate-400">
          Health:{' '}
          <span className="font-mono text-sky-400 underline decoration-sky-400/30 underline-offset-2">
            {`http://${raw.vm_ip || '<ip>'}:${raw.metrics_port || '<port>'}/api/ping`}
          </span>
        </p>
        {/* SSH credentials — auto-hidden when the agent runs locally
            (vm_ip is loopback). Shown automatically as soon as a remote IP
            is entered, or when the user has previously typed a value. */}
        {showSSHFields && (
          <>
            <FormRow
              label="SSH User"
              error={e('ssh_user')}
              hint="Only needed when connecting to a remote VM."
            >
              <Input
                value={raw.ssh_user}
                onChange={(ev) => onChange('ssh_user', ev.target.value)}
                onBlur={() => onBlur('ssh_user')}
                placeholder="ubuntu"
                className="w-36"
              />
            </FormRow>
            <FormRow
              label="SSH Key Path"
              error={e('ssh_key_path')}
              hint="Path to the private key for SSH access to a remote VM."
            >
              <Input
                value={raw.ssh_key_path}
                onChange={(ev) => onChange('ssh_key_path', ev.target.value)}
                onBlur={() => onBlur('ssh_key_path')}
                placeholder="/home/user/.ssh/id_rsa"
                className="w-72 font-mono text-xs"
              />
            </FormRow>
          </>
        )}
      </div>
      )}

      {/* ── Remote SIP Server (Server tab) ──────────────────────── */}
      {showServer && (
      <div className="space-y-2">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.sip_server)}>Remote SIP Server</SectionHeader>

        {/* Endpoint row — Host : Port + Transport packed onto one line.
            Reads naturally as "10.0.0.1 : 5060 TCP". */}
        <FormRow
          label="Endpoint"
          hint="Target SBC, SIP proxy, or any SIP server receiving calls. Host accepts IP or FQDN."
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Input
              value={raw.sbc_host}
              onChange={(ev) => onChange('sbc_host', ev.target.value)}
              onBlur={() => onBlur('sbc_host')}
              placeholder="x.x.x.x"
              className="w-36 font-mono"
              aria-invalid={t('sbc_host') && !!errors.sbc_host ? true : undefined}
            />
            <span className="text-slate-500">:</span>
            <Input
              type="number"
              value={raw.sbc_port}
              onChange={(ev) => onChange('sbc_port', ev.target.value)}
              onBlur={() => onBlur('sbc_port')}
              placeholder="5060"
              className="w-20 font-mono"
              aria-invalid={t('sbc_port') && !!errors.sbc_port ? true : undefined}
            />
            <Select
              value={raw.sip_transport}
              onValueChange={(v) => { onChange('sip_transport', v as SipTransport); onBlur('sip_transport') }}
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
        </FormRow>

        {/* Identity row — Scheme + Domain packed onto one line. */}
        <FormRow
          label="Identity"
          hint="Scheme: SIP = plain (port 5060). SIPS = secure (port 5061). Domain is the SIP realm sent in From/To URIs."
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <Select
              value={raw.sip_scheme}
              onValueChange={(v) => { onChange('sip_scheme', v as SipScheme); onBlur('sip_scheme') }}
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
              className="w-40 font-mono"
              aria-invalid={t('domain') && !!errors.domain ? true : undefined}
            />
          </div>
          {(e('sip_scheme') || e('domain')) && (
            <>
              {e('sip_scheme') && <FieldError error={e('sip_scheme')} />}
              {e('domain')     && <FieldError error={e('domain')} />}
            </>
          )}
        </FormRow>

        {raw.sip_transport === 'TLS' && (
          <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-amber-300">
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

            {(raw.tls_mode === 'server_ca' || raw.tls_mode === 'mutual') && (
              <FormRow
                label="CA Cert Path"
                error={e('tls_ca_path')}
                hint="PEM file on the engine VM, e.g. /etc/ssl/certs/sbc-ca.pem"
              >
                <Input
                  value={raw.tls_ca_path}
                  onChange={(ev) => onChange('tls_ca_path', ev.target.value)}
                  onBlur={() => onBlur('tls_ca_path')}
                  placeholder="/path/to/ca.pem"
                  className="w-72 font-mono text-xs"
                  aria-invalid={t('tls_ca_path') && !!errors.tls_ca_path ? true : undefined}
                />
              </FormRow>
            )}

            {(raw.tls_mode === 'client_cert' || raw.tls_mode === 'mutual') && (
              <>
                <FormRow
                  label="Client Cert Path"
                  error={e('tls_cert_path')}
                  hint="PEM containing the tool's identity certificate."
                >
                  <Input
                    value={raw.tls_cert_path}
                    onChange={(ev) => onChange('tls_cert_path', ev.target.value)}
                    onBlur={() => onBlur('tls_cert_path')}
                    placeholder="/path/to/client.crt"
                    className="w-72 font-mono text-xs"
                    aria-invalid={t('tls_cert_path') && !!errors.tls_cert_path ? true : undefined}
                  />
                </FormRow>
                <FormRow
                  label="Client Key Path"
                  error={e('tls_key_path')}
                  hint="Private key (chmod 600 on the VM). Must match the certificate above."
                >
                  <Input
                    value={raw.tls_key_path}
                    onChange={(ev) => onChange('tls_key_path', ev.target.value)}
                    onBlur={() => onBlur('tls_key_path')}
                    placeholder="/path/to/client.key"
                    className="w-72 font-mono text-xs"
                    aria-invalid={t('tls_key_path') && !!errors.tls_key_path ? true : undefined}
                  />
                </FormRow>
              </>
            )}

            {raw.tls_mode && raw.tls_mode !== 'insecure' && (
              <FormRow
                label="Server Name (SNI)"
                error={e('tls_server_name')}
                hint="Override only if the SBC certificate CN/SAN differs from the host above."
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

        {/* Failover */}
        <FormRow
          label="Failover"
          hint="Enable to add a secondary SBC host for failover during a run."
        >
          <div className="flex items-center gap-3">
            <Switch
              checked={raw.failover_enabled}
              onCheckedChange={(checked) => onChange('failover_enabled', checked)}
            />
            <span className="text-[11px] text-slate-400">
              {raw.failover_enabled ? 'Secondary host configured' : 'Single host — no failover'}
            </span>
          </div>
        </FormRow>

        {raw.failover_enabled && (
          <>
            <FormRow label="Secondary Host">
              <Input
                value={raw.secondary_host}
                onChange={(ev) => onChange('secondary_host', ev.target.value)}
                onBlur={() => onBlur('secondary_host')}
                placeholder="x.x.x.x"
                className="w-36 font-mono"
              />
            </FormRow>
            <FormRow label="Secondary Port">
              <Input
                type="number"
                value={raw.secondary_port}
                onChange={(ev) => onChange('secondary_port', ev.target.value)}
                onBlur={() => onBlur('secondary_port')}
                placeholder="5060"
                className="w-24 font-mono"
              />
            </FormRow>
          </>
        )}

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
          label="Range"
          hint="Any two extensions from this pool may be paired for a call."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="number"
              value={raw.ext_start}
              onChange={(ev) => onChange('ext_start', ev.target.value)}
              onBlur={() => onBlur('ext_start')}
              placeholder="4001000"
              className="w-32 font-mono text-xs"
              aria-invalid={t('ext_start') && !!errors.ext_start ? true : undefined}
            />
            <span className="text-slate-500">→</span>
            <Input
              type="number"
              value={raw.ext_end}
              onChange={(ev) => onChange('ext_end', ev.target.value)}
              onBlur={() => onBlur('ext_end')}
              placeholder="4001009"
              className="w-32 font-mono text-xs"
              aria-invalid={t('ext_end') && !!errors.ext_end ? true : undefined}
            />
            <span className="text-slate-500">·</span>
            <span className="font-mono text-xs text-slate-300">
              {extCount > 0 ? `${extCount} ext` : '—'}
            </span>
          </div>
          {(e('ext_start') || e('ext_end')) && null /* errors shown via FormRow on each Input below if needed */}
        </FormRow>
        {/* Inline per-field errors when start/end are individually invalid */}
        {(e('ext_start') || e('ext_end')) && (
          <div className="ml-[140px] pl-3 space-y-1">
            {e('ext_start') && <FieldError error={e('ext_start')} />}
            {e('ext_end')   && <FieldError error={e('ext_end')} />}
          </div>
        )}
      </div>
      )}

      {/* ── Registration & Subscription (Traffic tab, collapsed default) ─ */}
      {showTraffic && (() => {
        const regDirty =
          raw.register_expires !== DEFAULTS_REGISTRATION.register_expires ||
          raw.subscribe_expires !== DEFAULTS_REGISTRATION.subscribe_expires ||
          raw.register_rate_cps !== DEFAULTS_REGISTRATION.register_rate_cps ||
          raw.t1_ms !== DEFAULTS_REGISTRATION.t1_ms ||
          raw.timer_b_seconds !== DEFAULTS_REGISTRATION.timer_b_seconds
        return (
          <CollapsibleSection
            title="Registration & SIP Timers"
            defaultOpen={regDirty}
            dirty={regDirty}
            onReset={() => onResetSection(SECTION_FIELDS.registration)}
          >
            <FormRow
              label="REG Expires"
              error={e('register_expires')}
              hint="Expires header in REGISTER messages (seconds). Default 3600."
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={60}
                  step={60}
                  value={raw.register_expires}
                  onChange={(ev) => onChange('register_expires', ev.target.value)}
                  onBlur={() => onBlur('register_expires')}
                  placeholder="3600"
                  className="w-24 font-mono"
                  aria-invalid={t('register_expires') && !!errors.register_expires ? true : undefined}
                />
                <span className="text-[11px] text-slate-400">s</span>
              </div>
            </FormRow>
            <FormRow
              label="SUB Expires"
              error={customSub ? e('subscribe_expires') : undefined}
              hint="Expires header in SUBSCRIBE messages. Almost always identical to REGISTER Expires."
            >
              {customSub ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={60}
                    step={60}
                    value={raw.subscribe_expires}
                    onChange={(ev) => onChange('subscribe_expires', ev.target.value)}
                    onBlur={() => onBlur('subscribe_expires')}
                    placeholder="3600"
                    className="w-24 font-mono"
                    aria-invalid={t('subscribe_expires') && !!errors.subscribe_expires ? true : undefined}
                  />
                  <span className="text-[11px] text-slate-400">s</span>
                  <button
                    type="button"
                    onClick={() => setCustomSub(false)}
                    className="ml-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                    title="Reset to match REGISTER Expires"
                  >
                    same as REG
                  </button>
                </div>
              ) : (
                <div className="flex h-8 items-center gap-2">
                  <span className="font-mono text-xs text-slate-400">
                    = {raw.register_expires || '3600'}s
                  </span>
                  <button
                    type="button"
                    onClick={() => setCustomSub(true)}
                    className="text-[10px] text-emerald-400/80 hover:text-emerald-300 transition-colors"
                  >
                    Customise
                  </button>
                </div>
              )}
            </FormRow>
            <FormRow
              label="Reg Rate"
              error={e('register_rate_cps')}
              hint="Rate at which REGISTER messages are pumped (reg/s). Default 10."
            >
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  step={1}
                  value={raw.register_rate_cps}
                  onChange={(ev) => onChange('register_rate_cps', ev.target.value)}
                  onBlur={() => onBlur('register_rate_cps')}
                  placeholder="10"
                  className="w-24 font-mono"
                  aria-invalid={t('register_rate_cps') && !!errors.register_rate_cps ? true : undefined}
                />
                <span className="text-[11px] text-slate-400">reg/s</span>
              </div>
            </FormRow>
            <FormRow
              label="T1 / Timer-B"
              hint="RFC 3261 §17.1.1 INVITE client transaction timers. T1 is the UDP retransmit interval (default 500 ms); Timer B is the overall INVITE transaction timeout (default 64*T1 = 32 s)."
            >
              <div className="flex items-center gap-2">
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
                <span className="text-[11px] text-slate-400">ms</span>
                <span className="text-slate-500">·</span>
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
                <span className="text-[11px] text-slate-400">s</span>
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
            <span className="text-[11px] text-slate-400">
              {raw.media_enabled ? 'RTP enabled' : 'Signaling-only — no RTP'}
            </span>
          </div>
        </FormRow>

        {raw.media_enabled && (
          <>
            <FormRow label="Codec">
              <Select
                value={raw.rtp_codec}
                onValueChange={(v) => { onChange('rtp_codec', v as RtpCodec); onBlur('rtp_codec') }}
              >
                <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="G711_ULAW">G.711 μ-law (PCMU)</SelectItem>
                  <SelectItem value="G711_ALAW">G.711 A-law (PCMA)</SelectItem>
                  <SelectItem value="G729">G.729</SelectItem>
                  <SelectItem value="OPUS">OPUS</SelectItem>
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
                <span className="text-[11px] text-slate-400">ms</span>
                <span className="text-slate-500">·</span>
                <span className="font-mono text-[11px] text-emerald-400">
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
