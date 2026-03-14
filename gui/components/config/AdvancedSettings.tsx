'use client'

import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Settings2, Pencil, Check, ChevronDown } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'
import type { AdvancedSettings as AdvancedSettingsType } from '@/types'
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
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  min?: number
  step?: number
  error?: string
  hint?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs font-medium text-foreground/80">{label}</Label>
      <Input
        type="number"
        min={min ?? 1}
        step={step ?? 1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className={cn(
          'font-mono',
          disabled && 'cursor-default opacity-60'
        )}
      />
      {error && <FieldError error={error} />}
      {!error && hint && <FieldHint>{hint}</FieldHint>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Token row (collapsed read-only display)
// ---------------------------------------------------------------------------

function TokenRow({ s }: { s: AdvancedSettingsType }) {
  const tokens = [
    `reg_rate: ${s.register_rate}`,
    `timeout: ${s.register_timeout}s`,
    `retry: ${s.register_retry}`,
    `rtp_burst: ${s.rtp_burst_seconds}s / ${s.rtp_burst_pps}pps`,
    `keepalive: ${s.rtp_keepalive_interval}s`,
    `pool_wrap_delay: ${s.pool_wrap_delay_seconds}s`,
  ]

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {tokens.map((tok, i) => (
        <span key={i} className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-foreground/70">{tok}</span>
          {i < tokens.length - 1 && (
            <span className="text-muted-foreground/40">·</span>
          )}
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
    const newErrors: Partial<Record<keyof AdvancedSettingsType, string>> = {}
    for (const [key, val] of Object.entries(draft)) {
      if (!Number.isFinite(val as number) || (val as number) <= 0) {
        newErrors[key as keyof AdvancedSettingsType] = 'Must be a positive number'
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
      className="border-t-2 border-violet-500/40 bg-card/90 shadow-[0_-1px_0_oklch(0.30_0.02_250)]"
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
                'flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium',
                'border border-border/60 text-muted-foreground',
                'transition-colors hover:border-emerald-500/50 hover:text-emerald-400'
              )}
            >
              <Pencil className="size-2.5" />
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
          <TokenRow s={saved} />
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
                  <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
                    <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-blue-400/80" />
                    Registration
                    <span className="h-px flex-1 bg-border/60" />
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
                  <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-foreground/80">
                    <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-violet-400/80" />
                    RTP
                    <span className="h-px flex-1 bg-border/60" />
                  </h3>
                  <AdvancedField
                    label="RTP Burst Duration (s)"
                    value={draft.rtp_burst_seconds}
                    disabled={disabled}
                    error={errors.rtp_burst_seconds}
                    onChange={set('rtp_burst_seconds')}
                  />
                  <AdvancedField
                    label="RTP Burst PPS"
                    value={draft.rtp_burst_pps}
                    disabled={disabled}
                    error={errors.rtp_burst_pps}
                    onChange={set('rtp_burst_pps')}
                  />
                  <AdvancedField
                    label="RTP Keepalive Interval (s)"
                    value={draft.rtp_keepalive_interval}
                    disabled={disabled}
                    error={errors.rtp_keepalive_interval}
                    onChange={set('rtp_keepalive_interval')}
                  />
                </div>
              </div>

              {/* Full-width — Pool Wrap Delay */}
              <div className="border-t border-border/30 pt-3">
                <AdvancedField
                  label="Pool Wrap Delay (s)"
                  value={draft.pool_wrap_delay_seconds}
                  disabled={disabled}
                  error={errors.pool_wrap_delay_seconds}
                  hint="Delay between extension pool wraps during traffic phase"
                  onChange={set('pool_wrap_delay_seconds')}
                />
              </div>

              {/* Current token row (read-only summary while expanded) */}
              {!isEditing && (
                <div className="border-t border-border/30 pt-2">
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
