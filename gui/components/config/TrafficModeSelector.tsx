'use client'

import { useState, useEffect } from 'react'
import { Zap, Clock, Infinity as InfinityIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError, FieldSoftWarning } from './ConfigValidator'
import { deriveMaxCalls } from '@/lib/config-schema'
import { cn } from '@/lib/utils'
import type { TrafficMode } from '@/types'

interface TrafficModeSelectorProps {
  value: TrafficMode
  onChange: (mode: TrafficMode) => void
  callCount: string
  onCallCountChange: (v: string) => void
  durationHours: string
  onDurationHoursChange: (v: string) => void
  cps: string
  errors: { call_count?: string; duration_hours?: string }
  warnings: { call_count?: string; duration_hours?: string }
  touched: { call_count?: boolean; duration_hours?: boolean }
  onBlur: (field: 'call_count' | 'duration_hours') => void
}

const MODES = [
  { value: 'smoke' as const, label: 'Smoke', Icon: Zap, desc: 'Fixed call count' },
  { value: 'timed' as const, label: 'Timed', Icon: Clock, desc: 'Run for duration' },
  { value: 'unlimited' as const, label: 'Unlimited', Icon: InfinityIcon, desc: 'Until stopped' },
]

// Duration presets — stored internally as decimal hours
const DURATION_PRESETS = [
  { label: '15 min', hours: 0, mins: 15 },
  { label: '30 min', hours: 0, mins: 30 },
  { label: '1h',     hours: 1, mins: 0  },
  { label: '8h',     hours: 8, mins: 0  },
  { label: '24h',    hours: 24, mins: 0 },
]

/** Format a call count as a BHCC string: 3600 → "3.6k", 15000 → "15k", 500 → "500" */
function formatBHCC(calls: number): string {
  if (calls < 1000) return calls.toString()
  const k = calls / 1000
  const s = k.toFixed(1)
  return (s.endsWith('.0') ? s.slice(0, -2) : s) + 'k'
}

/** Parse a decimal-hours float into { h, m } integers */
function hoursToHM(dh: number): { h: number; m: number } {
  if (!Number.isFinite(dh) || dh < 0) return { h: 0, m: 0 }
  const h = Math.floor(dh)
  const m = Math.round((dh - h) * 60)
  return { h, m }
}

