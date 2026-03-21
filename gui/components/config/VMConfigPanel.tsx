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
import { Link2, Loader2, CheckCircle, XCircle, Signal, ArrowDownToLine, Lock } from 'lucide-react'
import type { VMRole, TrafficMode, SipTransport, ReachabilityStatus } from '@/types'

// All form values stored as strings so inputs stay fully controlled
export type RawVMFormValues = {
  vm_id: string
  vm_ip: string
  ssh_user: string
  ssh_key_path: string
  uac_ext_start: string
  uac_ext_end: string
  uac_ext_count: string
  uas_ext_start: string
  uas_ext_end: string
  uas_ext_count: string
  uas_override: boolean
  sbc_host: string
  sbc_port: string
  sip_transport: SipTransport
  domain: string
  sip_password: string
  cps: string
  hold_time_seconds: string
  ramp_up_seconds: string
  media_enabled: boolean
  metrics_port: string
  peer_stop_url: string
  traffic_mode: TrafficMode
  call_count: string
  duration_hours: string
}

export interface VMConfigPanelProps {
  role: VMRole
  raw: RawVMFormValues
  onChange: (field: keyof RawVMFormValues, value: string | boolean) => void
  touched: Set<string>
  onBlur: (field: string) => void
  errors: Record<string, string>
  warnings: Record<string, string>
  reachability: ReachabilityStatus | null
  onCheckReachability: () => void
}

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-foreground">
      <span className="h-4 w-0.5 shrink-0 rounded-full bg-emerald-500" />
      {children}
      <span className="h-px flex-1 bg-border" />
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
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        className="shrink-0 gap-1.5 font-mono text-xs"
      >
        <Loader2 className="size-3 animate-spin" />
        Checking…
      </Button>
    )
  }

  if (showSuccess && reachability?.reachable) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5 border-emerald-500/50 bg-emerald-500/10 font-mono text-xs text-emerald-400"
      >
        <CheckCircle className="size-3" />
        Reachable
      </Button>
    )
  }

  return (
    <Button
      type="button"
      size="sm"
      onClick={onTest}
      className="shrink-0 gap-1.5 border border-emerald-500/50 bg-emerald-500/10 font-mono text-xs text-emerald-400 hover:border-emerald-400 hover:bg-emerald-500/20 hover:text-emerald-300"
    >
      <Signal className="size-3" />
      Test
    </Button>
  )
}

