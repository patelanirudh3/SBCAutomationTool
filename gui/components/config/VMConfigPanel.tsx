'use client'

import { useState, useEffect, type ReactNode } from 'react'
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
import { FieldError, FieldHint, FieldWarning, FieldSoftWarning } from './ConfigValidator'
import { TrafficModeSelector } from './TrafficModeSelector'
import { deriveExtCount } from '@/lib/config-schema'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Loader2, CheckCircle, XCircle, Signal, RotateCcw } from 'lucide-react'
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
}

// Fields belonging to each logical section — used by per-section Reset buttons
const SECTION_FIELDS = {
  identity:       ['vm_id'] as (keyof RawVMFormValues)[],
  agent_host:     ['vm_ip', 'metrics_port', 'ssh_user', 'ssh_key_path'] as (keyof RawVMFormValues)[],
  sip_server:     ['sbc_host', 'sbc_port', 'sip_transport', 'sip_scheme', 'domain', 'sip_password',
                   'secondary_host', 'secondary_port', 'failover_enabled', 'dns_servers',
                   'tls_mode', 'tls_ca_path', 'tls_cert_path', 'tls_key_path', 'tls_server_name'] as (keyof RawVMFormValues)[],
  extension_pool: ['ext_start', 'ext_end'] as (keyof RawVMFormValues)[],
  registration:   ['register_expires', 'subscribe_expires', 'register_rate_cps'] as (keyof RawVMFormValues)[],
  call_traffic:   ['cps', 'hold_time_seconds', 'traffic_mode', 'call_count', 'duration_hours', 'start_time_iso'] as (keyof RawVMFormValues)[],
  media:          ['media_enabled', 'rtp_codec', 'rtp_ptime'] as (keyof RawVMFormValues)[],
} as const

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-foreground">
      <span className="h-4 w-0.5 shrink-0 rounded-full bg-emerald-500" />
      {children}
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

