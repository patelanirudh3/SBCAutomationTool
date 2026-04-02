'use client'

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftRight,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { VMConfigPanel, type RawVMFormValues } from './VMConfigPanel'
import { AdvancedSettings, type WrapAnalysis } from './AdvancedSettings'
import { VMConfigSchema, deriveUACPeerStopUrl, getFieldWarnings } from '@/lib/config-schema'
import { useTrafficStore } from '@/store/traffic'
import { checkHealth, putConfigFor } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { VMConfig, VMPair, ReachabilityStatus } from '@/types'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'

const IS_MOCK = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'

// ---------------------------------------------------------------------------
// Defaults from real yaml files
// ---------------------------------------------------------------------------

const UAC_DEFAULTS: RawVMFormValues = {
  vm_id: 'uac-local',
  vm_ip: '127.0.0.1',
  ssh_user: '',
  ssh_key_path: '',
  uac_ext_start: '4001000',
  uac_ext_end: '4001004',
  uac_ext_count: '5',
  uas_ext_start: '4001005',
  uas_ext_end: '4001009',
  uas_ext_count: '5',
  uas_override: false,
  sbc_host: '10.133.63.117',
  sbc_port: '5060',
  secondary_host: '',
  secondary_port: '5060',
  failover_enabled: false,
  dns_servers: '',
  sip_transport: 'TCP',
  domain: 'avaya.com',
  sip_password: '123456',
  cps: '1',
  hold_time_seconds: '5',
  ramp_up_seconds: '5',
  media_enabled: true,
  metrics_port: '8082',
  peer_stop_url: 'http://127.0.0.1:8081/api/test/stop',
  traffic_mode: 'smoke',
  call_count: '10',
  duration_hours: '1',
}

const UAS_DEFAULTS: RawVMFormValues = {
  vm_id: 'uas-local',
  vm_ip: '127.0.0.1',
  ssh_user: '',
  ssh_key_path: '',
  uac_ext_start: '4001000',
  uac_ext_end: '4001004',
  uac_ext_count: '5',
  uas_ext_start: '4001005',
  uas_ext_end: '4001009',
  uas_ext_count: '5',
  uas_override: false,
  sbc_host: '10.133.63.117',
  sbc_port: '5060',
  secondary_host: '',
  secondary_port: '5060',
  failover_enabled: false,
  dns_servers: '',
  sip_transport: 'TCP',
  domain: 'avaya.com',
  sip_password: '123456',
  cps: '1',
  hold_time_seconds: '5',
  ramp_up_seconds: '0',
  media_enabled: true,
  metrics_port: '8081',
  peer_stop_url: '',
  traffic_mode: 'smoke',
  call_count: '10',
  duration_hours: '1',
}

// All fields to touch on full validation
const UAC_FIELDS = [
  'vm_id', 'vm_ip', 'uac_ext_start', 'uac_ext_end', 'uas_ext_start', 'uas_ext_end',
  'sbc_host', 'sbc_port', 'sip_transport', 'domain', 'sip_password',
  'cps', 'hold_time_seconds', 'ramp_up_seconds', 'metrics_port', 'traffic_mode', 'call_count',
  'duration_hours',
]
const UAS_FIELDS = UAC_FIELDS.filter(
  (f) => !['traffic_mode', 'call_count', 'duration_hours'].includes(f)
)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseRaw(raw: RawVMFormValues, role: 'UAC' | 'UAS'): unknown {
  return {
    vm_role: role,
    vm_id: raw.vm_id,
    vm_ip: raw.vm_ip,
    ssh_user: raw.ssh_user || undefined,
    ssh_key_path: raw.ssh_key_path || undefined,
    uac_ext_start: parseInt(raw.uac_ext_start) || 0,
    uac_ext_end: parseInt(raw.uac_ext_end) || 0,
    uas_ext_start: parseInt(raw.uas_ext_start) || 0,
    uas_ext_end: parseInt(raw.uas_ext_end) || 0,
    sbc_host: raw.sbc_host,
    sbc_port: parseInt(raw.sbc_port) || 0,
    secondary_host: raw.failover_enabled ? (raw.secondary_host || undefined) : undefined,
    secondary_port: raw.failover_enabled ? (parseInt(raw.secondary_port) || undefined) : undefined,
    failover_enabled: raw.failover_enabled || undefined,
    dns_servers: raw.dns_servers || undefined,
    sip_transport: raw.sip_transport,
    domain: raw.domain,
    sip_password: raw.sip_password,
    cps: parseFloat(raw.cps) || 0,
    hold_time_seconds: parseFloat(raw.hold_time_seconds) || 0,
    ramp_up_seconds: role === 'UAC' && raw.ramp_up_seconds !== '' ? parseFloat(raw.ramp_up_seconds) : undefined,
    media_enabled: role === 'UAC' ? raw.media_enabled : undefined,
    metrics_port: parseInt(raw.metrics_port) || 0,
    peer_stop_url: raw.peer_stop_url || undefined,
    traffic_mode: role === 'UAC' ? raw.traffic_mode || undefined : undefined,
    call_count:
      role === 'UAC' && raw.call_count ? parseInt(raw.call_count) : undefined,
    duration_hours:
      role === 'UAC' && raw.duration_hours ? parseFloat(raw.duration_hours) : undefined,
  }
}

