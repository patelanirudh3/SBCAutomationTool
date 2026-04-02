export type VMRole = 'UAC' | 'UAS'
export type TrafficMode = 'smoke' | 'timed' | 'unlimited'
export type SipTransport = 'TCP' | 'TLS' | 'UDP'
export type RunPhase = 'IDLE' | 'PRE_PHASE' | 'TRAFFIC' | 'COMPLETE' | 'FAILED'
export type RunMode = 'local' | 'multi-vm'

export type RtpMode = '3phase' | 'continuous'
export type RtpPtime = 20 | 40

export interface AdvancedSettings {
  register_batch_size: number          // default: 10 — concurrent batch size for TCP connect + REGISTER
  register_batch_delay_ms: number      // default: 500 — delay (ms) between TCP socket / REGISTER batches
  register_timeout: number             // default: 5 — per-REGISTER and per-SUBSCRIBE response wait (s)
  register_retry: number               // default: 3 — retry attempts for REGISTER and SUBSCRIBE
  subscribe_concurrency: number        // default: 10 — max concurrent SUBSCRIBE operations
  rtp_mode: RtpMode                    // default: '3phase'
  rtp_ptime: RtpPtime                  // default: 20 (ms) → 50 PPS
  rtp_burst_seconds: number            // default: 2
  rtp_burst_pps: number                // default: 50
  rtp_keepalive_interval: number       // default: 3
  pool_wrap_delay_seconds: number      // default: 0 — extra margin beyond auto-computed delay
  metrics_interval: number             // default: 3  — WS push cadence (seconds)
  rtp_pcap: boolean                    // default: false — capture RTP to pcap files
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  register_batch_size: 10,
  register_batch_delay_ms: 500,
  register_timeout: 5,
  register_retry: 3,
  subscribe_concurrency: 10,
  rtp_mode: '3phase',
  rtp_ptime: 20,
  rtp_burst_seconds: 2,
  rtp_burst_pps: 50,
  rtp_keepalive_interval: 3,
  pool_wrap_delay_seconds: 0,
  metrics_interval: 3,
  rtp_pcap: false,
}

export interface VMConfig {
  // Identity
  vm_role: VMRole
  vm_id: string

  // VM Connection
  vm_ip: string               // default '127.0.0.1' in local mode
  ssh_user?: string
  ssh_key_path?: string

  // Extensions
  uac_ext_start: number
  uac_ext_end: number
  uas_ext_start: number
  uas_ext_end: number

  // SIP Connection (Primary)
  sbc_host: string
  sbc_port: number
  sip_transport: SipTransport
  domain: string
  sip_password: string

  // SIP Connection (Secondary / Failover)
  secondary_host?: string
  secondary_port?: number
  failover_enabled?: boolean
  dns_servers?: string

  // Traffic
  cps: number
  hold_time_seconds: number
  ramp_up_seconds?: number    // UAC only — default: 5
  media_enabled?: boolean     // UAC only — default: true; false = signaling-only
  metrics_port: number
  peer_stop_url?: string      // UAC only — auto-derived from UAS vm_ip + metrics_port

  // Run Control (UAC only)
  traffic_mode?: TrafficMode
  call_count?: number
  duration_hours?: number
}

export interface VMPair {
  pair_id: string             // e.g. 'pair-1'
  pair_label: string          // e.g. 'Pair 1'
  uac: VMConfig
  uas: VMConfig
  advancedSettings: AdvancedSettings
  validated: boolean
  saved: boolean
  save_error?: string
}

export interface TrafficMetrics {
  vm_id: string
  phase: RunPhase
  running: boolean
  cps_actual: number
  concurrent_calls: number
  calls_attempted: number
  calls_completed: number
  calls_failed: number
  asr: number
  avg_pdd_ms: number
  min_pdd_ms: number
  max_pdd_ms: number
  avg_hold_ms: number
  socket_count: number
  registered_count: number
  run_elapsed_seconds: number
}

export interface PrePhaseStatus {
  vm_id: string
  role: VMRole
  register_complete: boolean
  register_count: number
  register_total: number
  subscribe_complete: boolean
  subscribe_count: number
  subscribe_total: number
  extensions_ready: boolean
  auto_answer_started: boolean  // UAS only — never shown on UAC panel
  auto_answer_active: boolean   // UAS only — never shown on UAC panel
}

