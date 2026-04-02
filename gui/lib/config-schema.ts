import { z } from 'zod'

const VM_ID_REGEX = /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/
const DOMAIN_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]*\.)+[a-zA-Z]{2,}$/
const LABEL_REGEX = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/

function isValidIpv4(val: string): boolean {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(val)) return false
  return val.split('.').every((octet) => {
    const n = Number(octet)
    return Number.isInteger(n) && n >= 0 && n <= 255
  })
}

function isValidHostname(val: string): boolean {
  if (val.length === 0 || val.length > 253) return false
  const labels = val.split('.')
  if (labels.some((l) => l.length === 0 || l.length > 63)) return false
  if (!labels.every((l) => LABEL_REGEX.test(l))) return false
  return labels.some((l) => /[a-zA-Z]/.test(l))
}

function isValidIpOrHostname(val: string): boolean {
  if (isValidIpv4(val)) return true
  const segments = val.split('.')
  if (segments.length === 4 && segments.filter((s) => /^\d+$/.test(s)).length >= 3) return false
  return isValidHostname(val)
}

export const VMRoleSchema = z.enum(['UAC', 'UAS'])
export const TrafficModeSchema = z.enum(['smoke', 'timed', 'unlimited'])
export const SipTransportSchema = z.enum(['TCP', 'TLS', 'UDP'])

export const VMConfigSchema = z
  .object({
    vm_role: VMRoleSchema,
    vm_id: z
      .string()
      .min(1, 'VM ID is required')
      .regex(VM_ID_REGEX, 'Letter start, alphanumeric + hyphens, max 32 chars'),

    vm_ip: z
      .string()
      .min(1, 'VM IP / hostname is required')
      .refine(isValidIpOrHostname, 'Must be a valid IPv4 address or hostname'),
    ssh_user: z.string().optional(),
    ssh_key_path: z.string().optional(),

    uac_ext_start: z.number().int().min(1000, 'Must be at least 4 digits').max(9999999999, 'Too many digits'),
    uac_ext_end: z.number().int().min(1000, 'Must be at least 4 digits').max(9999999999, 'Too many digits'),
    uas_ext_start: z.number().int().min(1000, 'Must be at least 4 digits').max(9999999999, 'Too many digits'),
    uas_ext_end: z.number().int().min(1000, 'Must be at least 4 digits').max(9999999999, 'Too many digits'),

    sbc_host: z
      .string()
      .min(1, 'Primary host is required')
      .refine(isValidIpOrHostname, 'Must be a valid IPv4 address or hostname'),
    sbc_port: z.number().int().min(1).max(65535, 'Port must be 1–65535'),
    secondary_host: z
      .string()
      .refine((v) => !v || isValidIpOrHostname(v), 'Must be a valid IPv4 address or hostname')
      .optional(),
    secondary_port: z.number().int().min(1).max(65535, 'Port must be 1–65535').optional(),
    failover_enabled: z.boolean().optional(),
    dns_servers: z.string().optional(),
    sip_transport: SipTransportSchema,
    domain: z
      .string()
      .min(1, 'Domain is required')
      .regex(DOMAIN_REGEX, 'Must be a valid domain (e.g. avaya.com)'),
    sip_password: z.string().min(1, 'SIP password is required'),

    cps: z.number().positive('CPS must be positive').max(200, 'CPS cannot exceed 200'),
    hold_time_seconds: z.number().nonnegative('Hold time must be ≥ 0').max(3600, 'Cannot exceed 3600s'),
    ramp_up_seconds: z.number().nonnegative('Ramp-up must be ≥ 0').max(300, 'Cannot exceed 300s').optional(),
    media_enabled: z.boolean().optional(),
    metrics_port: z.number().int().min(1).max(65535, 'Port must be 1–65535'),
    peer_stop_url: z
      .string()
      .url('Must be a valid http:// URL')
      .optional()
      .or(z.literal('')),

    traffic_mode: TrafficModeSchema.optional(),
    call_count: z.number().int().nonnegative().max(1000000, 'Cannot exceed 1,000,000').optional(),
    duration_hours: z.number().positive().max(168, 'Cannot exceed 168h (1 week)').optional(),
  })
  .superRefine((data, ctx) => {
    if (data.uac_ext_start >= data.uac_ext_end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uac_ext_end'],
        message: 'End must be greater than Start',
      })
    }

    if (data.uas_ext_start >= data.uas_ext_end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uas_ext_end'],
        message: 'End must be greater than Start',
      })
    }

    const uacRange = { start: data.uac_ext_start, end: data.uac_ext_end }
    const uasRange = { start: data.uas_ext_start, end: data.uas_ext_end }
    if (uasRange.start <= uacRange.end && uasRange.end >= uacRange.start) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['uas_ext_start'],
        message: 'UAC and UAS extension ranges must not overlap',
      })
    }

    if (data.vm_role === 'UAC') {
      if (data.traffic_mode === 'smoke' && !data.call_count) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['call_count'],
          message: 'call_count required for smoke mode',
        })
      }
      if (data.traffic_mode === 'timed' && !data.duration_hours) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duration_hours'],
          message: 'duration_hours required for timed mode',
        })
      }
    }
  })

export type VMConfigInput = z.input<typeof VMConfigSchema>
export type VMConfigOutput = z.output<typeof VMConfigSchema>

// Derives UAC peer_stop_url from UAS vm_ip + metrics_port (per spec)
export function deriveUACPeerStopUrl(uasVmIp: string, uasMetricsPort: number): string {
  if (!uasVmIp || !uasMetricsPort) return ''
  return `http://${uasVmIp}:${uasMetricsPort}/api/test/stop`
}

export function deriveExtCount(start: number, end: number): number {
  if (!start || !end || end <= start) return 0
  return end - start + 1
}

export function deriveMaxCalls(cps: number, durationHours: number): number {
  return Math.floor(cps * durationHours * 3600)
}

export type FieldWarnings = Record<string, string>

export function getFieldWarnings(raw: {
  sbc_port: string
  cps: string
  hold_time_seconds: string
  call_count: string
  duration_hours: string
  traffic_mode: string
}): FieldWarnings {
  const w: FieldWarnings = {}

  const port = parseInt(raw.sbc_port)
  if (port > 0 && port < 1024) {
    w.sbc_port = 'Privileged port — may require elevated permissions'
  }

  const cps = parseFloat(raw.cps)
  if (cps > 50) {
    w.cps = 'High call rate — ensure SBC can handle this load'
  }

  const holdTime = parseFloat(raw.hold_time_seconds)
  if (holdTime === 0) {
    w.hold_time_seconds = 'Zero hold time — calls will tear down immediately'
  }

  const callCount = parseInt(raw.call_count)
  if (raw.traffic_mode === 'smoke' && callCount > 10000) {
    w.call_count = 'Large run — consider timed mode for extended tests'
  }

  const duration = parseFloat(raw.duration_hours)
  if (raw.traffic_mode === 'timed' && duration > 24) {
    w.duration_hours = 'Long run — ensure system stability for multi-day tests'
  }

  return w
}