function getErrors(raw: RawVMFormValues, role: 'UAC' | 'UAS'): Record<string, string> {
  const result = VMConfigSchema.safeParse(parseRaw(raw, role))
  if (result.success) return {}
  const flat = result.error.flatten().fieldErrors
  return Object.fromEntries(
    Object.entries(flat).map(([k, v]) => [k, (v as string[])?.[0] ?? ''])
  )
}

// ---------------------------------------------------------------------------
// Panel header
// ---------------------------------------------------------------------------

function PanelHeaderContent({
  role,
  label,
  errorCount,
}: {
  role: 'UAC' | 'UAS'
  label: string
  errorCount: number
}) {
  return (
    <div className="relative flex flex-1 items-center justify-center px-4">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'rounded px-1.5 py-0.5 text-[10px] font-bold tracking-widest',
            role === 'UAC'
              ? 'bg-blue-500/15 text-blue-400'
              : 'bg-violet-500/15 text-violet-400'
          )}
        >
          {role}
        </span>
        <span className="font-mono text-sm text-foreground">{label}</span>
      </div>
      {errorCount > 0 && (
        <span className="absolute right-4 text-[10px] font-medium text-rose-400">
          {errorCount} error{errorCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wrap analysis sidebar (live from draft values)
// ---------------------------------------------------------------------------

const SIP_BYE_BUFFER = 2
function _gcd(a: number, b: number): number { return b === 0 ? a : _gcd(b, a % b) }
function _lcm(a: number, b: number): number { return a && b ? (a * b) / _gcd(a, b) : 0 }

function WrapSidebar({ uacRaw }: { uacRaw: RawVMFormValues }) {
  const [howItWorksOpen, setHowItWorksOpen] = useState(false)

  const uacStart = parseInt(uacRaw.uac_ext_start) || 0
  const uacEnd = parseInt(uacRaw.uac_ext_end) || 0
  const uasStart = parseInt(uacRaw.uas_ext_start) || 0
  const uasEnd = parseInt(uacRaw.uas_ext_end) || 0
  const uacCount = Math.max(uacEnd - uacStart + 1, 0)
  const uasCount = Math.max(uasEnd - uasStart + 1, 0)

  const poolCount = _lcm(Math.max(uacCount, 1), Math.max(uasCount, 1))
  const cps = Math.max(parseFloat(uacRaw.cps) || 0, 0.001)
  const holdTime = parseFloat(uacRaw.hold_time_seconds) || 0
  const wrapTime = poolCount / cps
  const naturalSpacing = wrapTime >= holdTime + SIP_BYE_BUFFER
  const autoDelay = Math.max(0, holdTime + SIP_BYE_BUFFER - wrapTime)
  const minPoolForNatural = Math.ceil(cps * (holdTime + SIP_BYE_BUFFER))

  if (uacCount <= 0 || uasCount <= 0) return null

  const accent = naturalSpacing ? 'emerald' : 'amber'

  return (
    <div className="space-y-3">
      {/* Live Wrap Analysis */}
      <div className="rounded-lg border border-slate-700/60 bg-slate-800/70 p-3.5 space-y-2.5">

        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-100">
          Live Wrap Analysis
        </p>

        <div className="flex items-center gap-2">
          {naturalSpacing ? (
            <CheckCircle2 className="size-3.5 text-emerald-400" />
          ) : (
            <span className="flex size-3.5 items-center justify-center rounded-full bg-amber-500/20 text-[9px] font-bold text-amber-300">!</span>
          )}
          <span
            className={cn(
              'text-[13px] font-semibold leading-tight',
              naturalSpacing ? 'text-emerald-300' : 'text-amber-300',
            )}
          >
            {naturalSpacing ? 'Natural Spacing' : 'Wrap Delay Required'}
          </span>
        </div>

        <div className="space-y-1.5 font-mono text-[12px] leading-relaxed">
          <div className="flex justify-between">
            <span className="text-slate-300">pool_count</span>
            <span className="font-medium text-slate-100">{poolCount}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-300">wrap_time</span>
            <span className="font-medium text-slate-100">{wrapTime.toFixed(1)}s</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-300">hold_time</span>
            <span className="font-medium text-slate-100">{holdTime}s</span>
          </div>
          {!naturalSpacing && (
            <>
              <div className="my-1 border-t border-white/10" />
              <div className="flex justify-between">
                <span className="text-slate-300">auto delay</span>
                <span className="font-semibold text-amber-300">{autoDelay.toFixed(1)}s</span>
              </div>
            </>
          )}
        </div>

        {!naturalSpacing && (
          <p className="text-[11px] leading-relaxed text-slate-200">
            Need <span className="font-mono font-bold text-emerald-400">{minPoolForNatural}</span> pool_count for natural spacing
          </p>
        )}
      </div>

      {/* How It Works — collapsible */}
      <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3.5">

        <button
          type="button"
          onClick={() => setHowItWorksOpen((o) => !o)}
          className="flex w-full items-center justify-between"
        >
          <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-100">
            How It Works
          </p>
          <ChevronDown
            className={cn(
              'size-3.5 text-slate-400 transition-transform duration-200',
              howItWorksOpen && 'rotate-180',
            )}
          />
        </button>
        {howItWorksOpen && (
          <div className="mt-2.5 space-y-1.5 font-mono text-[11px] leading-relaxed text-slate-200">
            <div>
              <span className="text-slate-300">pool_count</span> = LCM({uacCount}, {uasCount}) ={' '}
              <span className="font-bold text-emerald-400">{poolCount}</span>
            </div>
            <div>
              <span className="text-slate-300">wrap_time</span> = {poolCount} / {cps.toFixed(1)} ={' '}
              <span className="font-bold text-emerald-400">{wrapTime.toFixed(1)}s</span>
            </div>
            <div>
              <span className="text-slate-300">natural</span> = wrap_time {'>='} hold + {SIP_BYE_BUFFER}s
            </div>
            <div>
              <span className="text-slate-300">min_pool</span> = ⌈CPS × (hold + {SIP_BYE_BUFFER})⌉ ={' '}
              <span className="font-bold text-emerald-400">{minPoolForNatural}</span>
            </div>
          </div>
        )}
      </div>

      {/* Config Summary */}
      <div className="rounded-lg border border-slate-700/50 bg-slate-800/50 p-3.5 space-y-2.5">

        <p className="text-[11px] font-bold uppercase tracking-[0.1em] text-slate-100">
          Config Summary
        </p>
        <div className="space-y-1.5 text-[11px] leading-relaxed">
          <div className="flex justify-between text-slate-300">
            <span>CPS</span>
            <span className="font-mono text-slate-100">{uacRaw.cps}</span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>Hold Time</span>
            <span className="font-mono text-slate-100">{uacRaw.hold_time_seconds}s</span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>UAC Ext</span>
            <span className="font-mono text-slate-100">{uacCount}</span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>UAS Ext</span>
            <span className="font-mono text-slate-100">{uasCount}</span>
          </div>
          <div className="flex justify-between text-slate-300">
            <span>Media</span>
            <span
              className={cn(
                'font-mono font-semibold',
                uacRaw.media_enabled ? 'text-emerald-400' : 'text-amber-400',
              )}
            >
              {uacRaw.media_enabled ? 'RTP' : 'Signaling-only'}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function VMPairBook() {
  const router = useRouter()
  const { updatePair, activePairIndex, pairs, hydrateVmIps } = useTrafficStore()

  const pair = pairs[activePairIndex]
  const [uacRaw, setUacRaw] = useState<RawVMFormValues>(UAC_DEFAULTS)
  const [uasRaw, setUasRaw] = useState<RawVMFormValues>(UAS_DEFAULTS)
  const [uacTouched, setUacTouched] = useState<Set<string>>(new Set())
  const [uasTouched, setUasTouched] = useState<Set<string>>(new Set())
  const [uacReachability, setUacReachability] = useState<ReachabilityStatus | null>(null)
  const [uasReachability, setUasReachability] = useState<ReachabilityStatus | null>(null)
  const [validationPassed, setValidationPassed] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [configPushError, setConfigPushError] = useState<string | null>(null)
  const reachabilityTriggeredRef = useRef(false)

  // Hydrate persisted VM IPs from localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    hydrateVmIps()
  }, [hydrateVmIps])

  // Sync persisted VM IPs from store → form after hydration
  useEffect(() => {
    const p = pairs[activePairIndex]
    if (!p) return
    if (p.uac.vm_ip !== UAC_DEFAULTS.vm_ip) {
      setUacRaw(prev => prev.vm_ip === p.uac.vm_ip ? prev : { ...prev, vm_ip: p.uac.vm_ip })
    }
    if (p.uas.vm_ip !== UAS_DEFAULTS.vm_ip) {
      setUasRaw(prev => prev.vm_ip === p.uas.vm_ip ? prev : { ...prev, vm_ip: p.uas.vm_ip })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairs[activePairIndex]?.uac.vm_ip, pairs[activePairIndex]?.uas.vm_ip])

  // Auto-derive UAC peer_stop_url from UAS vm_ip + metrics_port (per spec)
  useEffect(() => {
    const url = deriveUACPeerStopUrl(uasRaw.vm_ip, parseInt(uasRaw.metrics_port) || 0)
    setUacRaw((prev) => ({ ...prev, peer_stop_url: url }))
  }, [uasRaw.vm_ip, uasRaw.metrics_port])

  // Mirror UAC hold_time_seconds to UAS so the UAS BYE-wait timeout stays in
  // sync. UAS uses hold_time_seconds + 60s as a safety timeout — it must be at
  // least as large as the UAC value to avoid false timeouts on the UAS side.
  useEffect(() => {
    setUasRaw((prev) => ({ ...prev, hold_time_seconds: uacRaw.hold_time_seconds }))
  }, [uacRaw.hold_time_seconds])

  // Derive all extension ranges from UAC Start + Count.
  // UAC End = Start + Count - 1; UAS Start = UAC End + 1; UAS End = UAS Start + Count - 1.
  // Both UAC and UAS raw values stay in sync automatically.
  useEffect(() => {
    const start = parseInt(uacRaw.uac_ext_start) || 0
    const count = parseInt(uacRaw.uac_ext_count) || 0
    if (start <= 0 || count <= 0) return

    const uacEnd = start + count - 1
    const uasStart = uacEnd + 1
    const uasEnd = uasStart + count - 1

    setUacRaw((prev) => ({
      ...prev,
      uac_ext_end: String(uacEnd),
      uas_ext_start: String(uasStart),
      uas_ext_end: String(uasEnd),
      uas_ext_count: String(count),
    }))

    setUasRaw((prev) => ({
      ...prev,
      uac_ext_start: uacRaw.uac_ext_start,
      uac_ext_end: String(uacEnd),
      uac_ext_count: uacRaw.uac_ext_count,
      uas_ext_start: String(uasStart),
      uas_ext_end: String(uasEnd),
      uas_ext_count: String(count),
    }))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uacRaw.uac_ext_start, uacRaw.uac_ext_count])

  // Keep the store's pair connection info (ip, port, vm_id) in sync with the
  // live form values so SessionMenu always shows the current typed-in values —
  // not just the last Save & Continue snapshot.
  useEffect(() => {
    const pair = pairs[activePairIndex]
    if (!pair) return
    const uacPort = parseInt(uacRaw.metrics_port) || pair.uac.metrics_port
    const uasPort = parseInt(uasRaw.metrics_port) || pair.uas.metrics_port
    if (
      pair.uac.vm_ip === uacRaw.vm_ip &&
      pair.uac.metrics_port === uacPort &&
      pair.uac.vm_id === uacRaw.vm_id &&
      pair.uas.vm_ip === uasRaw.vm_ip &&
      pair.uas.metrics_port === uasPort &&
      pair.uas.vm_id === uasRaw.vm_id
    ) return
    updatePair(activePairIndex, {
      ...pair,
      uac: { ...pair.uac, vm_ip: uacRaw.vm_ip, metrics_port: uacPort, vm_id: uacRaw.vm_id },
      uas: { ...pair.uas, vm_ip: uasRaw.vm_ip, metrics_port: uasPort, vm_id: uasRaw.vm_id },
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uacRaw.vm_ip, uacRaw.metrics_port, uacRaw.vm_id, uasRaw.vm_ip, uasRaw.metrics_port, uasRaw.vm_id])

  // Re-validate on every raw change (clear passed status if data changes post-validation)
  useEffect(() => {
    setValidationPassed(false)
  }, [uacRaw, uasRaw])

  // ── Swap UAC ↔ UAS configs ───────────────────────────────────────────────

  const handleSwap = useCallback(() => {
    setUacRaw(uasRaw)
    setUasRaw(uacRaw)
    setUacTouched(new Set())
    setUasTouched(new Set())
    setUacReachability(null)
    setUasReachability(null)
    setValidationPassed(false)
  }, [uacRaw, uasRaw])

  const liveAnalysis: WrapAnalysis = useMemo(() => {
    const uacStart = parseInt(uacRaw.uac_ext_start) || 0
    const uacEnd = parseInt(uacRaw.uac_ext_end) || 0
    const uasStart = parseInt(uacRaw.uas_ext_start) || 0
    const uasEnd = parseInt(uacRaw.uas_ext_end) || 0
    const uacCount = Math.max(uacEnd - uacStart + 1, 0)
    const uasCount = Math.max(uasEnd - uasStart + 1, 0)
    const poolCount = _lcm(Math.max(uacCount, 1), Math.max(uasCount, 1))
    const cps = Math.max(parseFloat(uacRaw.cps) || 0, 0.001)
    const holdTime = parseFloat(uacRaw.hold_time_seconds) || 0
    const wrapTime = poolCount / cps
    const naturalSpacing = wrapTime >= holdTime + SIP_BYE_BUFFER
    const autoDelay = Math.max(0, holdTime + SIP_BYE_BUFFER - wrapTime)
    const adv = pairs[activePairIndex]?.advancedSettings
    const userMargin = adv?.pool_wrap_delay_seconds ?? 0
    const effectiveDelay = autoDelay + Math.max(0, userMargin)
    const minPoolForNatural = Math.ceil(cps * (holdTime + SIP_BYE_BUFFER))
    return { poolCount, wrapTime, holdTime, naturalSpacing, autoDelay, userMargin, effectiveDelay, minPoolForNatural }
  }, [uacRaw.uac_ext_start, uacRaw.uac_ext_end, uacRaw.uas_ext_start, uacRaw.uas_ext_end, uacRaw.cps, uacRaw.hold_time_seconds, pairs, activePairIndex])

  const uacErrors = useMemo(() => getErrors(uacRaw, 'UAC'), [uacRaw])
  const uasErrors = useMemo(() => getErrors(uasRaw, 'UAS'), [uasRaw])

  const uacWarnings = useMemo(() => {
    const w = getFieldWarnings(uacRaw)
    if (uacRaw.metrics_port && uasRaw.metrics_port && uacRaw.metrics_port === uasRaw.metrics_port) {
      w.metrics_port = 'Same port as UAS — must be different for co-located VMs'
    }
    return w
  }, [uacRaw, uasRaw])

  const uasWarnings = useMemo(() => {
    const w = getFieldWarnings(uasRaw)
    if (uacRaw.metrics_port && uasRaw.metrics_port && uacRaw.metrics_port === uasRaw.metrics_port) {
      w.metrics_port = 'Same port as UAC — must be different for co-located VMs'
    }
    return w
  }, [uacRaw, uasRaw])

  const isValid =
    Object.keys(uacErrors).length === 0 && Object.keys(uasErrors).length === 0

  // ── Reachability checks ─────────────────────────────────────────────────

  const checkReachability = useCallback(
    async (role: 'UAC' | 'UAS', vmIp: string, metricsPort: number) => {
      const setter = role === 'UAC' ? setUacReachability : setUasReachability
      const vmId = role === 'UAC' ? uacRaw.vm_id : uasRaw.vm_id

      if (!vmIp || !metricsPort) return
      setter({ vm_id: vmId, reachable: false, checking: true })

      if (process.env.NEXT_PUBLIC_MOCK_MODE === 'true') {
        await new Promise((r) => setTimeout(r, 800))
        setter({ vm_id: vmId, reachable: true, checking: false })
        return
      }

      const result = await checkHealth(vmIp, metricsPort)
      setter({
        vm_id: vmId,
        reachable: result.reachable,
        checking: false,
        error: result.reachable ? undefined : (result.error ?? 'Connection refused'),
      })
    },
    [uacRaw.vm_id, uasRaw.vm_id]
  )

  // MOCK_MODE: auto-trigger both reachability checks on mount — demo shows green immediately
  useEffect(() => {
    if (!IS_MOCK || reachabilityTriggeredRef.current) return
    reachabilityTriggeredRef.current = true
    checkReachability('UAC', UAC_DEFAULTS.vm_ip, parseInt(UAC_DEFAULTS.metrics_port))
    checkReachability('UAS', UAS_DEFAULTS.vm_ip, parseInt(UAS_DEFAULTS.metrics_port))
  }, [checkReachability])

  // ── Field change / blur handlers ────────────────────────────────────────

  const handleUacChange = useCallback(
    (field: keyof RawVMFormValues, value: string | boolean) =>
      setUacRaw((prev) => ({ ...prev, [field]: value })),
    []
  )
  const handleUasChange = useCallback(
    (field: keyof RawVMFormValues, value: string | boolean) =>
      setUasRaw((prev) => ({ ...prev, [field]: value })),
    []
  )
  const handleUacBlur = useCallback(
    (field: string) => setUacTouched((prev) => new Set([...prev, field])),
    []
  )
  const handleUasBlur = useCallback(
    (field: string) => setUasTouched((prev) => new Set([...prev, field])),
    []
  )

  // ── Footer actions ──────────────────────────────────────────────────────

  const handleValidate = () => {
    setUacTouched(new Set(UAC_FIELDS))
    setUasTouched(new Set(UAS_FIELDS))
    // MOCK_MODE: always pass instantly; live mode: require Zod to pass
    if (IS_MOCK || isValid) setValidationPassed(true)
  }

  const handleSaveAndContinue = async () => {
    if (!validationPassed || isSaving) return

    setIsSaving(true)
    setConfigPushError(null)

    const uac = parseRaw(uacRaw, 'UAC') as VMConfig
    const uas = parseRaw(uasRaw, 'UAS') as VMConfig

    // Merge advanced settings into config payloads for the backend
    const adv = pairs[activePairIndex]?.advancedSettings ?? DEFAULT_ADVANCED_SETTINGS
    const uacPayload = { ...uac, ...adv }
    const uasPayload = { ...uas, ...adv }

    const currentPair: VMPair = pairs[activePairIndex] ?? {
      pair_id: 'pair-1',
      pair_label: 'Pair 1',
      uac,
      uas,
      advancedSettings: adv,
      validated: true,
      saved: true,
    }

    if (IS_MOCK) {
      await new Promise((r) => setTimeout(r, 600))
    } else {
      // Push config to both backends via PUT /api/config
      try {
        await putConfigFor(uas.vm_ip, uas.metrics_port, uasPayload)
        await putConfigFor(uac.vm_ip, uac.metrics_port, uacPayload)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Failed to push config'
        setConfigPushError(msg)
        setIsSaving(false)
        return
      }
    }

    updatePair(activePairIndex, { ...currentPair, uac, uas, advancedSettings: adv, validated: true, saved: true })
    setIsSaving(false)
    router.push('/launch')
  }

  const uacErrorCount = Object.keys(uacErrors).length
  const uasErrorCount = Object.keys(uasErrors).length
  const totalErrors = uacErrorCount + uasErrorCount
  const hasValidated = uacTouched.size > 0 || uasTouched.size > 0

  return (
    <div className="flex flex-1 flex-col overflow-hidden">

      {/* ── Scrollable content area ──────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-background">
        <div className="mx-auto w-full max-w-[1440px] px-6 py-5">
          <div className="grid grid-cols-[1fr_280px] items-start gap-5">

            {/* ── Main column ─────────────────────────────────── */}
            <div className="space-y-5">

              {/* Card row: UAC | swap | UAS */}
              <div className="flex items-start gap-4">

                {/* UAC card */}
                <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex items-center border-b border-border px-4 py-2.5">
                    <PanelHeaderContent role="UAC" label={uacRaw.vm_id || 'UAC'} errorCount={uacErrorCount} />
                  </div>
                  <VMConfigPanel
                    role="UAC"
                    raw={uacRaw}
                    onChange={handleUacChange}
                    touched={uacTouched}
                    onBlur={handleUacBlur}
                    errors={uacErrors}
                    warnings={uacWarnings}
                    reachability={uacReachability}
                    onCheckReachability={() =>
                      checkReachability('UAC', uacRaw.vm_ip, parseInt(uacRaw.metrics_port) || 0)
                    }
                  />
                </div>

                {/* Swap button */}
                <div className="flex h-[41px] shrink-0 items-center">
                  <motion.button
                    onClick={handleSwap}
                    whileHover={{ scale: 1.12 }}
                    whileTap={{ rotate: 180, scale: 0.88 }}
                    transition={{ duration: 0.2 }}
                    title="Swap UAC ↔ UAS configs"
                    className={cn(
                      'flex cursor-pointer items-center justify-center rounded-full p-1.5',
                      'border border-emerald-500/40 bg-card text-emerald-400',
                      'transition-colors duration-200',
                      'hover:border-emerald-400 hover:bg-emerald-500/15',
                      'hover:shadow-[0_0_14px_oklch(0.52_0.17_160/0.45)]',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50',
                    )}
                  >
                    <ArrowLeftRight className="size-3.5" />
                  </motion.button>
                </div>

                {/* UAS card */}
                <div className="flex flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
                  <div className="flex items-center border-b border-border px-4 py-2.5">
                    <PanelHeaderContent role="UAS" label={uasRaw.vm_id || 'UAS'} errorCount={uasErrorCount} />
                  </div>
                  <VMConfigPanel
                    role="UAS"
                    raw={uasRaw}
                    onChange={handleUasChange}
                    touched={uasTouched}
                    onBlur={handleUasBlur}
                    errors={uasErrors}
                    warnings={uasWarnings}
                    reachability={uasReachability}
                    onCheckReachability={() =>
                      checkReachability('UAS', uasRaw.vm_ip, parseInt(uasRaw.metrics_port) || 0)
                    }
                  />
                </div>
              </div>

              {/* Advanced Settings card */}
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <AdvancedSettings pairIndex={activePairIndex} liveAnalysis={liveAnalysis} />
              </div>
            </div>

            {/* ── Sticky sidebar — live wrap analysis ─────────── */}
            <div className="sticky top-5">
              <WrapSidebar uacRaw={uacRaw} />
            </div>

          </div>
        </div>
      </div>

      {/* ── Footer action bar — pinned at bottom ─────────────── */}
      <div className="border-t border-border bg-card">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={handleValidate}>
              Validate
            </Button>

            {hasValidated && totalErrors > 0 && (
              <span className="flex items-center gap-1.5 text-xs text-rose-400">
                <AlertTriangle className="size-3.5" />
                {totalErrors} error{totalErrors !== 1 ? 's' : ''}
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
              <>
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                Save &amp; Continue
                <ChevronRight className="ml-0.5 size-3.5" />
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
