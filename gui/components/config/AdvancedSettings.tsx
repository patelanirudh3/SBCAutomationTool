'use client'

import { useState, useEffect, useRef, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings2, Pencil, Check, ChevronDown, Info } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTrafficStore } from '@/store/traffic'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'
import type { AdvancedSettings as AdvancedSettingsType, RtpMode, RtpPtime } from '@/types'
import { cn } from '@/lib/utils'
import { FieldError, FieldHint } from './ConfigValidator'

// ---------------------------------------------------------------------------
// Field definition helpers
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
              <button type="button" className="text-violet-400/70 hover:text-violet-300 transition-colors">
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
          'font-mono border-zinc-600/60 bg-zinc-800/70 text-slate-100',
          'focus-visible:border-violet-500/60 focus-visible:ring-1 focus-visible:ring-violet-500/30',
          disabled && 'cursor-default opacity-55'
        )}
      />
      {error && <FieldError error={error} />}
      {!error && hint && <FieldHint>{hint}</FieldHint>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Wrap analysis helpers (derived, read-only)
// ---------------------------------------------------------------------------

const SIP_BYE_BUFFER = 2

function gcd(a: number, b: number): number { return b === 0 ? a : gcd(b, a % b) }
function lcm(a: number, b: number): number { return (a * b) / gcd(a, b) }

export interface WrapAnalysis {
  poolCount: number
  wrapTime: number
  holdTime: number
  naturalSpacing: boolean
  autoDelay: number
  userMargin: number
  effectiveDelay: number
  minPoolForNatural: number
}

function useWrapAnalysis(pairIndex: number, advSettings: AdvancedSettingsType): WrapAnalysis {
  const pair = useTrafficStore((s) => s.pairs[pairIndex])
  return useMemo(() => {
    if (!pair) {
      return { poolCount: 0, wrapTime: 0, holdTime: 0, naturalSpacing: true, autoDelay: 0, userMargin: 0, effectiveDelay: 0, minPoolForNatural: 0 }
    }
    const uacCount = pair.uac.uac_ext_end - pair.uac.uac_ext_start + 1
    const uasCount = pair.uas.uas_ext_end - pair.uas.uas_ext_start + 1
    const poolCount = lcm(Math.max(uacCount, 1), Math.max(uasCount, 1))
    const cps = Math.max(pair.uac.cps, 0.001)
    const wrapTime = poolCount / cps
    const holdTime = pair.uac.hold_time_seconds
    const naturalSpacing = wrapTime >= holdTime + SIP_BYE_BUFFER

    const worstCaseElapsed = wrapTime
    const autoDelay = Math.max(0, holdTime + SIP_BYE_BUFFER - worstCaseElapsed)

    const userMargin = advSettings.pool_wrap_delay_seconds ?? 0
    const effectiveDelay = autoDelay + Math.max(0, userMargin)
    const minPoolForNatural = Math.ceil(cps * (holdTime + SIP_BYE_BUFFER))

    return { poolCount, wrapTime, holdTime, naturalSpacing, autoDelay, userMargin, effectiveDelay, minPoolForNatural }
  }, [pair, advSettings.pool_wrap_delay_seconds])
}

// ---------------------------------------------------------------------------
// Token row (collapsed read-only display)
// ---------------------------------------------------------------------------

function TokenRow({ s, analysis }: { s: AdvancedSettingsType; analysis: WrapAnalysis }) {
  const wrapLabel = analysis.naturalSpacing
    ? 'natural'
    : `auto ${analysis.autoDelay.toFixed(0)}s + ${Math.max(0, analysis.userMargin)}s`

  const pps = 1000 / (s.rtp_ptime || 20)
  const modeLabel = (s.rtp_mode || '3phase') === 'continuous' ? 'continuous' : '3-phase'

  const tokens = [
    `reg_rate: ${s.register_rate}`,
    `timeout: ${s.register_timeout}s`,
    `retry: ${s.register_retry}`,
    `rtp: ${modeLabel} ${s.rtp_ptime || 20}ms/${pps}pps`,
    `burst: ${s.rtp_burst_seconds}s`,
    `keepalive: ${s.rtp_keepalive_interval}s`,
    `pool_wrap_delay: ${s.pool_wrap_delay_seconds}s`,
    `metrics: ${s.metrics_interval}s`,
    `wrap: ${wrapLabel}`,
    ...(s.rtp_pcap ? ['pcap: on'] : []),
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {tokens.map((tok, i) => (
        <span key={i} className="flex items-center gap-2">
          <span className={cn(
            'font-mono text-[11px] font-medium',
            tok.startsWith('wrap:')
              ? analysis.naturalSpacing ? 'text-emerald-400' : 'text-amber-400'
              : 'text-cyan-300/80'
          )}>
            {tok}
          </span>
          {i < tokens.length - 1 && (
            <span className="text-violet-400/40">·</span>
          )}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function AdvancedSettings({ pairIndex, liveAnalysis }: { pairIndex: number; liveAnalysis?: WrapAnalysis }) {
  const { pairs, updateAdvancedSettings } = useTrafficStore()
  const saved: AdvancedSettingsType =
    pairs[pairIndex]?.advancedSettings ?? { ...DEFAULT_ADVANCED_SETTINGS }

  const storeAnalysis = useWrapAnalysis(pairIndex, saved)
  const analysis = liveAnalysis ?? storeAnalysis

  const [isOpen, setIsOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<AdvancedSettingsType>({ ...saved })
  const [errors, setErrors] = useState<Partial<Record<keyof AdvancedSettingsType, string>>>({})
  const panelRef = useRef<HTMLDivElement>(null)

  // Sync draft when saved changes externally (e.g. store reset)
  useEffect(() => {
    if (!isEditing) setDraft({ ...saved })
  }, [saved, isEditing])

  // Escape key: cancel edit
  useEffect(() => {
    if (!isEditing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing])

  // Click-away: cancel edit
  useEffect(() => {
    if (!isEditing) return
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        handleCancel()
      }
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
    const ALLOW_ZERO: Set<string> = new Set(['pool_wrap_delay_seconds'])
    const SKIP_NUMERIC: Set<string> = new Set(['rtp_mode', 'rtp_ptime', 'rtp_pcap'])
    const newErrors: Partial<Record<keyof AdvancedSettingsType, string>> = {}
    for (const [key, val] of Object.entries(draft)) {
      if (SKIP_NUMERIC.has(key)) continue
      const v = val as number
      if (!Number.isFinite(v)) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be a number'
      } else if (ALLOW_ZERO.has(key) ? v < 0 : v <= 0) {
        newErrors[key as keyof AdvancedSettingsType] =
          ALLOW_ZERO.has(key) ? 'Must be ≥ 0' : 'Must be a positive number'
      }
    }
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }
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
        'border-t-2 border-violet-500/50 bg-violet-950/20',
        'shadow-[0_-1px_12px_oklch(0.35_0.10_290/0.25)]',
        'ring-1 ring-violet-500/15',
      )}
    >
      {/* ── Header row ──────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-5 py-2.5">
        <button
          type="button"
          onClick={() => !isEditing && setIsOpen((o) => !o)}
          className="flex flex-1 items-center gap-2 text-left"
        >
          <Settings2 className="size-4 shrink-0 text-violet-400 drop-shadow-[0_0_6px_oklch(0.60_0.18_290/0.7)]" />
          <span className="text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
            Advanced Settings — Registration &amp; RTP
          </span>
          <span className="rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300">
            shared for this VM Pair
          </span>
          <ChevronDown
            className={cn(
              'ml-0.5 size-3.5 shrink-0 text-foreground/50 transition-transform duration-200',
              isOpen && 'rotate-180'
            )}
          />
        </button>

        <div className="flex shrink-0 items-center gap-3">
          <span className="flex items-center gap-1 text-[11px] font-medium text-foreground/60">
            <span className="inline-block size-1.5 rounded-full bg-blue-400" />
            <span className="inline-block size-1.5 rounded-full bg-violet-400" />
            Affects both UAC and UAS
          </span>

          {!isEditing ? (
            <button
              type="button"
              onClick={handleEdit}
              className={cn(
                'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-semibold',
                'border border-violet-500/40 text-violet-300',
                'transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-400'
              )}
            >
              <Pencil className="size-3.5" />
              Edit
            </button>
          ) : (
            <Button
              size="sm"
              onClick={handleSave}
              className="h-6 gap-1 px-2.5 text-[11px]"
            >
              <Check className="size-3" />
              Save
            </Button>
          )}
        </div>
      </div>

      {/* ── Token row (collapsed, always visible below header) ─── */}
      {!isOpen && (
        <div className="border-t border-border/30 px-5 py-2">
          <TokenRow s={saved} analysis={analysis} />
        </div>
      )}

      {/* ── Expanded body ──────────────────────────────────────── */}
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
            <div className="border-t border-border/30 px-5 py-4 space-y-4">

              {/* 2-column grid */}
              <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                {/* Left column — Registration */}
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-blue-300">
                    <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-blue-400" />
                    Registration
                    <span className="h-px flex-1 bg-blue-500/20" />
                  </h3>
                  <AdvancedField
                    label="Register Rate (reg/s)"
                    value={draft.register_rate}
                    disabled={disabled}
                    error={errors.register_rate}
                    onChange={set('register_rate')}
                  />
                  <AdvancedField
                    label="Register Timeout (s)"
                    value={draft.register_timeout}
                    disabled={disabled}
                    error={errors.register_timeout}
                    onChange={set('register_timeout')}
                  />
                  <AdvancedField
                    label="Register Retry"
                    value={draft.register_retry}
                    min={0}
                    disabled={disabled}
                    error={errors.register_retry}
                    onChange={set('register_retry')}
                  />
                </div>

                {/* Right column — RTP */}
                <div className="space-y-3">
                  <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-violet-300">
                    <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-violet-400" />
                    RTP
                    <span className="h-px flex-1 bg-violet-500/20" />
                  </h3>

                  {/* RTP Mode toggle */}
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
                            'flex-1 rounded-md px-3 py-1.5 text-xs font-semibold border transition-colors',
                            draft.rtp_mode === m
                              ? 'border-violet-500 bg-violet-500/20 text-violet-200'
                              : 'border-zinc-600/50 bg-zinc-800/50 text-zinc-400 hover:border-violet-500/40',
                            disabled && 'opacity-55 cursor-default',
                          )}
                        >
                          {m === '3phase' ? '3-Phase Burst' : 'Continuous'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Codec ptime dropdown */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs font-semibold text-slate-200/90">Codec ptime</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="text-violet-400/70 hover:text-violet-300 transition-colors">
                            <Info className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                          G.711 PCMU packetization time. Determines packets per second: PPS = 1000 ÷ ptime
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <select
                      disabled={disabled}
                      value={draft.rtp_ptime}
                      onChange={(e) => {
                        const pt = Number(e.target.value) as RtpPtime
                        setDraft((prev) => ({
                          ...prev,
                          rtp_ptime: pt,
                          rtp_burst_pps: 1000 / pt,
                        }))
                      }}
                      className={cn(
                        'w-full rounded-md border px-3 py-2 font-mono text-sm',
                        'border-zinc-600/60 bg-zinc-800/70 text-slate-100',
                        'focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30 focus:outline-none',
                        disabled && 'cursor-default opacity-55',
                      )}
                    >
                      <option value={20}>20 ms (50 PPS)</option>
                      <option value={40}>40 ms (25 PPS)</option>
                    </select>
                    <p className="font-mono text-[10px] text-violet-300/60">
                      Formula: PPS = 1000 ÷ {draft.rtp_ptime} = {1000 / (draft.rtp_ptime || 20)} PPS
                    </p>
                  </div>

                  {/* Payload (read-only) */}
                  <div className="space-y-1">
                    <Label className="text-xs font-semibold text-slate-200/90">Payload</Label>
                    <div className="rounded-md border border-zinc-600/40 bg-zinc-800/50 px-3 py-2 font-mono text-sm text-emerald-300/80">
                      1 kHz Tone (PCMU)
                    </div>
                  </div>

                  {/* PCAP capture toggle */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5">
                      <Label className="text-xs font-semibold text-slate-200/90">PCAP Capture</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="text-violet-400/70 hover:text-violet-300 transition-colors">
                            <Info className="size-3" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-xs leading-relaxed">
                          Save RTP packets to .pcap files in logs/. Open in Wireshark to verify the 1 kHz tone payload and RTP flow. Best for smoke tests.
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => setDraft((prev) => ({ ...prev, rtp_pcap: !prev.rtp_pcap }))}
                      className={cn(
                        'flex items-center gap-2 w-full rounded-md px-3 py-2 text-xs font-semibold border transition-colors',
                        draft.rtp_pcap
                          ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-300'
                          : 'border-zinc-600/50 bg-zinc-800/50 text-zinc-400 hover:border-violet-500/40',
                        disabled && 'opacity-55 cursor-default',
                      )}
                    >
                      <span className={cn(
                        'inline-block size-3 rounded-sm border-2 transition-colors',
                        draft.rtp_pcap
                          ? 'border-emerald-400 bg-emerald-400'
                          : 'border-zinc-500 bg-transparent'
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
                        tooltip="Interval between keepalive packets during the mid-call period (between start and end bursts)."
                        onChange={set('rtp_keepalive_interval')}
                      />
                    </>
                  )}
                </div>
              </div>

              {/* Full-width — Pool Wrap Delay */}
              <div className="border-t border-border/30 pt-3">
                <AdvancedField
                  label="Pool Wrap Delay — Extra Margin (s)"
                  value={draft.pool_wrap_delay_seconds}
                  disabled={disabled}
                  min={0}
                  error={errors.pool_wrap_delay_seconds}
                  hint="Extra safety margin beyond the auto-computed delay. Default 0. Only needed if SBC is slow to release dialogs (e.g. 503s at wrap boundaries)."
                  tooltip="The engine auto-computes a wrap delay from hold_time + SIP_BYE_BUFFER (2s). This field adds extra seconds on top of that. Set to 0 unless your SBC needs more time to clean up dialogs."
                  onChange={set('pool_wrap_delay_seconds')}
                />
              </div>

              {/* Full-width — Metrics Interval */}
              <div className="border-t border-border/30 pt-3">
                <AdvancedField
                  label="Metrics Interval (s)"
                  value={draft.metrics_interval}
                  disabled={disabled}
                  min={1}
                  error={errors.metrics_interval}
                  hint="How often the backend pushes a fresh metrics snapshot over WebSocket to the Live Dashboard"
                  tooltip="Controls the WS /metrics/stream push cadence. Lower = more responsive Live Dashboard; higher = less CPU. Default 3s gives smooth updates without noticeable overhead."
                  onChange={set('metrics_interval')}
                />
              </div>

              {/* Current token row (read-only summary while expanded) */}
              {!isEditing && (
                <div className="border-t border-border/30 pt-2">
                  <TokenRow s={saved} analysis={analysis} />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
