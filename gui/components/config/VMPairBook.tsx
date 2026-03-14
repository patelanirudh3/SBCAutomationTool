'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { motion } from 'framer-motion'
import {
  ArrowLeftRight,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { VMConfigPanel, type RawVMFormValues } from './VMConfigPanel'
import { VMConfigSchema, deriveUACPeerStopUrl } from '@/lib/config-schema'
import { useTrafficStore } from '@/store/traffic'
import { checkHealth } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { VMConfig, VMPair, ReachabilityStatus } from '@/types'

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
  uas_ext_start: '4001005',
  uas_ext_end: '4001009',
  sbc_host: '10.133.63.117',
  sbc_port: '5060',
  sip_transport: 'TCP',
  domain: 'avaya.com',
  sip_password: '123456',
  cps: '1',
  hold_time_seconds: '5',
  metrics_port: '8082',
  peer_stop_url: 'http://127.0.0.1:8081/api/test/stop',
  traffic_mode: 'smoke',
  call_count: '10',
  duration_hours: '1',
  register_rate: '10',
  register_timeout: '8',
  register_retry: '3',
}

const UAS_DEFAULTS: RawVMFormValues = {
  vm_id: 'uas-local',
  vm_ip: '127.0.0.1',
  ssh_user: '',
  ssh_key_path: '',
  uac_ext_start: '4001000',
  uac_ext_end: '4001004',
  uas_ext_start: '4001005',
  uas_ext_end: '4001009',
  sbc_host: '10.133.63.117',
  sbc_port: '5060',
  sip_transport: 'TCP',
  domain: 'avaya.com',
  sip_password: '123456',
  cps: '1',
  hold_time_seconds: '5',
  metrics_port: '8081',
  peer_stop_url: '',
  traffic_mode: 'smoke',
  call_count: '10',
  duration_hours: '1',
  register_rate: '10',
  register_timeout: '8',
  register_retry: '3',
}