function FormField({
  label,
  error,
  warning,
  hint,
  children,
}: {
  label: string
  error?: string
  warning?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-foreground/80">{label}</Label>
      {children}
      {error && <FieldError error={error} />}
      {!error && warning && <FieldSoftWarning warning={warning} />}
      {!error && !warning && hint && <FieldHint>{hint}</FieldHint>}
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

function CpsBhccField({
  cps,
  onCpsChange,
  error,
  warning,
  onBlur,
}: {
  cps: string
  onCpsChange: (v: string) => void
  error?: string
  warning?: string
  onBlur: () => void
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
    <div className="space-y-1">
      <Label className="text-xs font-medium text-foreground/80">Call Rate</Label>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">CPS (calls/sec)</Label>
          <Input
            type="number"
            min={0.01}
            step={0.1}
            value={cps}
            onChange={(ev) => handleCpsChange(ev.target.value)}
            onBlur={onBlur}
            className={cn('font-mono', inputMode === 'cps' ? 'ring-1 ring-emerald-500/40' : '')}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[10px] text-muted-foreground">BHCC (calls/hour)</Label>
          <Input
            type="number"
            min={1}
            step={1}
            value={bhccDraft}
            onChange={(ev) => handleBhccChange(ev.target.value)}
            onBlur={onBlur}
            className={cn('font-mono', inputMode === 'bhcc' ? 'ring-1 ring-amber-500/40' : '')}
            placeholder={bhccNum ? String(bhccNum) : '—'}
          />
        </div>
      </div>
      {bhccNum !== null && (
        <p className="font-mono text-[11px] text-amber-400/80">
          {cps} CPS = <span className="font-bold text-amber-400">{bhccNum.toLocaleString()} BHCC</span>
        </p>
      )}
      {error && <FieldError error={error} />}
      {!error && warning && <FieldSoftWarning warning={warning} />}
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
}: VMConfigPanelProps) {
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

  return (
    <div className="space-y-6 px-4 py-5">

      {/* ── Identity ──────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.identity)}>Identity</SectionHeader>
        <FormField label="VM ID" error={e('vm_id')}>
          <Input
            value={raw.vm_id}
            onChange={(ev) => onChange('vm_id', ev.target.value)}
            onBlur={() => onBlur('vm_id')}
            placeholder="traffic-local"
            aria-invalid={t('vm_id') && !!errors.vm_id ? true : undefined}
          />
        </FormField>
      </div>

      {/* ── Traffic Agent Host ───────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.agent_host)}>Traffic Agent Host</SectionHeader>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="IP Address" error={e('vm_ip')}>
            <Input
              value={raw.vm_ip}
              onChange={(ev) => onChange('vm_ip', ev.target.value)}
              onBlur={handleIpBlur}
              placeholder="127.0.0.1"
              className="font-mono"
              aria-invalid={t('vm_ip') && !!errors.vm_ip ? true : undefined}
            />
          </FormField>
          <FormField label="Metrics Port" error={e('metrics_port')} warning={w('metrics_port')}>
            <div className="flex gap-2">
              <Input
                type="number"
                value={raw.metrics_port}
                onChange={(ev) => onChange('metrics_port', ev.target.value)}
                onBlur={handleMetricsPortBlur}
                placeholder="8082"
                className="font-mono"
                aria-invalid={t('metrics_port') && !!errors.metrics_port ? true : undefined}
              />
              <TestReachabilityButton
                vmIp={raw.vm_ip}
                metricsPort={raw.metrics_port}
                reachability={reachability}
                onTest={onCheckReachability}
              />
            </div>
          </FormField>
        </div>
        <div className="space-y-1">
          <p className="mt-0.5 text-xs text-slate-400">
            Health check:{' '}
            <span className="font-mono text-sky-400 underline decoration-sky-400/30 underline-offset-2">
              {`http://${raw.vm_ip || '<ip>'}:${raw.metrics_port || '<port>'}/api/ping`}
            </span>
          </p>
          <FieldWarning>
            The traffic agent must be running on this port before the GUI can connect.
          </FieldWarning>
          {reachability && <div className="pt-0.5"><ReachabilityIndicator status={reachability} /></div>}
        </div>
        <FormField label="SSH User (optional)" error={e('ssh_user')}>
          <Input
            value={raw.ssh_user}
            onChange={(ev) => onChange('ssh_user', ev.target.value)}
            onBlur={() => onBlur('ssh_user')}
            placeholder="ubuntu"
          />
        </FormField>
        <FormField label="SSH Key Path (optional)" error={e('ssh_key_path')}>
          <Input
            value={raw.ssh_key_path}
            onChange={(ev) => onChange('ssh_key_path', ev.target.value)}
            onBlur={() => onBlur('ssh_key_path')}
            placeholder="/home/user/.ssh/id_rsa"
            className="font-mono text-xs"
          />
        </FormField>
      </div>

      {/* ── Remote SIP Server ─────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.sip_server)}>Remote SIP Server</SectionHeader>
        <FieldHint>Target SBC, SIP proxy, or any SIP server receiving calls.</FieldHint>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Host (IP or FQDN)" error={e('sbc_host')}>
            <Input
              value={raw.sbc_host}
              onChange={(ev) => onChange('sbc_host', ev.target.value)}
              onBlur={() => onBlur('sbc_host')}
              placeholder="10.133.63.117"
              aria-invalid={t('sbc_host') && !!errors.sbc_host ? true : undefined}
            />
          </FormField>
          <FormField label="Port" error={e('sbc_port')} warning={w('sbc_port')}>
            <Input
              type="number"
              value={raw.sbc_port}
              onChange={(ev) => onChange('sbc_port', ev.target.value)}
              onBlur={() => onBlur('sbc_port')}
              placeholder="5060"
              className="font-mono"
              aria-invalid={t('sbc_port') && !!errors.sbc_port ? true : undefined}
            />
          </FormField>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Transport" error={e('sip_transport')}>
            <Select
              value={raw.sip_transport}
              onValueChange={(v) => { onChange('sip_transport', v as SipTransport); onBlur('sip_transport') }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="TCP">TCP</SelectItem>
                <SelectItem value="TLS">TLS</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Scheme" error={e('sip_scheme')}
            hint="SIP = plain (port 5060), SIPS = secure (port 5061)">
            <Select
              value={raw.sip_scheme}
              onValueChange={(v) => { onChange('sip_scheme', v as SipScheme); onBlur('sip_scheme') }}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="SIP">SIP</SelectItem>
                <SelectItem value="SIPS">SIPS</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
        </div>

        {raw.sip_transport === 'TLS' && (
          <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-wider text-amber-300">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              TLS Settings
            </div>
            <FormField
              label="TLS Mode"
              error={e('tls_mode')}
              hint="Choose how the SBC certificate is validated and whether to present a client cert."
            >
              <Select
                value={raw.tls_mode || 'insecure'}
                onValueChange={(v) => { onChange('tls_mode', v as TLSMode); onBlur('tls_mode') }}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="insecure">Insecure (skip verify) — lab/testing only</SelectItem>
                  <SelectItem value="server_ca">Server CA verification (one-way TLS)</SelectItem>
                  <SelectItem value="client_cert">Client certificate only</SelectItem>
                  <SelectItem value="mutual">Mutual TLS (CA + client cert)</SelectItem>
                </SelectContent>
              </Select>
            </FormField>

            {(raw.tls_mode === 'server_ca' || raw.tls_mode === 'mutual') && (
              <FormField
                label="CA Certificate Path"
                error={e('tls_ca_path')}
                hint="PEM file on the engine VM, e.g. /etc/ssl/certs/sbc-ca.pem"
              >
                <Input
                  value={raw.tls_ca_path}
                  onChange={(ev) => onChange('tls_ca_path', ev.target.value)}
                  onBlur={() => onBlur('tls_ca_path')}
                  placeholder="/path/to/ca.pem"
                  className="font-mono text-xs"
                  aria-invalid={t('tls_ca_path') && !!errors.tls_ca_path ? true : undefined}
                />
              </FormField>
            )}

            {(raw.tls_mode === 'client_cert' || raw.tls_mode === 'mutual') && (
              <div className="grid grid-cols-1 gap-3">
                <FormField
                  label="Client Certificate Path"
                  error={e('tls_cert_path')}
                  hint="PEM containing the tool's identity certificate."
                >
                  <Input
                    value={raw.tls_cert_path}
                    onChange={(ev) => onChange('tls_cert_path', ev.target.value)}
                    onBlur={() => onBlur('tls_cert_path')}
                    placeholder="/path/to/client.crt"
                    className="font-mono text-xs"
                    aria-invalid={t('tls_cert_path') && !!errors.tls_cert_path ? true : undefined}
                  />
                </FormField>
                <FormField
                  label="Client Private Key Path"
                  error={e('tls_key_path')}
                  hint="Private key (chmod 600 on the VM). Must match the certificate above."
                >
                  <Input
                    value={raw.tls_key_path}
                    onChange={(ev) => onChange('tls_key_path', ev.target.value)}
                    onBlur={() => onBlur('tls_key_path')}
                    placeholder="/path/to/client.key"
                    className="font-mono text-xs"
                    aria-invalid={t('tls_key_path') && !!errors.tls_key_path ? true : undefined}
                  />
                </FormField>
              </div>
            )}

            {raw.tls_mode && raw.tls_mode !== 'insecure' && (
              <FormField
                label="TLS Server Name (SNI)"
                error={e('tls_server_name')}
                hint="Override only if the SBC certificate CN/SAN differs from the host above."
              >
                <Input
                  value={raw.tls_server_name}
                  onChange={(ev) => onChange('tls_server_name', ev.target.value)}
                  onBlur={() => onBlur('tls_server_name')}
                  placeholder="sbc.example.com"
                  className="font-mono text-xs"
                />
              </FormField>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Domain" error={e('domain')}>
            <Input
              value={raw.domain}
              onChange={(ev) => onChange('domain', ev.target.value)}
              onBlur={() => onBlur('domain')}
              placeholder="avaya.com"
              aria-invalid={t('domain') && !!errors.domain ? true : undefined}
            />
          </FormField>
          <FormField label="SIP Password" error={e('sip_password')}>
            <Input
              type="password"
              value={raw.sip_password}
              onChange={(ev) => onChange('sip_password', ev.target.value)}
              onBlur={() => onBlur('sip_password')}
              placeholder="••••••••"
              aria-invalid={t('sip_password') && !!errors.sip_password ? true : undefined}
            />
          </FormField>
        </div>

        {/* Failover */}
        <div className={cn(
          'inline-flex items-center gap-3 rounded-md border px-3 py-2.5',
          raw.failover_enabled ? 'border-amber-500/30 bg-amber-950/20' : 'border-slate-600/30 bg-slate-800/20',
        )}>
          <div className="space-y-0.5">
            <Label className="text-xs font-bold tracking-wide text-slate-100">Enable Failover</Label>
            <p className="text-[11px] leading-relaxed text-slate-300">
              {raw.failover_enabled ? 'Secondary host configured for failover' : 'Single host — no failover'}
            </p>
          </div>
          <Switch
            checked={raw.failover_enabled}
            onCheckedChange={(checked) => onChange('failover_enabled', checked)}
          />
        </div>

        {raw.failover_enabled && (
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Secondary Host">
              <Input
                value={raw.secondary_host}
                onChange={(ev) => onChange('secondary_host', ev.target.value)}
                onBlur={() => onBlur('secondary_host')}
                placeholder="10.133.63.118"
              />
            </FormField>
            <FormField label="Secondary Port">
              <Input
                type="number"
                value={raw.secondary_port}
                onChange={(ev) => onChange('secondary_port', ev.target.value)}
                onBlur={() => onBlur('secondary_port')}
                placeholder="5060"
                className="font-mono"
              />
            </FormField>
          </div>
        )}

        <FormField label="DNS Servers (optional)"
          hint="Comma-separated IPs for FQDN resolution. Leave empty for system DNS.">
          <Input
            value={raw.dns_servers}
            onChange={(ev) => onChange('dns_servers', ev.target.value)}
            onBlur={() => onBlur('dns_servers')}
            placeholder="10.0.0.53, 168.63.129.16"
            className="font-mono text-xs"
          />
        </FormField>
      </div>

      {/* ── Extension Pool ────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.extension_pool)}>Extension Pool</SectionHeader>
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-semibold text-slate-200">SIP Extension Range</span>
          {extCount > 0 && (
            <span className="flex items-center gap-1 rounded border border-slate-700/50 bg-slate-800/60 px-1.5 py-0.5 font-mono text-[11px]">
              <span className="font-bold text-amber-400">{raw.ext_start}</span>
              <span className="text-slate-500">→</span>
              <span className="font-bold text-amber-400">{raw.ext_end}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-400">{extCount} ext</span>
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-3">
          <FormField label="Start" error={e('ext_start')}>
            <Input
              type="number"
              value={raw.ext_start}
              onChange={(ev) => onChange('ext_start', ev.target.value)}
              onBlur={() => onBlur('ext_start')}
              placeholder="4001000"
              className="font-mono text-xs"
              aria-invalid={t('ext_start') && !!errors.ext_start ? true : undefined}
            />
          </FormField>
          <FormField label="End" error={e('ext_end')}>
            <Input
              type="number"
              value={raw.ext_end}
              onChange={(ev) => onChange('ext_end', ev.target.value)}
              onBlur={() => onBlur('ext_end')}
              placeholder="4001009"
              className="font-mono text-xs"
              aria-invalid={t('ext_end') && !!errors.ext_end ? true : undefined}
            />
          </FormField>
          <div className="space-y-1">
            <Label className="text-xs font-medium text-foreground/80">Count</Label>
            <div className="flex h-9 items-center rounded-md border border-input bg-secondary/40 px-3 font-mono text-xs text-muted-foreground">
              {extCount > 0 ? extCount : '—'}
            </div>
          </div>
        </div>
        <FieldHint>Any two extensions from this pool may be paired for a call.</FieldHint>
      </div>

      {/* ── Registration & Subscription ───────────────────────── */}
      <div className="space-y-3">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.registration)}>Registration &amp; Subscription</SectionHeader>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="REGISTER Expires (s)" error={e('register_expires')}
            hint="Expiry in REGISTER messages (default 3600)">
            <Input
              type="number"
              min={60}
              step={60}
              value={raw.register_expires}
              onChange={(ev) => onChange('register_expires', ev.target.value)}
              onBlur={() => onBlur('register_expires')}
              placeholder="3600"
              className="font-mono"
              aria-invalid={t('register_expires') && !!errors.register_expires ? true : undefined}
            />
          </FormField>
          <FormField label="SUBSCRIBE Expires (s)" error={e('subscribe_expires')}
            hint="Expiry in SUBSCRIBE messages (default 3600)">
            <Input
              type="number"
              min={60}
              step={60}
              value={raw.subscribe_expires}
              onChange={(ev) => onChange('subscribe_expires', ev.target.value)}
              onBlur={() => onBlur('subscribe_expires')}
              placeholder="3600"
              className="font-mono"
              aria-invalid={t('subscribe_expires') && !!errors.subscribe_expires ? true : undefined}
            />
          </FormField>
        </div>
        <FormField label="Registration Rate (reg/s)" error={e('register_rate_cps')}
          hint="Rate at which REGISTER messages are pumped (default 10/s). Backend may need updating to enforce this.">
          <Input
            type="number"
            min={1}
            step={1}
            value={raw.register_rate_cps}
            onChange={(ev) => onChange('register_rate_cps', ev.target.value)}
            onBlur={() => onBlur('register_rate_cps')}
            placeholder="10"
            className="font-mono"
            aria-invalid={t('register_rate_cps') && !!errors.register_rate_cps ? true : undefined}
          />
        </FormField>
      </div>

      {/* ── Call Traffic ──────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.call_traffic)}>Call Traffic</SectionHeader>

        {/* Bidirectional CPS / BHCC */}
        <CpsBhccField
          cps={raw.cps}
          onCpsChange={(v) => onChange('cps', v)}
          error={t('cps') ? errors.cps : undefined}
          warning={t('cps') ? warnings.cps : undefined}
          onBlur={() => onBlur('cps')}
        />

        <FormField label="Hold Time (s)" error={e('hold_time_seconds')} warning={w('hold_time_seconds')}
          hint="Duration of each call leg before BYE is sent">
          <Input
            type="number"
            min={0}
            value={raw.hold_time_seconds}
            onChange={(ev) => onChange('hold_time_seconds', ev.target.value)}
            onBlur={() => onBlur('hold_time_seconds')}
            className="font-mono"
            aria-invalid={t('hold_time_seconds') && !!errors.hold_time_seconds ? true : undefined}
          />
        </FormField>

        {/* Traffic mode: smoke / timed / unlimited */}
        <div className="space-y-3">
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

      {/* ── Media (RTP) ───────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader onReset={() => onResetSection(SECTION_FIELDS.media)}>Media (RTP)</SectionHeader>

        <div className={cn(
          'inline-flex items-center gap-3 rounded-md border px-3 py-2.5',
          raw.media_enabled ? 'border-emerald-500/30 bg-emerald-950/20' : 'border-amber-500/30 bg-amber-950/20',
        )}>
          <div className="space-y-0.5">
            <Label className="text-xs font-bold tracking-wide text-slate-100">Enable RTP Media</Label>
            <p className="text-[11px] leading-relaxed text-slate-300">
              {raw.media_enabled ? 'RTP packets sent during calls' : 'Signaling-only — no RTP'}
            </p>
          </div>
          <Switch
            checked={raw.media_enabled}
            onCheckedChange={(checked) => onChange('media_enabled', checked)}
          />
        </div>

        {raw.media_enabled && (
          <div className="space-y-3 pl-1">
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Codec">
                <Select
                  value={raw.rtp_codec}
                  onValueChange={(v) => { onChange('rtp_codec', v as RtpCodec); onBlur('rtp_codec') }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="G711_ULAW">G.711 μ-law (PCMU)</SelectItem>
                    <SelectItem value="G711_ALAW">G.711 A-law (PCMA)</SelectItem>
                    <SelectItem value="G729">G.729</SelectItem>
                    <SelectItem value="OPUS">OPUS</SelectItem>
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="ptime (ms)" hint={`Packet interval → ${ppsDisplay} PPS`}>
                <Input
                  type="number"
                  min={10}
                  max={80}
                  step={10}
                  value={raw.rtp_ptime}
                  onChange={(ev) => onChange('rtp_ptime', ev.target.value)}
                  onBlur={() => onBlur('rtp_ptime')}
                  placeholder="20"
                  className="font-mono"
                />
              </FormField>
            </div>
            <p className="font-mono text-[11px] text-slate-400">
              PPS = 1000 ÷ {raw.rtp_ptime || 20} ={' '}
              <span className="font-bold text-emerald-400">{ppsDisplay} packets/s</span>
            </p>
          </div>
        )}
      </div>

    </div>
  )
}
