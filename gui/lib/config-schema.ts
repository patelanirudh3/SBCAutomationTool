import { z } from 'zod'

export const VMRoleSchema = z.enum(['UAC', 'UAS'])
export const TrafficModeSchema = z.enum(['smoke', 'timed', 'unlimited'])
export const SipTransportSchema = z.enum(['TCP', 'TLS', 'UDP'])

export const VMConfigSchema = z
  .object({
    vm_role: VMRoleSchema,
    vm_id: z.string().min(1, 'VM ID is required'),

    // VM Connection
    vm_ip: z.string().min(1, 'VM IP / hostname is required'),
    ssh_user: z.string().optional(),
    ssh_key_path: z.string().optional(),

    // Extensions
    uac_ext_start: z.number().int().positive('Must be a positive integer'),
    uac_ext_end: z.number().int().positive('Must be a positive integer'),
    uas_ext_start: z.number().int().positive('Must be a positive integer'),
    uas_ext_end: z.number().int().positive('Must be a positive integer'),

    // SIP Connection
    sbc_host: z.string().min(1, 'SBC host is required'),
    sbc_port: z.number().int().min(1).max(65535, 'Port must be 1–65535'),
    sip_transport: SipTransportSchema,
    domain: z.string().min(1, 'Domain is required'),
    sip_password: z.string().min(1, 'SIP password is required'),

    // Traffic
    cps: z.number().positive('CPS must be positive'),
    hold_time_seconds: z.number().nonnegative('Hold time must be ≥ 0'),
    metrics_port: z.number().int().min(1).max(65535, 'Port must be 1–65535'),
    peer_stop_url: z
      .string()
      .url('Must be a valid http:// URL')
      .optional()
      .or(z.literal('')),

    // Run Control (UAC only)
    traffic_mode: TrafficModeSchema.optional(),
    call_count: z.number().int().nonnegative().optional(),
    duration_hours: z.number().positive().optional(),
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
