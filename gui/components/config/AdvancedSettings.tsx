'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings2, Pencil, Check, ChevronDown, Info } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTrafficStore } from '@/store/traffic'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'
import type { AdvancedSettings as AdvancedSettingsType, RtpMode } from '@/types'
import { cn } from '@/lib/utils'
import { FieldError, FieldHint } from './ConfigValidator'

// ---------------------------------------------------------------------------
// Field helper
// ---------------------------------------------------------------------------

/**
 * AdvancedField — horizontal row layout to match VMConfigPanel's FormRow.
 * 130px label column on the left, compact w-20 numeric input on the right.
 * Hint text moves into the tooltip when both are provided to keep the row
 * to a single line; the standalone hint render is preserved for cases
 * where only `hint` is set.
 */
function AdvancedField({
  label,
  value,
  disabled,
  min,
  step,
  error,
  hint,
  tooltip,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  min?: number
  step?: number
  error?: string
  hint?: string
  tooltip?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="grid grid-cols-[160px_1fr] items-start gap-3 py-1.5">
      <div className="flex h-9 items-center gap-1.5">
        <Label className="text-sm font-semibold text-slate-200/90">{label}</Label>
        {tooltip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                tabIndex={-1}
                className="text-indigo-400/70 hover:text-indigo-300 transition-colors"
              >
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <div className="min-w-0 space-y-1">
        <Input
          type="number"
          min={min ?? 1}
          step={step ?? 1}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className={cn(
            'w-20 font-mono border-slate-600/50 bg-slate-800/80 text-slate-100',
            'focus-visible:border-indigo-400/60 focus-visible:ring-1 focus-visible:ring-indigo-400/30',
            disabled && 'cursor-default opacity-75'
          )}
        />
        {error && <FieldError error={error} />}
        {!error && hint && !tooltip && <FieldHint>{hint}</FieldHint>}
      </div>
    </div>
  )
}

function rtpModeLabel(mode: RtpMode | undefined): string {
  if (mode === 'continuous') return 'continuous'
  if (mode === '3phase_coverage') return '3-phase coverage'
  return '3-phase lite'
}

function computeCoveragePreview(s: AdvancedSettingsType, holdSeconds: number, ptimeMs: number) {
  const pps = ptimeMs > 0 ? 1000 / ptimeMs : 50
  const hold = Math.max(holdSeconds, 0)
  const coverage = Math.min(Math.max(s.rtp_media_coverage_pct || 25, 1), 100) / 100
  const targetSeconds = hold * coverage
  const phase1Seconds = targetSeconds * Math.max(s.rtp_start_burst_share_pct || 0, 0) / 100
  const phase3Seconds = targetSeconds * Math.max(s.rtp_end_burst_share_pct || 0, 0) / 100
  const phase2Seconds = Math.max(targetSeconds - phase1Seconds - phase3Seconds, 0)
  const midBurstSeconds = Math.max(s.rtp_mid_burst_seconds || 3, 1)
  const midBurstCount = phase2Seconds > 0 ? Math.ceil(phase2Seconds / midBurstSeconds) : 0
  const idleWindow = Math.max(hold - phase1Seconds - phase2Seconds - phase3Seconds, 0)
  const spacingSeconds = midBurstCount > 0 ? idleWindow / (midBurstCount + 1) : 0
  const keepaliveEnabled = s.rtp_coverage_keepalive_enabled !== false
  const keepalivePps = Math.min(Math.max(s.rtp_coverage_keepalive_pps || 3, 1), 5)
  const keepalivePackets = keepaliveEnabled ? Math.round(idleWindow * keepalivePps) : 0
  const packets = (seconds: number) => Math.round(seconds * pps)
  const burstPackets = packets(targetSeconds)
  const totalPackets = burstPackets + keepalivePackets

  return {
    pps,
    fullPackets: packets(hold),
    targetPackets: burstPackets,
    keepalivePackets,
    totalPackets,
    bidirectionalPackets: totalPackets * 2,
    phase1Seconds,
    phase2Seconds,
    phase3Seconds,
    phase1Packets: packets(phase1Seconds),
    phase2Packets: packets(phase2Seconds),
    phase3Packets: packets(phase3Seconds),
    midBurstCount,
    spacingSeconds,
    maxGapSeconds: keepaliveEnabled ? 1 / keepalivePps : spacingSeconds,
  }
}

// ---------------------------------------------------------------------------
// Token row (collapsed read-only summary)
// ---------------------------------------------------------------------------

// Per-tab token lists. The collapsed token row only shows the tokens that
// belong to the currently rendered tab so the row stays scannable. 'all'
// preserves the legacy single-row behaviour (used by ConfigSummary, etc.).
type AdvancedTab = 'signaling' | 'media' | 'all'

function TokenRow({ s, tab = 'all' }: { s: AdvancedSettingsType; tab?: AdvancedTab }) {
  const modeLabel = rtpModeLabel(s.rtp_mode)

  // Signaling-side tokens (REGISTER batching, retries, SUBSCRIBE concurrency,
  // TCP keepalive, 100rel toggle).
  const signalingTokens = [
    `batch_size: ${s.register_batch_size}`,
    `batch_delay: ${s.register_batch_delay_ms}ms`,
    `connect_timeout: ${s.connect_timeout}s`,
    `timeout: ${s.register_timeout}s`,
    `retry: ${s.register_retry}`,
    `subscribe: ${s.subscribe_concurrency}`,
    `cleanup_unsub: ${s.cleanup_unsubscribe_rate_per_sec}/s`,
    `cleanup_unreg: ${s.cleanup_unregister_rate_per_sec}/s`,
    `cleanup_audit: ${s.cleanup_audit_timeout_minutes}m`,
    `tcp_keepalive: ${s.tcp_keepalive_seconds === 0 ? 'off' : `${s.tcp_keepalive_seconds}s`}`,
    `100rel: ${s.use_100rel ? 'on' : 'off'}`,
  ]

  // Media-side tokens (RTP shape, burst, keepalive, PCAP, refresh, QoS, RTCP SR).
  const qosTokens: string[] = []
  if (s.qos_enabled === false) qosTokens.push('qos: off')
  else if (s.qos_mos_estimation === false) qosTokens.push('qos: jitter+loss')
  if (s.rtcp_sr_enabled) qosTokens.push(`rtcp-sr: ${s.rtcp_sr_interval_seconds ?? 5}s`)

  const mediaTokens = [
    `rtp: ${modeLabel}`,
    ...(s.rtp_mode === '3phase_coverage'
      ? [
          `coverage: ${s.rtp_media_coverage_pct}%`,
          `mid-burst: ${s.rtp_mid_burst_seconds}s`,
          `ka: ${s.rtp_coverage_keepalive_enabled === false ? 'off' : `${s.rtp_coverage_keepalive_pps ?? 3}pps`}`,
        ]
      : [
          `burst: ${s.rtp_burst_seconds}s`,
          `keepalive: ${s.rtp_keepalive_interval}s`,
        ]),
    `refresh: ${s.metrics_interval}s`,
    ...(s.rtp_pcap ? ['pcap: on'] : []),
    ...qosTokens,
  ]

  const tokens =
    tab === 'signaling' ? signalingTokens :
    tab === 'media'     ? mediaTokens :
    [...signalingTokens, ...mediaTokens]

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {tokens.map((tok, i) => (
        <span key={i} className="flex items-center gap-2">
          <span className="font-mono text-xs font-medium text-slate-300">{tok}</span>
          {i < tokens.length - 1 && <span className="text-slate-600">·</span>}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AdvancedSettings({
  pairIndex,
  tab = 'all',
}: {
  pairIndex: number
  /**
   * Which slice of advanced settings to render:
   *  - 'signaling' : Pre-Phase / Registration block + TCP keepalive + 100rel
   *  - 'media'     : RTP block + Reporting Refresh + Media QoS + RTCP SR
   *  - 'all'       : full panel (legacy single-page rendering)
   */
  tab?: AdvancedTab
}) {
  const { pairs, updateAdvancedSettings } = useTrafficStore()
  const saved: AdvancedSettingsType = useMemo(
    () => pairs[pairIndex]?.advancedSettings ?? { ...DEFAULT_ADVANCED_SETTINGS },
    [pairs, pairIndex],
  )

  // Tab gates — drive both the token row's filtering and the expanded
  // body's field groups so the same component renders cleanly under
  // either Signaling or Media tab without duplicating sections.
  const showSignaling = tab === 'all' || tab === 'signaling'
  const showMedia     = tab === 'all' || tab === 'media'

  // Header label adapts to the active tab so the operator sees an
  // accurate description of what the panel actually contains.
  const headerLabel =
    tab === 'signaling' ? 'Advanced Settings — Registration & SIP'
    : tab === 'media'   ? 'Advanced Settings — RTP & Media QoS'
    :                     'Advanced Settings — Registration & RTP'

  const [isOpen, setIsOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<AdvancedSettingsType>({ ...saved })
  const [errors, setErrors] = useState<Partial<Record<keyof AdvancedSettingsType, string>>>({})
  const panelRef = useRef<HTMLDivElement>(null)
  const vmConfig = pairs[pairIndex]?.uac
  const holdSeconds = Number(vmConfig?.hold_time_seconds ?? 0) || 0
  const ptimeMs = Number(vmConfig?.rtp_ptime ?? 20) || 20
  const coveragePreview = computeCoveragePreview(draft, holdSeconds, ptimeMs)

  useEffect(() => {
    if (!isEditing) setDraft({ ...saved })
  }, [saved, isEditing])

  useEffect(() => {
    if (!isEditing) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleCancel() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing])

  const handleEdit = () => {
    setDraft({ ...saved })
    setErrors({})
    setIsEditing(true)
    setIsOpen(true)
  }

  const handleCancel = () => {
    setDraft({ ...saved })
    setErrors({})
    setIsEditing(false)
  }

  const handleSave = () => {
    const ALLOW_ZERO: Set<string> = new Set([
      'register_batch_delay_ms',
      // TCP keepalive: 0 explicitly disables; non-zero range checked below.
      'tcp_keepalive_seconds',
    ])
    const SKIP: Set<string> = new Set([
      'rtp_mode', 'rtp_pcap',
      'qos_enabled', 'qos_mos_estimation',
      'rtcp_sr_enabled',
      'rtp_coverage_keepalive_enabled',
      'use_100rel',
    ])
    const newErrors: Partial<Record<keyof AdvancedSettingsType, string>> = {}
    for (const [key, val] of Object.entries(draft)) {
      if (SKIP.has(key)) continue
      // RTCP SR interval is only validated when RTCP SR is on; otherwise
      // any value is acceptable (the field is shown but disabled).
      if (key === 'rtcp_sr_interval_seconds' && !draft.rtcp_sr_enabled) continue
      if (
        key === 'rtp_coverage_keepalive_pps' &&
        (draft.rtp_mode !== '3phase_coverage' || draft.rtp_coverage_keepalive_enabled === false)
      ) continue
      const v = val as number
      if (!Number.isFinite(v)) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be a number'
      } else if (ALLOW_ZERO.has(key) ? v < 0 : v <= 0) {
        newErrors[key as keyof AdvancedSettingsType] =
          ALLOW_ZERO.has(key) ? 'Must be ≥ 0' : 'Must be a positive number'
      } else if (key === 'rtcp_sr_interval_seconds' && (v < 1 || v > 60)) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be between 1 and 60 seconds'
      } else if (key === 'tcp_keepalive_seconds' && v > 0 && (v < 5 || v > 300)) {
        // Non-zero keepalive must fall in [5, 300] seconds — shorter is
        // wasteful chatter, longer leaves dead sockets undetected past
        // most NAT idle timeouts.
        newErrors[key as keyof AdvancedSettingsType] = 'Must be 0 (disabled) or between 5 and 300 seconds'
      } else if (draft.rtp_mode === '3phase_coverage' && key === 'rtp_media_coverage_pct' && (v < 1 || v > 100)) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be between 1 and 100%'
      } else if (
        draft.rtp_mode === '3phase_coverage' &&
        (key === 'rtp_start_burst_share_pct' || key === 'rtp_end_burst_share_pct') &&
        (v < 0 || v > 100)
      ) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be between 0 and 100%'
      } else if (
        draft.rtp_mode === '3phase_coverage' &&
        key === 'rtp_mid_burst_seconds' &&
        (v <= 0 || (holdSeconds > 0 && v > holdSeconds))
      ) {
        newErrors[key as keyof AdvancedSettingsType] = holdSeconds > 0
          ? `Must be > 0 and <= hold time (${holdSeconds}s)`
          : 'Must be a positive number'
      } else if (
        draft.rtp_mode === '3phase_coverage' &&
        draft.rtp_coverage_keepalive_enabled !== false &&
        key === 'rtp_coverage_keepalive_pps' &&
        (v < 1 || v > 5)
      ) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be between 1 and 5 pps'
      }
    }
    if (
      draft.rtp_mode === '3phase_coverage' &&
      draft.rtp_start_burst_share_pct + draft.rtp_end_burst_share_pct >= 100
    ) {
      newErrors.rtp_end_burst_share_pct = 'Start + End shares must be less than 100%'
    }
    if (Object.keys(newErrors).length > 0) { setErrors(newErrors); return }
    setErrors({})
    updateAdvancedSettings(pairIndex, draft)
    setIsEditing(false)
    setIsOpen(false)
  }

  const set = (field: keyof AdvancedSettingsType) => (v: number) =>
    setDraft((prev) => ({ ...prev, [field]: v }))

  const disabled = !isEditing

  return (
    <div
      ref={panelRef}
      className={cn(
        'rounded-b-lg border border-indigo-500/20 bg-[#0f1729]',
        'shadow-lg shadow-indigo-950/30',
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-2.5">
        <button
          type="button"
          onClick={() => !isEditing && setIsOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <Settings2 className="size-4 shrink-0 text-indigo-400" />
          <span className="text-sm font-bold uppercase tracking-wide text-slate-100">
            {headerLabel}
          </span>
          <ChevronDown
            className={cn(
              'ml-0.5 size-3.5 shrink-0 text-slate-400 transition-transform duration-200',
              isOpen && 'rotate-180'
            )}
          />
        </button>

        <div className="flex shrink-0 items-center gap-3">
          {!isEditing ? (
            <button
              type="button"
              onClick={handleEdit}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold',
                'border border-indigo-400/40 text-indigo-300',
                'transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-400'
              )}
            >
              <Pencil className="size-3.5" />
              Edit
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCancel}
                className="h-6 px-2.5 text-xs text-slate-300 hover:text-slate-100"
              >
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} className="h-6 gap-1 px-2.5 text-xs">
                <Check className="size-3" />
                Save
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Token row (collapsed) — filtered to the active tab so each tab
          shows only its own knobs at a glance. */}
      {!isOpen && (
        <div className="border-t border-slate-700/40 px-5 py-2">
          <TokenRow s={saved} tab={tab} />
        </div>
      )}

      {/* Expanded body */}
      <AnimatePresence initial={false}>
        {isOpen && (
          <motion.div
            key="adv-body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="border-t border-slate-700/40 px-5 py-3 space-y-3">
              {/* Top grid is two columns when both halves are visible
                  ('all' tab); collapses to one column when only one side
                  is requested. The empty-side render is suppressed by the
                  showSignaling / showMedia gates below. */}
              <div className={cn(
                'grid gap-x-6 gap-y-2',
                showSignaling && showMedia ? 'grid-cols-2' : 'grid-cols-1',
              )}>

                {/* Left — Pre-Phase / Registration (Signaling tab) */}
                {showSignaling && (
                <div className="space-y-1">
                  <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-blue-300">
                    <span className="h-4 w-0.5 shrink-0 rounded-full bg-blue-400" />
                    Pre-Phase Settings
                    <span className="h-px flex-1 bg-blue-400/30" />
                  </h3>
                  <div className="space-y-1">
                    <AdvancedField
                      label="Batch Size"
                      value={draft.register_batch_size}
                      disabled={disabled}
                      error={errors.register_batch_size}
                      tooltip="Number of extensions per batch for TCP socket creation and concurrent REGISTER operations."
                      onChange={set('register_batch_size')}
                    />
                    <p className="font-mono text-xs text-slate-300">
                      Batch size: <span className="font-bold text-emerald-400">{draft.register_batch_size}</span> ext/batch
                    </p>
                  </div>
                  <AdvancedField
                    label="Batch Delay (ms)"
                    value={draft.register_batch_delay_ms}
                    disabled={disabled}
                    min={0}
                    error={errors.register_batch_delay_ms}
                    tooltip="Delay in milliseconds between TCP socket creation and REGISTER batches."
                    onChange={set('register_batch_delay_ms')}
                  />
                  <AdvancedField
                    label="Connect Timeout (s)"
                    value={draft.connect_timeout}
                    disabled={disabled}
                    error={errors.connect_timeout}
                    tooltip="Max wait for each TCP/TLS socket connection attempt before marking that extension failed and continuing."
                    onChange={set('connect_timeout')}
                  />
                  <AdvancedField
                    label="Timeout (s)"
                    value={draft.register_timeout}
                    disabled={disabled}
                    error={errors.register_timeout}
                    tooltip="Max wait per REGISTER or SUBSCRIBE response."
                    onChange={set('register_timeout')}
                  />
                  <AdvancedField
                    label="Retry Attempts"
                    value={draft.register_retry}
                    min={0}
                    disabled={disabled}
                    error={errors.register_retry}
                    tooltip="Number of retries on no-response for REGISTER and SUBSCRIBE."
                    onChange={set('register_retry')}
                  />
                  <AdvancedField
                    label="Subscribe Concurrency"
                    value={draft.subscribe_concurrency}
                    disabled={disabled}
                    error={errors.subscribe_concurrency}
                    tooltip="Max concurrent SUBSCRIBE operations."
                    onChange={set('subscribe_concurrency')}
                  />
                  <AdvancedField
                    label="Cleanup Unsubscribe/sec"
                    value={draft.cleanup_unsubscribe_rate_per_sec}
                    disabled={disabled}
                    error={errors.cleanup_unsubscribe_rate_per_sec}
                    tooltip="Max number of extensions concurrently performing unsubscribe cleanup. Each extension still unsubscribes its events sequentially."
                    onChange={set('cleanup_unsubscribe_rate_per_sec')}
                  />
                  <AdvancedField
                    label="Cleanup Unregister/sec"
                    value={draft.cleanup_unregister_rate_per_sec}
                    disabled={disabled}
                    error={errors.cleanup_unregister_rate_per_sec}
                    tooltip="Max number of extensions concurrently performing unregister cleanup after unsubscribe completes."
                    onChange={set('cleanup_unregister_rate_per_sec')}
                  />
                  <AdvancedField
                    label="Cleanup Audit Timeout (m)"
                    value={draft.cleanup_audit_timeout_minutes}
                    disabled={disabled}
                    error={errors.cleanup_audit_timeout_minutes}
                    tooltip="After this many minutes, remaining agents are force-unregistered even if unsubscribe did not complete."
                    onChange={set('cleanup_audit_timeout_minutes')}
                  />
                </div>
                )}

                {/* Right — RTP (Media tab) */}
                {showMedia && (
                <div className="space-y-1">
                  <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-indigo-300">
                    <span className="h-4 w-0.5 shrink-0 rounded-full bg-indigo-400" />
                    RTP
                    <span className="h-px flex-1 bg-indigo-400/30" />
                  </h3>

                  {/* RTP Mode — Select dropdown for visual consistency with
                      the other Selects in the form (Transport, Scheme,
                      TLS Mode, Codec). Two options only, but a Select
                      keeps the row compact and matches the established
                      pattern. */}
                  <div className="grid grid-cols-[160px_1fr] items-center gap-3 py-1">
                    <Label className="text-sm font-semibold text-slate-200/90">RTP Mode</Label>
                    <Select
                      value={draft.rtp_mode}
                      disabled={disabled}
                      onValueChange={(v) => setDraft((prev) => ({ ...prev, rtp_mode: v as RtpMode }))}
                    >
                      <SelectTrigger className="w-40 text-sm">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="3phase">3-Phase Lite</SelectItem>
                        <SelectItem value="3phase_coverage">3-Phase Coverage</SelectItem>
                        <SelectItem value="continuous">Continuous</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* PCAP capture — horizontal row */}
                  <div className="grid grid-cols-[160px_1fr] items-center gap-3 py-1">
                    <div className="flex items-center gap-1">
                      <Label className="text-sm font-semibold text-slate-200/90">PCAP Capture</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            tabIndex={-1}
                            className="text-indigo-400/70 hover:text-indigo-300 transition-colors"
                          >
                            <Info className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                          Save RTP packets to .pcap files in logs/. Open in Wireshark to verify payload and RTP flow.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setDraft((prev) => ({ ...prev, rtp_pcap: !prev.rtp_pcap }))}
                      className={cn(
                        'inline-flex w-fit items-center gap-2 rounded-md px-2.5 py-1 text-xs font-semibold border transition-colors',
                        draft.rtp_pcap
                          ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-600/50 bg-slate-800/60 text-slate-300 hover:border-indigo-400/40',
                        disabled && 'opacity-70 cursor-default',
                      )}
                    >
                      <span className={cn(
                        'inline-block size-3 rounded-sm border-2 transition-colors',
                        draft.rtp_pcap ? 'border-emerald-400 bg-emerald-400' : 'border-zinc-400 bg-transparent'
                      )} />
                      {draft.rtp_pcap ? 'On — pcap saved to logs/' : 'Off'}
                    </button>
                  </div>

                  {/* 3-Phase lite fields */}
                  {draft.rtp_mode === '3phase' && (
                    <>
                      <AdvancedField
                        label="Burst Duration (s)"
                        value={draft.rtp_burst_seconds}
                        disabled={disabled}
                        error={errors.rtp_burst_seconds}
                        tooltip="Duration of the high-rate RTP burst at the start and end of each call."
                        onChange={set('rtp_burst_seconds')}
                      />
                      <AdvancedField
                        label="Keepalive Interval (s)"
                        value={draft.rtp_keepalive_interval}
                        disabled={disabled}
                        error={errors.rtp_keepalive_interval}
                        tooltip="Interval between keepalive packets during the mid-call period."
                        onChange={set('rtp_keepalive_interval')}
                      />
                    </>
                  )}

                  {/* Coverage-mode fields */}
                  {draft.rtp_mode === '3phase_coverage' && (
                    <div className="space-y-2">
                      <AdvancedField
                        label="Media Coverage (%)"
                        value={draft.rtp_media_coverage_pct}
                        disabled={disabled}
                        error={errors.rtp_media_coverage_pct}
                        tooltip="Percentage of full continuous RTP volume to send during the call."
                        onChange={set('rtp_media_coverage_pct')}
                      />
                      <AdvancedField
                        label="Start Burst Share (%)"
                        value={draft.rtp_start_burst_share_pct}
                        disabled={disabled}
                        min={0}
                        error={errors.rtp_start_burst_share_pct}
                        tooltip="Percentage of the coverage budget sent immediately after ACK."
                        onChange={set('rtp_start_burst_share_pct')}
                      />
                      <AdvancedField
                        label="End Burst Share (%)"
                        value={draft.rtp_end_burst_share_pct}
                        disabled={disabled}
                        min={0}
                        error={errors.rtp_end_burst_share_pct}
                        tooltip="Percentage of the coverage budget sent before BYE."
                        onChange={set('rtp_end_burst_share_pct')}
                      />
                      <AdvancedField
                        label="Mid Burst (s)"
                        value={draft.rtp_mid_burst_seconds}
                        disabled={disabled}
                        error={errors.rtp_mid_burst_seconds}
                        tooltip="Duration of each full-rate RTP burst distributed across the middle of the call."
                        onChange={set('rtp_mid_burst_seconds')}
                      />
                      <div className="grid grid-cols-[160px_1fr] items-center gap-3 py-1">
                        <Label className="text-sm font-semibold text-slate-200/90">Coverage Keepalive</Label>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() => setDraft((prev) => ({
                            ...prev,
                            rtp_coverage_keepalive_enabled: prev.rtp_coverage_keepalive_enabled === false,
                          }))}
                          className={cn(
                            'inline-flex w-fit items-center gap-2 rounded-md px-2.5 py-1 text-xs font-semibold border transition-colors',
                            draft.rtp_coverage_keepalive_enabled !== false
                              ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                              : 'border-slate-600/50 bg-slate-800/60 text-slate-300 hover:border-indigo-400/40',
                            disabled && 'opacity-70 cursor-default',
                          )}
                        >
                          <span className={cn(
                            'inline-block size-3 rounded-sm border-2 transition-colors',
                            draft.rtp_coverage_keepalive_enabled !== false ? 'border-emerald-400 bg-emerald-400' : 'border-zinc-400 bg-transparent'
                          )} />
                          {draft.rtp_coverage_keepalive_enabled !== false ? 'On — RTP flows during gaps' : 'Off'}
                        </button>
                      </div>
                      <AdvancedField
                        label="Keepalive Rate (pps)"
                        value={draft.rtp_coverage_keepalive_pps}
                        disabled={disabled || draft.rtp_coverage_keepalive_enabled === false}
                        min={1}
                        error={errors.rtp_coverage_keepalive_pps}
                        tooltip="Low-rate RTP packets per second sent during coverage-mode idle gaps. Use 3-5 pps for devices that require visible media flow."
                        onChange={set('rtp_coverage_keepalive_pps')}
                      />

                      <div className="rounded-md border border-indigo-500/20 bg-slate-900/50 p-3 text-xs text-slate-300">
                        <div className="mb-2 flex items-center justify-between">
                          <span className="font-bold uppercase tracking-wide text-indigo-200">Coverage Preview</span>
                          <span className="font-mono text-slate-400">
                            {coveragePreview.pps.toFixed(0)} pps · hold {holdSeconds || 0}s
                          </span>
                        </div>
                        <div className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono">
                          <span>Full continuous</span>
                          <span className="text-right text-slate-100">{coveragePreview.fullPackets} pkts / direction</span>
                          <span>Coverage bursts</span>
                          <span className="text-right text-emerald-300">{coveragePreview.targetPackets} pkts / direction</span>
                          <span>Keepalive</span>
                          <span className="text-right text-sky-300">{coveragePreview.keepalivePackets} pkts / direction</span>
                          <span>Phase 1</span>
                          <span className="text-right">{coveragePreview.phase1Seconds.toFixed(1)}s · {coveragePreview.phase1Packets} pkts</span>
                          <span>Phase 2</span>
                          <span className="text-right">
                            {coveragePreview.midBurstCount} bursts · {coveragePreview.phase2Packets} pkts
                          </span>
                          <span>Phase 3</span>
                          <span className="text-right">{coveragePreview.phase3Seconds.toFixed(1)}s · {coveragePreview.phase3Packets} pkts</span>
                          <span>Mid-call spacing</span>
                          <span className="text-right text-indigo-200">{coveragePreview.spacingSeconds.toFixed(1)}s auto</span>
                          <span>Max RTP gap</span>
                          <span className="text-right text-indigo-200">≤ {coveragePreview.maxGapSeconds.toFixed(1)}s</span>
                          <span>Total per direction</span>
                          <span className="text-right text-emerald-300">{coveragePreview.totalPackets} pkts</span>
                          <span>Bidirectional total</span>
                          <span className="text-right text-emerald-300">{coveragePreview.bidirectionalPackets} pkts</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                )}
              </div>

              {/* Full-width — Reporting Refresh Interval (Media tab) */}
              {showMedia && (
              <div className="border-t border-slate-700/30 pt-3">
                <AdvancedField
                  label="Reporting Refresh Interval (s)"
                  value={draft.metrics_interval}
                  disabled={disabled}
                  min={1}
                  error={errors.metrics_interval}
                  hint="How frequently the backend pushes a metrics snapshot to the live reporting view. Lower = more responsive; higher = less CPU load."
                  tooltip="Controls the WebSocket /metrics/stream push cadence. Default 3s gives smooth live updates."
                  onChange={set('metrics_interval')}
                />
              </div>
              )}

              {/* Full-width — TCP Keepalive (Signaling tab) */}
              {showSignaling && (
              <div className="border-t border-slate-700/30 pt-3">
                <AdvancedField
                  label="TCP Keepalive (s)"
                  value={draft.tcp_keepalive_seconds}
                  disabled={disabled}
                  min={0}
                  error={errors.tcp_keepalive_seconds}
                  hint="OS-level TCP keepalive period for the SBC connection. Detects silently-dropped sockets (NAT/firewall idle, SBC idle timeouts) within ~5 minutes on Linux. 0 disables. Valid non-zero range: 5..300."
                  tooltip="Without keepalive, a stateful firewall or SBC can silently drop a long-idle TCP socket without our side noticing — the next INVITE then fails with 500 because the SBC has lost the registration binding. Recommended default: 30s."
                  onChange={set('tcp_keepalive_seconds')}
                />
              </div>
              )}

              {/* Full-width — 100rel (Signaling tab)
                  Default OFF; SBC-bug-aware. Risk-banner styled like the
                  RTCP-SR block to make it clear this is opt-in only. */}
              {showSignaling && (
              <div className="border-t border-slate-700/30 pt-3">
                <div className={cn(
                  'rounded-md border p-3 space-y-2',
                  draft.use_100rel
                    ? 'border-amber-500/50 bg-amber-500/5'
                    : 'border-amber-500/25 bg-amber-500/5',
                )}>
                  <div className="flex items-center gap-2">
                    <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-300">
                      Advanced
                    </span>
                    <span className="text-xs font-bold uppercase tracking-widest text-amber-200">
                      100rel — Reliable Provisional Responses (RFC 3262)
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="text-amber-400/70 hover:text-amber-300 transition-colors">
                          <Info className="size-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-sm text-xs leading-relaxed">
                        When enabled, UAC advertises <code className="font-mono text-amber-300">Supported: 100rel</code> on
                        outbound INVITEs and the call goes through the PRACK loop:
                        180 (Require:100rel + RSeq) → PRACK → 200/PRACK → 200/INVITE.
                        <br /><br />
                        <strong className="text-amber-300">Risk:</strong> at least one SBC has a TCP send-pipeline bug that
                        deterministically loses the 200/INVITE when 200/PRACK and 200/INVITE leave back-to-back on the same
                        dialog (15-byte sequence-number gap, never retransmitted). When this flag is on, the engine inserts
                        a 50 ms gap between 200/PRACK and 200/INVITE on the UAS side as a workaround. Leave OFF unless the
                        SBC is independently verified.
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                    <div className="space-y-1">
                      <Label className="text-sm font-semibold text-slate-200/90">100rel</Label>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setDraft((prev) => ({ ...prev, use_100rel: !prev.use_100rel }))}
                        className={cn(
                          'inline-flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors',
                          draft.use_100rel
                            ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                            : 'border-slate-600/50 bg-slate-800/60 text-slate-300 hover:border-amber-400/40',
                          disabled && 'opacity-70 cursor-default',
                        )}
                      >
                        <span className={cn(
                          'inline-block size-3 rounded-sm border-2 transition-colors',
                          draft.use_100rel ? 'border-amber-400 bg-amber-400' : 'border-zinc-400 bg-transparent'
                        )} />
                        {draft.use_100rel
                          ? 'Enabled — PRACK loop active, 50 ms gap before 200/INVITE'
                          : 'Disabled (default — safe)'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
              )}

              {/* Full-width — Media QoS (Media tab) */}
              {showMedia && (
              <div className="border-t border-slate-700/30 pt-3 space-y-3">
                <h3 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-sky-300">
                  <span className="h-4 w-0.5 shrink-0 rounded-full bg-sky-400" />
                  Media QoS
                  <span className="h-px flex-1 bg-sky-400/30" />
                </h3>

                <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                  {/* qos_enabled toggle */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-sm font-semibold text-slate-200/90">QoS Metrics</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="text-sky-400/70 hover:text-sky-300 transition-colors">
                            <Info className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                          Compute per-call interarrival jitter (RFC 3550), packet loss, and out-of-order counts.
                          Adds negligible per-packet overhead and surfaces media-quality flags in reports.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setDraft((prev) => ({ ...prev, qos_enabled: !prev.qos_enabled }))}
                      className={cn(
                        'inline-flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors',
                        draft.qos_enabled
                          ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-600/50 bg-slate-800/60 text-slate-300 hover:border-sky-400/40',
                        disabled && 'opacity-70 cursor-default',
                      )}
                    >
                      <span className={cn(
                        'inline-block size-3 rounded-sm border-2 transition-colors',
                        draft.qos_enabled ? 'border-emerald-400 bg-emerald-400' : 'border-zinc-400 bg-transparent'
                      )} />
                      {draft.qos_enabled ? 'Enabled — jitter, loss, OOO tracked' : 'Disabled'}
                    </button>
                  </div>

                  {/* qos_mos_estimation toggle */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-sm font-semibold text-slate-200/90">MOS Estimation</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="text-sky-400/70 hover:text-sky-300 transition-colors">
                            <Info className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                          Compute Mean Opinion Score (1.0–4.5) per call using the simplified ITU-T G.107 E-Model
                          for G.711. Approximation only — disable if customer reports require exact subjective scoring.
                          Requires QoS Metrics enabled.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <button
                      type="button"
                      disabled={disabled || !draft.qos_enabled}
                      onClick={() => setDraft((prev) => ({ ...prev, qos_mos_estimation: !prev.qos_mos_estimation }))}
                      className={cn(
                        'inline-flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors',
                        draft.qos_mos_estimation && draft.qos_enabled
                          ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
                          : 'border-slate-600/50 bg-slate-800/60 text-slate-300 hover:border-sky-400/40',
                        (disabled || !draft.qos_enabled) && 'opacity-70 cursor-default',
                      )}
                    >
                      <span className={cn(
                        'inline-block size-3 rounded-sm border-2 transition-colors',
                        draft.qos_mos_estimation && draft.qos_enabled ? 'border-emerald-400 bg-emerald-400' : 'border-zinc-400 bg-transparent'
                      )} />
                      {!draft.qos_enabled
                        ? 'Requires QoS Metrics'
                        : draft.qos_mos_estimation ? 'Enabled — MOS computed per call' : 'Disabled'}
                    </button>
                  </div>
                </div>

                {/* RTCP Sender Reports — Phase 2, RISKY, default OFF */}
                <div className={cn(
                  'mt-3 rounded-md border p-3 space-y-3',
                  draft.rtcp_sr_enabled
                    ? 'border-amber-500/50 bg-amber-500/5'
                    : 'border-amber-500/25 bg-amber-500/5',
                )}>
                  <div className="flex items-center gap-2">
                    <span className="rounded border border-amber-500/40 bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-amber-300">
                      Advanced
                    </span>
                    <span className="text-xs font-bold uppercase tracking-widest text-amber-200">
                      RTCP Sender Reports
                    </span>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button type="button" className="text-amber-400/70 hover:text-amber-300 transition-colors">
                          <Info className="size-3" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-sm text-xs leading-relaxed">
                        Transmits RTCP Sender Report packets on the same UDP socket as RTP (RFC 5761 mux),
                        enabling round-trip-time measurement via SR/RR exchange.
                        SDP will advertise <code className="font-mono text-amber-300">a=rtcp-mux</code>.
                        <br /><br />
                        <strong className="text-amber-300">Risk:</strong> If the SBC does not support RTCP-mux
                        it may drop calls. Verify in a controlled environment before enabling for production traffic.
                      </TooltipContent>
                    </Tooltip>
                  </div>

                  <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                    {/* rtcp_sr_enabled toggle */}
                    <div className="space-y-1">
                      <Label className="text-sm font-semibold text-slate-200/90">RTCP SR Transmission</Label>
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => setDraft((prev) => ({ ...prev, rtcp_sr_enabled: !prev.rtcp_sr_enabled }))}
                        className={cn(
                          'inline-flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors',
                          draft.rtcp_sr_enabled
                            ? 'border-amber-500/60 bg-amber-500/15 text-amber-300'
                            : 'border-slate-600/50 bg-slate-800/60 text-slate-300 hover:border-amber-400/40',
                          disabled && 'opacity-70 cursor-default',
                        )}
                      >
                        <span className={cn(
                          'inline-block size-3 rounded-sm border-2 transition-colors',
                          draft.rtcp_sr_enabled ? 'border-amber-400 bg-amber-400' : 'border-zinc-400 bg-transparent'
                        )} />
                        {draft.rtcp_sr_enabled
                          ? 'Enabled — RTCP SR + a=rtcp-mux'
                          : 'Disabled (default — safe)'}
                      </button>
                    </div>

                    {/* rtcp_sr_interval_seconds */}
                    <AdvancedField
                      label="SR Interval (s)"
                      value={draft.rtcp_sr_interval_seconds}
                      disabled={disabled || !draft.rtcp_sr_enabled}
                      min={1}
                      error={errors.rtcp_sr_interval_seconds}
                      hint={!draft.rtcp_sr_enabled ? 'Requires RTCP SR Transmission' : '1..60 s — RFC 3550 recommends ~5%'}
                      tooltip="How frequently RTCP Sender Reports are emitted during a call. Default 5s gives reasonable RTT samples without flooding the SBC."
                      onChange={set('rtcp_sr_interval_seconds')}
                    />
                  </div>
                </div>
              </div>
              )}

              {!isEditing && (
                <div className="border-t border-slate-700/30 pt-2">
                  <TokenRow s={saved} tab={tab} />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
