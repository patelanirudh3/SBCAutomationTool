'use client'

import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings2, Pencil, Check, ChevronDown, Info } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTrafficStore } from '@/store/traffic'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'
import type { AdvancedSettings as AdvancedSettingsType, RtpMode } from '@/types'
import { cn } from '@/lib/utils'
import { FieldError, FieldHint } from './ConfigValidator'

// ---------------------------------------------------------------------------
// Field helper
// ---------------------------------------------------------------------------

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
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <Label className="text-xs font-semibold text-slate-200/90">{label}</Label>
        {tooltip && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="text-indigo-400/70 hover:text-indigo-300 transition-colors">
                <Info className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
      <Input
        type="number"
        min={min ?? 1}
        step={step ?? 1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={cn(
          'font-mono border-slate-600/50 bg-slate-800/80 text-slate-100',
          'focus-visible:border-indigo-400/60 focus-visible:ring-1 focus-visible:ring-indigo-400/30',
          disabled && 'cursor-default opacity-75'
        )}
      />
      {error && <FieldError error={error} />}
      {!error && hint && <FieldHint>{hint}</FieldHint>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Token row (collapsed read-only summary)
// ---------------------------------------------------------------------------

function TokenRow({ s }: { s: AdvancedSettingsType }) {
  const modeLabel = (s.rtp_mode || '3phase') === 'continuous' ? 'continuous' : '3-phase'

  // qos_enabled / qos_mos_estimation default to true; show a token only when
  // the admin has explicitly opted out, to keep the row uncluttered.
  const qosTokens: string[] = []
  if (s.qos_enabled === false) qosTokens.push('qos: off')
  else if (s.qos_mos_estimation === false) qosTokens.push('qos: jitter+loss')

  const tokens = [
    `batch_size: ${s.register_batch_size}`,
    `batch_delay: ${s.register_batch_delay_ms}ms`,
    `timeout: ${s.register_timeout}s`,
    `retry: ${s.register_retry}`,
    `subscribe: ${s.subscribe_concurrency}`,
    `rtp: ${modeLabel}`,
    `burst: ${s.rtp_burst_seconds}s`,
    `keepalive: ${s.rtp_keepalive_interval}s`,
    `refresh: ${s.metrics_interval}s`,
    ...(s.rtp_pcap ? ['pcap: on'] : []),
    ...qosTokens,
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {tokens.map((tok, i) => (
        <span key={i} className="flex items-center gap-2">
          <span className="font-mono text-[11px] font-medium text-slate-300">{tok}</span>
          {i < tokens.length - 1 && <span className="text-slate-600">·</span>}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AdvancedSettings({ pairIndex }: { pairIndex: number }) {
  const { pairs, updateAdvancedSettings } = useTrafficStore()
  const saved: AdvancedSettingsType =
    pairs[pairIndex]?.advancedSettings ?? { ...DEFAULT_ADVANCED_SETTINGS }

  const [isOpen, setIsOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<AdvancedSettingsType>({ ...saved })
  const [errors, setErrors] = useState<Partial<Record<keyof AdvancedSettingsType, string>>>({})
  const panelRef = useRef<HTMLDivElement>(null)

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

  useEffect(() => {
    if (!isEditing) return
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) handleCancel()
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
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
    const ALLOW_ZERO: Set<string> = new Set(['register_batch_delay_ms'])
    const SKIP: Set<string> = new Set(['rtp_mode', 'rtp_pcap', 'qos_enabled', 'qos_mos_estimation'])
    const newErrors: Partial<Record<keyof AdvancedSettingsType, string>> = {}
    for (const [key, val] of Object.entries(draft)) {
      if (SKIP.has(key)) continue
      const v = val as number
      if (!Number.isFinite(v)) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be a number'
      } else if (ALLOW_ZERO.has(key) ? v < 0 : v <= 0) {
        newErrors[key as keyof AdvancedSettingsType] =
          ALLOW_ZERO.has(key) ? 'Must be ≥ 0' : 'Must be a positive number'
      }
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
          <span className="text-[11px] font-bold uppercase tracking-widest text-slate-100">
            Advanced Settings — Registration &amp; RTP
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
            <Button size="sm" onClick={handleSave} className="h-6 gap-1 px-2.5 text-[11px]">
              <Check className="size-3" />
              Save
            </Button>
          )}
        </div>
      </div>

      {/* Token row (collapsed) */}
      {!isOpen && (
        <div className="border-t border-slate-700/40 px-5 py-2">
          <TokenRow s={saved} />
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
            <div className="border-t border-slate-700/40 px-5 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">

                {/* Left — Pre-Phase / Registration */}
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-blue-300">
                    <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-blue-400" />
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
                    <p className="font-mono text-[11px] text-slate-300">
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
                </div>

                {/* Right — RTP */}
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-indigo-300">
                    <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-indigo-400" />
                    RTP
                    <span className="h-px flex-1 bg-indigo-400/30" />
                  </h3>

                  {/* RTP Mode */}
                  <div className="space-y-1">
                    <Label className="text-xs font-semibold text-slate-200/90">RTP Mode</Label>
                    <div className="flex gap-2">
                      {(['3phase', 'continuous'] as const).map((m) => (
                        <button
                          key={m}
                          type="button"
                          disabled={disabled}
                          onClick={() => setDraft((prev) => ({ ...prev, rtp_mode: m as RtpMode }))}
                          className={cn(
                            'flex-1 rounded-md px-3 py-2 text-xs font-bold border transition-colors',
                            draft.rtp_mode === m
                              ? 'border-indigo-500/70 bg-indigo-600/25 text-white'
                              : 'border-slate-600/60 bg-slate-800/70 text-slate-300 hover:border-indigo-500/40 hover:text-slate-200',
                            disabled && 'opacity-70 cursor-default',
                          )}
                        >
                          {m === '3phase' ? '3-Phase Burst' : 'Continuous'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* PCAP capture */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs font-semibold text-slate-200/90">PCAP Capture</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="text-indigo-400/70 hover:text-indigo-300 transition-colors">
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
                        'inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors',
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
                      {draft.rtp_pcap ? 'Enabled — pcap files saved to logs/' : 'Disabled'}
                    </button>
                  </div>

                  {/* 3-Phase-only fields */}
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
                </div>
              </div>

              {/* Full-width — Reporting Refresh Interval */}
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

              {/* Full-width — Media QoS */}
              <div className="border-t border-slate-700/30 pt-3 space-y-3">
                <h3 className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-sky-300">
                  <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-sky-400" />
                  Media QoS
                  <span className="h-px flex-1 bg-sky-400/30" />
                </h3>

                <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                  {/* qos_enabled toggle */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs font-semibold text-slate-200/90">QoS Metrics</Label>
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
                      <Label className="text-xs font-semibold text-slate-200/90">MOS Estimation</Label>
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
              </div>

              {!isEditing && (
                <div className="border-t border-slate-700/30 pt-2">
                  <TokenRow s={saved} />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
