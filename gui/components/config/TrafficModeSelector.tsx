'use client'

import { Zap, Clock, Infinity as InfinityIcon } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { FieldError } from './ConfigValidator'
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
  touched: { call_count?: boolean; duration_hours?: boolean }
  onBlur: (field: 'call_count' | 'duration_hours') => void
}

const MODES = [
  { value: 'smoke' as const, label: 'Smoke', Icon: Zap, desc: 'Fixed call count' },
  { value: 'timed' as const, label: 'Timed', Icon: Clock, desc: 'Run for duration' },
  { value: 'unlimited' as const, label: 'Unlimited', Icon: InfinityIcon, desc: 'Until stopped' },
]

const DURATION_PRESETS = [
  { label: '15 min', value: '0.25' },
  { label: '1h BHCC', value: '1' },
  { label: '8h', value: '8' },
  { label: '24h overnight', value: '24' },
]

export function TrafficModeSelector({
  value,
  onChange,
  callCount,
  onCallCountChange,
  durationHours,
  onDurationHoursChange,
  cps,
  errors,
  touched,
  onBlur,
}: TrafficModeSelectorProps) {
  const maxCalls =
    value === 'timed' && cps && durationHours
      ? deriveMaxCalls(parseFloat(cps) || 0, parseFloat(durationHours) || 0)
      : null

  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
        <span className="h-3.5 w-0.5 shrink-0 rounded-full bg-emerald-500/70" />
        Traffic Mode
        <span className="h-px flex-1 bg-border/60" />
      </h3>

      {/* Radio cards */}
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
        </div>
      )}

      {/* Timed: duration_hours with presets */}
      {value === 'timed' && (
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-foreground/80">Duration (hours)</Label>
          <div className="flex flex-wrap gap-1">
            {DURATION_PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => onDurationHoursChange(p.value)}
                className={cn(
                  'rounded border px-2 py-0.5 text-[10px] font-medium transition-colors',
                  durationHours === p.value
                    ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                    : 'border-border text-muted-foreground hover:border-border/80 hover:text-foreground'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          <Input
            type="number"
            min={0.01}
            step={0.25}
            value={durationHours}
            onChange={(e) => onDurationHoursChange(e.target.value)}
            onBlur={() => onBlur('duration_hours')}
            placeholder="e.g. 1.0"
            className="font-mono"
            aria-invalid={touched.duration_hours && !!errors.duration_hours ? true : undefined}
          />
          {touched.duration_hours && <FieldError error={errors.duration_hours} />}
          {maxCalls !== null && maxCalls > 0 && (
            <p className="text-xs text-muted-foreground">
              ≈ {maxCalls.toLocaleString()} max calls at {cps} CPS
            </p>
          )}
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