export interface CallEvent {
  call_id: string
  uac_ext: string
  uas_ext: string
  ext?: string
  peer_ext?: string
  direction?: 'uac' | 'uas'
  result: 'COMPLETED' | 'FAILED'
  failure_reason?: string
  pdd_ms: number
  hold_ms: number
  media_status: 'MEDIA_VERIFIED' | 'MEDIA_PARTIAL' | 'MEDIA_FAILED' | 'NO_MEDIA'
  rtp_tx_pkts?: number
  rtp_rx_pkts?: number
  rtp_rx_from_sbc_pkts?: number
  rtp_rx_other_pkts?: number
  rtp_asymmetry_flag?: string
  rtcp_rx_pkts?: number
  markers_sent?: number
  markers_received?: number
  sbc_rtp_relay_ip?: string
  sbc_rtp_relay_port?: number
  ts_utc?: string
  timestamp: string
}

export interface AggregateMetrics {
  total_attempted: number
  total_completed: number
  total_failed: number
  aggregate_asr: number
  run_id: string
  started_at: string
  ended_at?: string
}

export interface ReachabilityStatus {
  vm_id: string
  reachable: boolean
  checking: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// SIP Milestones — mirrors backend SipMilestones dataclass
// ---------------------------------------------------------------------------

export interface SipMilestones {
  invite_sent_ms: number
  invite_received_ms: number
  trying_100_ms: number
  trying_100_sent_ms: number
  ringing_180_ms: number
  ringing_180_sent_ms: number
  prack_sent_ms: number
  prack_received_ms: number
  prack_200_ms: number
  prack_200_sent_ms: number
  ok_200_ms: number
  ok_200_sent_ms: number
  ack_sent_ms: number
  ack_received_ms: number
  rtp_start_ms: number
  rtp_end_ms: number
  bye_sent_ms: number
  bye_received_ms: number
  bye_200_ms: number
  bye_200_sent_ms: number
  invite_ts_utc: string
  uas_invite_ts_utc: string
}

// ---------------------------------------------------------------------------
// Call Spine — correlated UAC + UAS leg view
// ---------------------------------------------------------------------------

export interface CallIds {
  leg_a: string
  leg_b: string | null
  b2bua_boundary: string
  note: string
}

export interface MediaCrossCheckDir {
  uac_tx?: number
  uas_rx?: number
  uas_rx_total?: number
  uas_tx?: number
  uac_rx?: number
  uac_rx_total?: number
  delta_pct: number
  flag: 'OK' | 'WARNING' | 'CRITICAL'
}

export interface MediaCrossCheck {
  uac_tx_vs_uas_rx: MediaCrossCheckDir
  uas_tx_vs_uac_rx: MediaCrossCheckDir
  overall_status: 'OK' | 'DEGRADED'
}

export interface PayloadIntegrityDir {
  uac_tx?: number
  uas_rx?: number
  uas_tx?: number
  uac_rx?: number
  uac_markers_sent?: number
  uas_markers_sent?: number
  markers_embedded_ok?: boolean
  delta_pct: number
  integrity_pct: number
  verdict: 'OK' | 'WARNING' | 'CRITICAL'
}

export interface PayloadIntegrity {
  uac_to_uas: PayloadIntegrityDir
  uas_to_uac: PayloadIntegrityDir
  overall_verdict: 'PASS' | 'WARNING' | 'FAIL'
  overall_integrity_pct?: number
  note?: string
}

export interface CallSpine {
  spine_id: string
  correlation_method: string
  call_ids: CallIds
  uac_leg: Record<string, unknown>
  uas_leg: Record<string, unknown> | null
  media_cross_check: MediaCrossCheck
  payload_integrity?: PayloadIntegrity
  kam_trace: unknown | null
}

// ---------------------------------------------------------------------------
// SIP Ladder
// ---------------------------------------------------------------------------

export type LadderColumnId = 'uac' | 'sbcL' | 'cm' | 'sbcR' | 'uas'

export interface LadderEvent {
  t: number
  label: string
  from?: LadderColumnId
  to?: LadderColumnId
  code?: number
  callId?: string
  annotation?: string
  type?: 'rtp' | 'divider'
  state?: 'active' | 'held'
  inferred?: boolean
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export interface Scenario {
  id: string
  name: string
  description: string
  status: 'available' | 'coming_soon'
  assertions: string[]
}
