'use client'

import type { ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { FieldError, FieldHint, FieldWarning } from './ConfigValidator'
import { TrafficModeSelector } from './TrafficModeSelector'
import { deriveExtCount } from '@/lib/config-schema'
import { cn } from '@/lib/utils'
import { Link2, Hash, Loader2, CheckCircle, XCircle } from 'lucide-react'
import type { VMRole, TrafficMode, SipTransport, ReachabilityStatus } from '@/types'

// All form values stored as strings so inputs stay fully controlled
export type RawVMFormValues = {
  vm_id: string
  vm_ip: string
  ssh_user: string
  ssh_key_path: string
  uac_ext_start: string
  uac_ext_end: string
  uas_ext_start: string
  uas_ext_end: string
  sbc_host: string
  sbc_port: string
  sip_transport: SipTransport
  domain: string
  sip_password: string
  cps: string
  hold_time_seconds: string
  metrics_port: string
  peer_stop_url: string
  traffic_mode: TrafficMode
  call_count: string
  duration_hours: string
}

export interface VMConfigPanelProps {
  role: VMRole
  raw: RawVMFormValues
  onChange: (field: keyof RawVMFormValues, value: string) => void
  touched: Set<string>
  onBlur: (field: string) => void
  errors: Record<string, string>
  reachability: ReachabilityStatus | null
  onCheckReachability: () => void
}

// ---------------------------------------------------------------------------
// Local sub-components
// ---------------------------------------------------------------------------

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
      <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-emerald-500/70" />
      {children}
      <span className="h-px flex-1 bg-border/60" />
    </h3>
  )
}

function FormField({
  label,
  error,
  hint,
  children,
}: {
  label: string
  error?: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-foreground/80">{label}</Label>
      {children}
      {error && <FieldError error={error} />}
      {!error && hint && <FieldHint>{hint}</FieldHint>}
    </div>
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
  reachability,
  onCheckReachability,
}: VMConfigPanelProps) {
  const isUAC = role === 'UAC'

  const e = (field: string) => (touched.has(field) ? errors[field] : undefined)
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
        <SectionHeader>SIP Connection</SectionHeader>

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
          <FormField label="SBC Port" error={e('sbc_port')}>
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

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground/80">UAC range</span>
            {uacExtCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                <Hash className="size-2.5" />
                {uacExtCount} ext
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
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
            <FormField label="End" error={e('uac_ext_end')}>
              <Input
                type="number"
                value={raw.uac_ext_end}
                onChange={(ev) => onChange('uac_ext_end', ev.target.value)}
                onBlur={() => onBlur('uac_ext_end')}
                placeholder="4001004"
                className="font-mono text-xs"
                aria-invalid={t('uac_ext_end') && !!errors.uac_ext_end ? true : undefined}
              />
            </FormField>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-foreground/80">UAS range</span>
            {uasExtCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-400">
                <Hash className="size-2.5" />
                {uasExtCount} ext
              </span>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="Start" error={e('uas_ext_start')}>
              <Input
                type="number"
                value={raw.uas_ext_start}
                onChange={(ev) => onChange('uas_ext_start', ev.target.value)}
                onBlur={() => onBlur('uas_ext_start')}
                placeholder="4001005"
                className="font-mono text-xs"
                aria-invalid={t('uas_ext_start') && !!errors.uas_ext_start ? true : undefined}
              />
            </FormField>
            <FormField label="End" error={e('uas_ext_end')}>
              <Input
                type="number"
                value={raw.uas_ext_end}
                onChange={(ev) => onChange('uas_ext_end', ev.target.value)}
                onBlur={() => onBlur('uas_ext_end')}
                placeholder="4001009"
                className="font-mono text-xs"
                aria-invalid={t('uas_ext_end') && !!errors.uas_ext_end ? true : undefined}
              />
            </FormField>
          </div>
        </div>
      </div>

      {/* ── Traffic ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeader>Traffic</SectionHeader>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="CPS" error={e('cps')} hint="Calls per second">
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
          <FormField label="Hold Time (s)" error={e('hold_time_seconds')}>
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
        <div className="space-y-1">
          <FormField label="Metrics Port" error={e('metrics_port')}>
            <Input
              type="number"
              value={raw.metrics_port}
              onChange={(ev) => onChange('metrics_port', ev.target.value)}
              onBlur={handleMetricsPortBlur}
              placeholder={isUAC ? '8082' : '8081'}
              className="font-mono"
              aria-invalid={t('metrics_port') && !!errors.metrics_port ? true : undefined}
            />
          </FormField>
          <FieldHint>
            {`Health check: http://${raw.vm_ip || '<ip>'}:${raw.metrics_port || '<port>'}/api/ping`}
          </FieldHint>
          <FieldWarning>
            The FastAPI backend must already be running on this port before the
            GUI can connect. Start it first:
            {' '}
            <span className="font-mono">
              python -m callflow_tool.traffic.main --config {isUAC ? 'uac' : 'uas'}.yaml --api-only
            </span>
          </FieldWarning>
          {reachability && (
            <div className="pt-0.5">
              <ReachabilityIndicator status={reachability} />
            </div>
          )}
        </div>
      </div>

      {/* ── UAC-only: Traffic Mode + Peer Stop URL ────────────── */}
      {isUAC && (
        <>
          <div className="space-y-3">
            <SectionHeader>Traffic Mode</SectionHeader>
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