// All fields to touch on full validation
const UAC_FIELDS = [
  'vm_id', 'vm_ip', 'uac_ext_start', 'uac_ext_end', 'uas_ext_start', 'uas_ext_end',
  'sbc_host', 'sbc_port', 'sip_transport', 'domain', 'sip_password',
  'cps', 'hold_time_seconds', 'metrics_port', 'traffic_mode', 'call_count',
  'duration_hours', 'register_rate', 'register_timeout', 'register_retry',
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
    sip_transport: raw.sip_transport,
    domain: raw.domain,
    sip_password: raw.sip_password,
    cps: parseFloat(raw.cps) || 0,
    hold_time_seconds: parseFloat(raw.hold_time_seconds) || 0,
    metrics_port: parseInt(raw.metrics_port) || 0,
    peer_stop_url: raw.peer_stop_url || undefined,
    traffic_mode: role === 'UAC' ? raw.traffic_mode || undefined : undefined,
    call_count:
      role === 'UAC' && raw.call_count ? parseInt(raw.call_count) : undefined,
    duration_hours:
      role === 'UAC' && raw.duration_hours ? parseFloat(raw.duration_hours) : undefined,
    register_rate: parseFloat(raw.register_rate) || 0,
    register_timeout: parseFloat(raw.register_timeout) || 0,
    register_retry: parseInt(raw.register_retry) || 0,
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
    <div className="flex flex-1 items-center justify-between px-4">
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
        <span className="text-[10px] font-medium text-rose-400">
          {errorCount} error{errorCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function VMPairBook() {
  const router = useRouter()
  const { updatePair, activePairIndex, pairs } = useTrafficStore()

  const [uacRaw, setUacRaw] = useState<RawVMFormValues>(UAC_DEFAULTS)
  const [uasRaw, setUasRaw] = useState<RawVMFormValues>(UAS_DEFAULTS)
  const [uacTouched, setUacTouched] = useState<Set<string>>(new Set())
  const [uasTouched, setUasTouched] = useState<Set<string>>(new Set())
  const [uacReachability, setUacReachability] = useState<ReachabilityStatus | null>(null)
  const [uasReachability, setUasReachability] = useState<ReachabilityStatus | null>(null)
  // Tracks whether Validate has been run and passed
  const [validationPassed, setValidationPassed] = useState(false)

  // Auto-derive UAC peer_stop_url from UAS vm_ip + metrics_port (per spec)
  useEffect(() => {
    const url = deriveUACPeerStopUrl(uasRaw.vm_ip, parseInt(uasRaw.metrics_port) || 0)
    setUacRaw((prev) => ({ ...prev, peer_stop_url: url }))
  }, [uasRaw.vm_ip, uasRaw.metrics_port])

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

  const uacErrors = useMemo(() => getErrors(uacRaw, 'UAC'), [uacRaw])
  const uasErrors = useMemo(() => getErrors(uasRaw, 'UAS'), [uasRaw])

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

  // ── Field change / blur handlers ────────────────────────────────────────

  const handleUacChange = useCallback(
    (field: keyof RawVMFormValues, value: string) =>
      setUacRaw((prev) => ({ ...prev, [field]: value })),
    []
  )
  const handleUasChange = useCallback(
    (field: keyof RawVMFormValues, value: string) =>
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
    if (isValid) setValidationPassed(true)
  }

  const handleSaveAndContinue = () => {
    if (!validationPassed) return

    const uac = parseRaw(uacRaw, 'UAC') as VMConfig
    const uas = parseRaw(uasRaw, 'UAS') as VMConfig
    const currentPair: VMPair = pairs[activePairIndex] ?? {
      pair_id: 'pair-1',
      pair_label: 'Pair 1',
      uac,
      uas,
      validated: true,
      saved: true,
    }
    updatePair(activePairIndex, { ...currentPair, uac, uas, validated: true, saved: true })
    router.push('/launch')
  }

  const uacErrorCount = Object.keys(uacErrors).length
  const uasErrorCount = Object.keys(uasErrors).length
  const totalErrors = uacErrorCount + uasErrorCount
  const hasValidated = uacTouched.size > 0 || uasTouched.size > 0

  return (
    <div className="flex flex-1 flex-col overflow-hidden">

      {/* ── Shared header row — single border guarantees alignment ── */}
      <div className="flex items-center border-b border-border bg-card/80 py-2.5">
        <PanelHeaderContent role="UAC" label={uacRaw.vm_id || 'UAC'} errorCount={uacErrorCount} />

        {/* Swap button */}
        <div className="flex w-10 shrink-0 items-center justify-center">
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
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50'
            )}
          >
            <ArrowLeftRight className="size-3.5" />
          </motion.button>
        </div>

        <PanelHeaderContent role="UAS" label={uasRaw.vm_id || 'UAS'} errorCount={uasErrorCount} />
      </div>

      {/* ── Content columns ────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* UAC panel */}
        <div className="flex-1 overflow-y-auto">
          <VMConfigPanel
            role="UAC"
            raw={uacRaw}
            onChange={handleUacChange}
            touched={uacTouched}
            onBlur={handleUacBlur}
            errors={uacErrors}
            reachability={uacReachability}
            onCheckReachability={() =>
              checkReachability('UAC', uacRaw.vm_ip, parseInt(uacRaw.metrics_port) || 0)
            }
          />
        </div>

        {/* Thin divider line between scroll areas */}
        <div className="w-px shrink-0 bg-border/30" />

        {/* UAS panel */}
        <div className="flex-1 overflow-y-auto">
          <VMConfigPanel
            role="UAS"
            raw={uasRaw}
            onChange={handleUasChange}
            touched={uasTouched}
            onBlur={handleUasBlur}
            errors={uasErrors}
            reachability={uasReachability}
            onCheckReachability={() =>
              checkReachability('UAS', uasRaw.vm_ip, parseInt(uasRaw.metrics_port) || 0)
            }
          />
        </div>
      </div>

      {/* Footer action bar */}
      <div className="flex items-center justify-between border-t border-border bg-card px-6 py-3">
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
        </div>

        <Button
          size="sm"
          disabled={!validationPassed}
          onClick={handleSaveAndContinue}
          className={cn(
            'transition-opacity',
            !validationPassed && 'cursor-not-allowed opacity-40'
          )}
        >
          Save &amp; Continue
          <ChevronRight className="ml-0.5 size-3.5" />
        </Button>
      </div>
    </div>
  )
}