function ReachabilityIndicator({ status }: { status: ReachabilityStatus | null }) {
  if (!status) return null

  if (status.checking) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-amber-400">
        <Loader2 className="size-3 animate-spin" />
        Checking…
      </span>
    )
  }

  if (status.reachable) {
    return (
      <span className="flex items-center gap-1.5 text-xs text-emerald-400">
        <CheckCircle className="size-3" />
        Reachable
      </span>
    )
  }

  return (
    <span className="flex items-center gap-1.5 text-xs text-rose-400">
      <XCircle className="size-3" />
      {status.error ?? 'Unreachable'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function VMConfigPanel({
  role,
  raw,
  onChange,
  touched,
  onBlur,
  errors,
  warnings,
  reachability,
  onCheckReachability,
}: VMConfigPanelProps) {
  const isUAC = role === 'UAC'

  const e = (field: string) => (touched.has(field) ? errors[field] : undefined)
  const w = (field: string) => (touched.has(field) ? warnings[field] : undefined)
  const t = (field: string) => touched.has(field)

  const uacExtCount = deriveExtCount(parseInt(raw.uac_ext_start), parseInt(raw.uac_ext_end))
  const uasExtCount = deriveExtCount(parseInt(raw.uas_ext_start), parseInt(raw.uas_ext_end))

  // Trigger health check when either vm_ip or metrics_port blurs (if both have values)
  const handleIpBlur = () => {
    onBlur('vm_ip')
    if (raw.vm_ip && raw.metrics_port) onCheckReachability()
  }

  const handleMetricsPortBlur = () => {
    onBlur('metrics_port')
    if (raw.vm_ip && raw.metrics_port) onCheckReachability()
  }

  return (
    <div className="space-y-6 px-4 py-5">

      {/* ── Identity ──────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader>Identity</SectionHeader>
        <FormField label="VM ID" error={e('vm_id')}>
          <Input
            value={raw.vm_id}
            onChange={(ev) => onChange('vm_id', ev.target.value)}
            onBlur={() => onBlur('vm_id')}
            placeholder={isUAC ? 'uac-local' : 'uas-local'}
            aria-invalid={t('vm_id') && !!errors.vm_id ? true : undefined}
          />
        </FormField>
      </div>

      {/* ── VM Connection ─────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader>VM Connection</SectionHeader>

        {/* IP + Metrics Port side-by-side — they belong together */}
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
                placeholder={isUAC ? '8082' : '8081'}
                className="font-mono"
                aria-invalid={t('metrics_port') && !!errors.metrics_port ? true : undefined}
              />
              <TestReachabilityButton
                vmIp={raw.vm_ip}
                metricsPort={raw.metrics_port}
                reachability={reachability}
                onTest={() => onCheckReachability()}
              />
            </div>
          </FormField>
        </div>

        {/* Health check URL + reachability status */}
        <div className="space-y-1">
          <FieldHint>
            {`Health check: http://${raw.vm_ip || '<ip>'}:${raw.metrics_port || '<port>'}/api/ping`}
          </FieldHint>
          <FieldWarning>
            The FastAPI backend must already be running on this port before the
            GUI can connect. Start it first:{' '}
            <span className="font-mono">
              python -m callflow_tool.traffic.main --api-only --port {isUAC ? '8082' : '8081'}
            </span>
          </FieldWarning>
          {reachability && (
            <div className="pt-0.5">
              <ReachabilityIndicator status={reachability} />
            </div>
          )}
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

      {/* ── SIP Connection ────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader>SIP Server</SectionHeader>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="SBC Host" error={e('sbc_host')}>
            <Input
              value={raw.sbc_host}
              onChange={(ev) => onChange('sbc_host', ev.target.value)}
              onBlur={() => onBlur('sbc_host')}
              placeholder="10.133.63.117"
              aria-invalid={t('sbc_host') && !!errors.sbc_host ? true : undefined}
            />
          </FormField>
          <FormField label="SBC Port" error={e('sbc_port')} warning={w('sbc_port')}>
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
              onValueChange={(v) => {
                onChange('sip_transport', v as SipTransport)
                onBlur('sip_transport')
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="TCP">TCP</SelectItem>
                <SelectItem value="TLS">TLS</SelectItem>
                <SelectItem value="UDP">UDP</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="Domain" error={e('domain')}>
            <Input
              value={raw.domain}
              onChange={(ev) => onChange('domain', ev.target.value)}
              onBlur={() => onBlur('domain')}
              placeholder="avaya.com"
              aria-invalid={t('domain') && !!errors.domain ? true : undefined}
            />
          </FormField>
        </div>

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

      {/* ── Extensions ────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader>Extensions</SectionHeader>

        {isUAC ? (
          <>
            {/* UAC Range — Start + Count → derived End */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold text-foreground/70">UAC Range</span>
                {uacExtCount > 0 && (
                  <span className="flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-cyan-300/80">
                    → {raw.uac_ext_end} · {uacExtCount} ext
                  </span>
                )}
              </div>
              <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-2">
                <FormField label="Start" error={e('uac_ext_start')}>
                  <Input
                    type="number"
                    value={raw.uac_ext_start}
                    onChange={(ev) => onChange('uac_ext_start', ev.target.value)}
                    onBlur={() => onBlur('uac_ext_start')}
                    placeholder="4001000"
                    className="font-mono text-xs"
                    aria-invalid={t('uac_ext_start') && !!errors.uac_ext_start ? true : undefined}
                  />
                </FormField>
                <span className="pb-2 text-base font-bold text-cyan-400/50">+</span>
                <FormField label="Count">
                  <Input
                    type="number"
                    min={1}
                    value={raw.uac_ext_count ?? ''}
                    onChange={(ev) => onChange('uac_ext_count', ev.target.value)}
                    onBlur={() => onBlur('uac_ext_count')}
                    placeholder="5"
                    className="font-mono text-xs"
                  />
                </FormField>
              </div>
            </div>

            {/* UAS Range — auto-derived from UAC */}
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] font-semibold text-foreground/70">UAS Range</span>
                  <ArrowDownToLine className="size-2.5 text-muted-foreground/40" />
                </div>
                {uasExtCount > 0 && (
                  <span className="flex items-center gap-1 rounded bg-cyan-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-cyan-300/80">
                    {raw.uas_ext_start} → {raw.uas_ext_end} · {uasExtCount} ext
                  </span>
                )}
              </div>
              <p className="text-[10px] leading-relaxed text-muted-foreground/60">
                UAS Start = UAC End + 1, same count
              </p>
            </div>
          </>
        ) : (
          /* UAS card: read-only, auto-synced from UAC */
          <div className="rounded-md border border-border/40 bg-secondary/20 px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-1.5">
              <Lock className="size-3 text-muted-foreground/40" />
              <span className="text-[10px] font-semibold tracking-wide text-muted-foreground/60">Auto-synced from UAC</span>
            </div>
            <div className="font-mono text-[11px] leading-relaxed text-slate-300/70 space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-400/70">UAC</span>
                <span className="text-cyan-300/70">{raw.uac_ext_start} → {raw.uac_ext_end} ({uacExtCount} ext)</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400/70">UAS</span>
                <span className="text-cyan-300/70">{raw.uas_ext_start} → {raw.uas_ext_end} ({uasExtCount} ext)</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ── Traffic ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader>Traffic</SectionHeader>

        {isUAC ? (
          /* UAC: CPS + Hold Time side-by-side (both editable) */
          <div className="grid grid-cols-2 gap-3">
            <FormField label="CPS" error={e('cps')} warning={w('cps')} hint="Calls per second">
              <Input
                type="number"
                min={0.1}
                step={0.1}
                value={raw.cps}
                onChange={(ev) => onChange('cps', ev.target.value)}
                onBlur={() => onBlur('cps')}
                className="font-mono"
                aria-invalid={t('cps') && !!errors.cps ? true : undefined}
              />
            </FormField>
            <FormField label="Hold Time (s)" error={e('hold_time_seconds')} warning={w('hold_time_seconds')}>
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
          </div>
        ) : (
          /* UAS: Hold Time only, read-only — auto-mirrored from UAC */
          <div className="space-y-1">
            <div className="flex items-center gap-1.5">
              <Label className="text-xs font-medium text-foreground/80">Hold Time (s)</Label>
              <ArrowDownToLine className="size-3 text-muted-foreground/50" />
            </div>
            <Input
              readOnly
              tabIndex={-1}
              value={raw.hold_time_seconds}
              className={cn(
                'cursor-default font-mono text-muted-foreground',
                'bg-secondary/30 focus-visible:ring-0 focus-visible:border-input'
              )}
            />
            <FieldHint>Auto-mirrored from UAC hold time (UAS uses this as BYE-wait timeout)</FieldHint>
          </div>
        )}

        {isUAC && (
          <FormField
            label="Ramp Up (s)"
            error={e('ramp_up_seconds')}
            hint="Seconds to linearly ramp from 0 to full CPS at run start"
          >
            <Input
              type="number"
              min={0}
              step={1}
              value={raw.ramp_up_seconds}
              onChange={(ev) => onChange('ramp_up_seconds', ev.target.value)}
              onBlur={() => onBlur('ramp_up_seconds')}
              className="font-mono"
              aria-invalid={t('ramp_up_seconds') && !!errors.ramp_up_seconds ? true : undefined}
            />
          </FormField>
        )}

        {isUAC && (
          <div className="flex items-center justify-between rounded-md border border-border/40 bg-secondary/20 px-3 py-2.5">
            <div className="space-y-0.5">
              <Label className="text-[11px] font-semibold text-foreground/70">Media (RTP)</Label>
              <p className="text-[10px] leading-relaxed text-muted-foreground/60">
                {raw.media_enabled
                  ? 'RTP packets will be sent during calls'
                  : 'Signaling-only — no RTP packets (MEDIA_DISABLED)'}
              </p>
            </div>
            <Switch
              checked={raw.media_enabled}
              onCheckedChange={(checked) => onChange('media_enabled', checked)}
            />
          </div>
        )}
      </div>

      {/* ── UAC-only: Run Control + Peer Stop URL ────────────── */}
      {isUAC && (
        <>
          <div className="space-y-3">
            <SectionHeader>Run Control</SectionHeader>
            <TrafficModeSelector
              value={raw.traffic_mode as TrafficMode}
              onChange={(m) => onChange('traffic_mode', m)}
              callCount={raw.call_count}
              onCallCountChange={(v) => onChange('call_count', v)}
              durationHours={raw.duration_hours}
              onDurationHoursChange={(v) => onChange('duration_hours', v)}
              cps={raw.cps}
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

          <div className="space-y-3">
            <SectionHeader>Coordination</SectionHeader>
            <div className="space-y-1">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs font-medium text-foreground/80">Peer Stop URL</Label>
                <Link2 className="size-3 text-muted-foreground/50" />
              </div>
              <Input
                readOnly
                value={raw.peer_stop_url}
                tabIndex={-1}
                className={cn(
                  'cursor-default select-all font-mono text-xs text-muted-foreground',
                  'bg-secondary/30 focus-visible:ring-0 focus-visible:border-input'
                )}
              />
              <FieldHint>Auto-derived from UAS VM IP + metrics port</FieldHint>
            </div>
          </div>
        </>
      )}

    </div>
  )
}