export function TrafficModeSelector({
  value,
  onChange,
  callCount,
  onCallCountChange,
  durationHours,
  onDurationHoursChange,
  cps,
  errors,
  warnings,
  touched,
  onBlur,
}: TrafficModeSelectorProps) {
  const dhFloat = parseFloat(durationHours) || 0
  const { h: initH, m: initM } = hoursToHM(dhFloat)

  const [hours, setHours] = useState(initH)
  const [mins, setMins]   = useState(initM)

  // Sync local H/M state when durationHours changes externally (preset click, reset)
  useEffect(() => {
    const { h, m } = hoursToHM(parseFloat(durationHours) || 0)
    setHours(h)
    setMins(m)
  }, [durationHours])

  const applyHM = (h: number, m: number) => {
    const total = h + m / 60
    onDurationHoursChange(total > 0 ? String(Math.round(total * 10000) / 10000) : '0')
  }

  const handleHoursChange = (v: string) => {
    const h = Math.max(0, parseInt(v) || 0)
    setHours(h)
    applyHM(h, mins)
  }

  const handleMinsChange = (v: string) => {
    const m = Math.min(59, Math.max(0, parseInt(v) || 0))
    setMins(m)
    applyHM(hours, m)
  }

  const handlePreset = (h: number, m: number) => {
    setHours(h)
    setMins(m)
    applyHM(h, m)
  }

  const cpsNum   = parseFloat(cps) || 0
  const maxCalls = value === 'timed' && cpsNum > 0 && dhFloat > 0
    ? deriveMaxCalls(cpsNum, dhFloat)
    : null

  const isExactlyOneHour = hours === 1 && mins === 0
  const currentPresetValue = String(dhFloat)

  return (
    <div className="space-y-3">
      {/* Mode radio cards */}
      <div className="grid grid-cols-3 gap-2">
        {MODES.map(({ value: modeVal, label, Icon, desc }) => {
          const isSelected = value === modeVal
          return (
            <button
              key={modeVal}
              type="button"
              onClick={() => onChange(modeVal)}
              className={cn(
                'flex flex-col items-center gap-1.5 rounded-lg border px-2 py-3 text-center transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                isSelected
                  ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                  : 'border-border bg-secondary/40 text-muted-foreground hover:border-border/80 hover:bg-secondary hover:text-foreground'
              )}
            >
              <Icon className="size-4 shrink-0" />
              <span className="text-xs font-semibold">{label}</span>
              <span className="text-[10px] leading-tight opacity-70">{desc}</span>
            </button>
          )
        })}
      </div>

      {/* Smoke: call_count */}
      {value === 'smoke' && (
        <div className="space-y-1">
          <Label className="text-xs font-medium text-foreground/80">Call Count</Label>
          <Input
            type="number"
            min={1}
            value={callCount}
            onChange={(e) => onCallCountChange(e.target.value)}
            onBlur={() => onBlur('call_count')}
            placeholder="e.g. 20"
            className="font-mono"
            aria-invalid={touched.call_count && !!errors.call_count ? true : undefined}
          />
          {touched.call_count && <FieldError error={errors.call_count} />}
          {touched.call_count && !errors.call_count && <FieldSoftWarning warning={warnings.call_count} />}
        </div>
      )}

      {/* Timed: H + M split inputs with presets inline */}
      {value === 'timed' && (
        <div className="space-y-2">
          {/* Visible "Duration" section label */}
          <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-200">
            <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-slate-400" />
            Duration
          </p>

          {/* H + M inputs + presets on the same row */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Hours input */}
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                value={hours}
                onChange={(e) => handleHoursChange(e.target.value)}
                onBlur={() => onBlur('duration_hours')}
                className="w-14 font-mono text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                aria-label="hours"
                aria-invalid={touched.duration_hours && !!errors.duration_hours ? true : undefined}
              />
              <span className="text-xs font-medium text-slate-400">h</span>
            </div>

            {/* Minutes input */}
            <div className="flex items-center gap-1">
              <Input
                type="number"
                min={0}
                max={59}
                value={mins}
                onChange={(e) => handleMinsChange(e.target.value)}
                onBlur={() => onBlur('duration_hours')}
                className="w-14 font-mono text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                aria-label="minutes"
              />
              <span className="text-xs font-medium text-slate-400">min</span>
            </div>

            {/* Preset chips — inline beside inputs */}
            <div className="flex flex-wrap gap-1">
              {DURATION_PRESETS.map((p) => {
                const isActive = hours === p.hours && mins === p.mins
                return (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => handlePreset(p.hours, p.mins)}
                    className={cn(
                      'rounded border px-2 py-1 text-[10px] font-semibold transition-colors',
                      isActive
                        ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                        : 'border-slate-600 bg-slate-800/50 text-slate-300 hover:border-slate-500 hover:text-slate-100'
                    )}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
          </div>

          {touched.duration_hours && <FieldError error={errors.duration_hours} />}
          {touched.duration_hours && !errors.duration_hours && <FieldSoftWarning warning={warnings.duration_hours} />}

          {/* Footer: always shows BHCC equivalent regardless of duration */}
          {maxCalls !== null && maxCalls > 0 && (() => {
            const bhcc = formatBHCC(maxCalls)
            const bhccEquiv = formatBHCC(Math.round(maxCalls / 3600))
            const durationLabel = `${hours > 0 ? `${hours}h` : ''}${mins > 0 ? ` ${mins}m` : ''}`.trim()
            return (
              <div className="flex flex-wrap items-baseline gap-1.5 rounded border border-amber-500/20 bg-amber-950/20 px-2.5 py-1.5">
                <span className="text-xs font-bold text-amber-400">
                  ≈ {maxCalls.toLocaleString()} max calls
                </span>
                <span className="text-[11px] text-amber-400/70">
                  at {cps} CPS × {durationLabel}
                </span>
                <span className="text-xs font-semibold text-amber-300">
                  ≈ {isExactlyOneHour ? `${bhcc} BHCC` : `${bhcc} BHCC equivalent`}
                </span>
              </div>
            )
          })()}
        </div>
      )}

      {/* Unlimited: greyed note */}
      {value === 'unlimited' && (
        <p className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
          Runs until coordinator{' '}
          <code className="font-mono text-foreground">POST /api/test/stop</code>
        </p>
      )}
    </div>
  )
}
