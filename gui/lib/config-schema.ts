import { z } from 'zod'
import { SUBSCRIBE_EVENT_VALUES } from './subscription-events'

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
export const SipSchemeSchema = z.enum(['SIP', 'SIPS'])
export const TLSModeSchema = z.enum(['insecure', 'server_ca', 'client_cert', 'mutual'])
export const RtpCodecSchema = z.enum(['G711_ULAW', 'G711_ALAW', 'G729', 'OPUS'])
export const MediaSecuritySchema = z.enum(['rtp', 'srtp_sdes'])
export const SRTPCryptoSuiteSchema = z.enum(['AES_CM_128_HMAC_SHA1_80', 'AES_CM_128_HMAC_SHA1_32'])
export const SubscribeEventSchema = z.enum(SUBSCRIBE_EVENT_VALUES)

export const VMConfigSchema = z
  .object({
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

    // Unified extension range (single pool)
    ext_start: z.number().int().min(1000, 'Must be at least 4 digits').max(9999999999, 'Too many digits'),
    ext_end: z.number().int().min(1000, 'Must be at least 4 digits').max(9999999999, 'Too many digits'),
    ext_count: z.number().int().min(2, 'Need at least 2 extensions').max(100000, 'Too many extensions').optional(),

    sbc_host: z
      .string()
      .min(1, 'Remote SIP server host is required')
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
    sip_scheme: SipSchemeSchema.optional(),
    domain: z
      .string()
      .min(1, 'Domain is required')
      .regex(DOMAIN_REGEX, 'Must be a valid domain (e.g. avaya.com)'),
    sip_password: z.string().min(1, 'SIP password is required'),

    tls_mode: TLSModeSchema.optional(),
    tls_ca_path: z.string().optional(),
    tls_cert_path: z.string().optional(),
    tls_key_path: z.string().optional(),
    tls_server_name: z.string().optional(),
    tls_min_version: z.enum(['1.2', '1.3']).optional(),
    tls_max_version: z.enum(['auto', '1.2', '1.3']).optional(),

    register_expires: z.number().int().min(60, 'Minimum 60s').max(86400, 'Maximum 86400s (24h)').optional(),
    subscribe_expires: z.number().int().min(60, 'Minimum 60s').max(86400, 'Maximum 86400s (24h)').optional(),
    subscribe_events: z.array(SubscribeEventSchema).min(1, 'Select at least one SUBSCRIBE event').optional(),
    subscribe_refresh_events: z.array(SubscribeEventSchema).optional(),
    subscribe_unsubscribe_events: z.array(SubscribeEventSchema).optional(),
    register_rate_cps: z.number().positive('Rate must be positive').max(500, 'Cannot exceed 500 reg/s').optional(),
    t1_ms: z.number().int().min(100, 'Minimum 100 ms').max(5000, 'Maximum 5000 ms').optional(),
    timer_b_seconds: z.number().int().min(1, 'Minimum 1 s').max(300, 'Maximum 300 s').optional(),

    cps: z.number().positive('CPS must be positive').max(200, 'CPS cannot exceed 200'),
    hold_time_seconds: z.number().nonnegative('Hold time must be ≥ 0').max(3600, 'Cannot exceed 3600s'),
    // Wall-clock seconds for the engine to ramp from 0 cps → configured cps.
    // 0 disables ramp (full speed from t=0). Mirrors backend
    // VMConfig.RampUpSeconds semantics in go/internal/engine/call_engine.go.
    ramp_up_seconds: z.number().int().nonnegative('Ramp-up must be ≥ 0').max(3600, 'Cannot exceed 3600s').optional(),
    media_enabled: z.boolean().optional(),
    media_security: MediaSecuritySchema.optional(),
    srtp_crypto_suites: z.array(SRTPCryptoSuiteSchema).optional(),
    srtp_key_mode: z.literal('auto').optional(),
    rtp_codec: RtpCodecSchema.optional(),
    rtp_ptime: z.number().int().min(10).max(80).optional(),
    metrics_port: z.number().int().min(1).max(65535, 'Port must be 1–65535'),

    traffic_mode: TrafficModeSchema.optional(),
    call_count: z.number().int().nonnegative().max(1000000, 'Cannot exceed 1,000,000').optional(),
    duration_hours: z.number().positive().max(168, 'Cannot exceed 168h (1 week)').optional(),
    start_time_iso: z.string().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.ext_start >= data.ext_end) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ext_end'],
        message: 'End must be greater than Start',
      })
    }

    if (data.ext_end - data.ext_start < 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ext_count'],
        message: 'Need at least 2 extensions',
      })
    }

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

    if (data.sip_scheme === 'SIPS' && data.sip_transport !== 'TLS') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sip_scheme'],
        message: 'SIPS requires TLS transport',
      })
    }

    const selected = new Set(data.subscribe_events ?? [])
    for (const event of data.subscribe_refresh_events ?? []) {
      if (!selected.has(event)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subscribe_refresh_events'],
          message: `${event} must be selected before refresh can be enabled`,
        })
      }
    }
    for (const event of data.subscribe_unsubscribe_events ?? []) {
      if (!selected.has(event)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['subscribe_unsubscribe_events'],
          message: `${event} must be selected before unsubscribe can be enabled`,
        })
      }
    }

    if (data.sip_transport === 'TLS') {
      const mode = data.tls_mode ?? 'insecure'
      const min = data.tls_min_version ?? '1.2'
      const max = data.tls_max_version ?? 'auto'
      if (max !== 'auto' && Number(max) < Number(min)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tls_max_version'],
          message: 'Max TLS version cannot be lower than minimum',
        })
      }
      if ((mode === 'server_ca' || mode === 'mutual') && !data.tls_ca_path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tls_ca_path'],
          message: 'CA certificate path is required for this TLS mode',
        })
      }
      if (mode === 'client_cert' || mode === 'mutual') {
        if (!data.tls_cert_path) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tls_cert_path'],
            message: 'Client certificate path is required for this TLS mode',
          })
        }
        if (!data.tls_key_path) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tls_key_path'],
            message: 'Client private key path is required for this TLS mode',
          })
        }
      }
    }

    if (data.media_security === 'srtp_sdes') {
      if (data.media_enabled === false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['media_security'],
          message: 'SRTP requires media to be enabled',
        })
      }
      if (!data.srtp_crypto_suites || data.srtp_crypto_suites.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['srtp_crypto_suites'],
          message: 'Select at least one SRTP crypto suite',
        })
      }
    }
  })

export type VMConfigInput = z.input<typeof VMConfigSchema>
export type VMConfigOutput = z.output<typeof VMConfigSchema>

/** @deprecated No longer used; left for backward compat with existing callers */
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
  register_rate_cps?: string
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
