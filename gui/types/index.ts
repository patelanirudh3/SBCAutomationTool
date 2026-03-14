export type VMRole = 'UAC' | 'UAS'
export type TrafficMode = 'smoke' | 'timed' | 'unlimited'
export type SipTransport = 'TCP' | 'TLS' | 'UDP'
export type RunPhase = 'IDLE' | 'PRE_PHASE' | 'TRAFFIC' | 'COMPLETE' | 'FAILED'
export type RunMode = 'local' | 'multi-vm'

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

  // SIP Connection
  sbc_host: string
  sbc_port: number
  sip_transport: SipTransport
  domain: string
  sip_password: string

  // Traffic
  cps: number
  hold_time_seconds: number
  metrics_port: number
  peer_stop_url?: string      // UAC only — auto-derived from UAS vm_ip + metrics_port

  // Run Control (UAC only)
  traffic_mode?: TrafficMode
  call_count?: number
  duration_hours?: number

  // Registration
  register_rate: number
  register_timeout: number
  register_retry: number
}

export interface VMPair {
  pair_id: string             // e.g. 'pair-1'
  pair_label: string          // e.g. 'Pair 1'
  uac: VMConfig
  uas: VMConfig
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
  result: 'COMPLETED' | 'FAILED'
  failure_reason?: string
  pdd_ms: number
  hold_ms: number
  media_status: 'MEDIA_VERIFIED' | 'MEDIA_PARTIAL' | 'MEDIA_FAILED' | 'NO_MEDIA'
  rtp_tx_pkts?: number
  rtp_rx_pkts?: number
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
