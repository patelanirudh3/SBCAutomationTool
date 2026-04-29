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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { VMConfigPanel, type RawVMFormValues } from './VMConfigPanel'
import { AdvancedSettings } from './AdvancedSettings'
import { VMConfigSchema, getFieldWarnings } from '@/lib/config-schema'
import { useTrafficStore } from '@/store/traffic'
import { checkHealth, putConfigFor } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { VMConfig, VMPair, ReachabilityStatus, SipScheme, RtpCodec } from '@/types'
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
    register_expires: raw.register_expires ? parseInt(raw.register_expires) : undefined,
    subscribe_expires: raw.subscribe_expires ? parseInt(raw.subscribe_expires) : undefined,
    register_rate_cps: raw.register_rate_cps ? parseFloat(raw.register_rate_cps) : undefined,
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
// Config Summary sidebar
// ---------------------------------------------------------------------------

function ConfigSummary({ raw }: { raw: RawVMFormValues }) {
  const extStart = parseInt(raw.ext_start) || 0
  const extEnd = parseInt(raw.ext_end) || 0
  const poolCount = Math.max(extEnd - extStart + 1, 0)
  const bhcc = parseFloat(raw.cps) > 0 ? Math.round(parseFloat(raw.cps) * 3600) : null

  return (
    <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3.5 space-y-2.5">
      <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-100">Config Summary</p>
      <div className="space-y-1.5 text-[11px] leading-relaxed">
        {[
          ['SIP Server', `${raw.sbc_host || '—'}:${raw.sbc_port}`],
          ['Transport', `${raw.sip_scheme} / ${raw.sip_transport}`],
          ['Extensions', poolCount > 0 ? `${raw.ext_start} → ${raw.ext_end} (${poolCount})` : '—'],
          ['CPS', raw.cps],
          ...(bhcc !== null ? [['BHCC', bhcc.toLocaleString()]] : []),
          ['Hold Time', `${raw.hold_time_seconds}s`],
          ['Reg Expires', `${raw.register_expires || '3600'}s`],
          ['Sub Expires', `${raw.subscribe_expires || '3600'}s`],
          ['Reg Rate', `${raw.register_rate_cps || '10'} reg/s`],
          ['Media', raw.media_enabled ? `${raw.rtp_codec} @ ${raw.rtp_ptime || 20}ms` : 'Disabled'],
          ['Mode', raw.traffic_mode || '—'],
        ].map(([label, value]) => (
          <div key={String(label)} className="flex justify-between text-slate-300">
            <span>{label}</span>
            <span className="font-mono text-slate-100 text-right ml-2 truncate max-w-[120px]">{String(value)}</span>
          </div>
        ))}
      </div>
    </div>
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

  const handleValidate = () => {
    setTouched(new Set(UA_FIELDS))
    if (IS_MOCK || isValid) setValidationPassed(true)
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

  const errorCount = Object.keys(errors).length
  const hasValidated = touched.size > 0

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto bg-background">
        <div className="mx-auto w-full max-w-[1440px] px-6 py-5">
          <div className="grid grid-cols-[1fr_280px] items-start gap-5">

            {/* Main column */}
            <div className="space-y-5">

              {/* UA card */}
              <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex items-center border-b border-border px-4 py-2.5">
                  <div className="flex flex-1 items-center gap-2 px-2">
                    <span className="rounded px-1.5 py-0.5 text-[10px] font-bold tracking-widest bg-emerald-500/15 text-emerald-400">
                      UA
                    </span>
                    <span className="font-mono text-sm text-foreground">{raw.vm_id || 'User Agent'}</span>
                    {hasValidated && errorCount > 0 && (
                      <span className="ml-auto text-[10px] font-medium text-rose-400">
                        {errorCount} error{errorCount !== 1 ? 's' : ''}
                      </span>
                    )}
                  </div>
                </div>
                <VMConfigPanel
                  raw={raw}
                  onChange={handleChange}
                  touched={touched}
                  onBlur={handleBlur}
                  errors={errors}
                  warnings={warnings}
                  reachability={reachability}
                  onCheckReachability={() =>
                    checkReachability(raw.vm_ip, parseInt(raw.metrics_port) || 0)
                  }
                  onResetSection={handleResetSection}
                />
              </div>

              {/* Advanced Settings */}
              <motion.div className="overflow-hidden rounded-xl border border-border bg-card">
                <AdvancedSettings pairIndex={activePairIndex} />
              </motion.div>
            </div>

            {/* Sticky sidebar */}
            <div className="sticky top-5">
              <ConfigSummary raw={raw} />
            </div>
          </div>
        </div>
      </div>

      {/* Footer action bar */}
      <div className="border-t border-border bg-card">
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
            <Button variant="outline" size="sm" onClick={handleValidate}>
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
    </div>
  )
}
