export type VMRole = 'UAC' | 'UAS'
export type TrafficMode = 'smoke' | 'timed' | 'unlimited'
export type SipTransport = 'TCP' | 'TLS' | 'UDP'
export type SipScheme = 'SIP' | 'SIPS'
export type TLSMode = 'insecure' | 'server_ca' | 'client_cert' | 'mutual'
export type RtpCodec = 'G711_ULAW' | 'G711_ALAW' | 'G729' | 'OPUS'
export type RunPhase =
  | 'IDLE'
  | 'PRE_PHASE'
  | 'PRE_REGISTER'
  | 'TRAFFIC_READY'
  | 'TRAFFIC'
  | 'STOPPING'
  | 'CLEANUP_READY'
  | 'COMPLETE'
  | 'DONE'
  | 'FAILED'
export type RunMode = 'local' | 'multi-vm'

export type RtpMode = '3phase' | 'continuous'

export interface AdvancedSettings {
  register_batch_size: number          // default: 10 — concurrent batch size for TCP connect + REGISTER
  register_batch_delay_ms: number      // default: 500 — delay (ms) between TCP socket / REGISTER batches
  register_timeout: number             // default: 5 — per-REGISTER and per-SUBSCRIBE response wait (s)
  register_retry: number               // default: 3 — retry attempts for REGISTER and SUBSCRIBE
  subscribe_concurrency: number        // default: 10 — max concurrent SUBSCRIBE operations
  rtp_mode: RtpMode                    // default: '3phase'
  rtp_burst_seconds: number            // default: 2
  rtp_keepalive_interval: number       // default: 3
  metrics_interval: number             // default: 3 — reporting refresh cadence (seconds)
  rtp_pcap: boolean                    // default: false — capture RTP to pcap files
}

export const DEFAULT_ADVANCED_SETTINGS: AdvancedSettings = {
  register_batch_size: 10,
  register_batch_delay_ms: 500,
  register_timeout: 5,
  register_retry: 3,
  subscribe_concurrency: 10,
  rtp_mode: '3phase',
  rtp_burst_seconds: 2,
  rtp_keepalive_interval: 3,
  metrics_interval: 3,
  rtp_pcap: false,
}

export interface VMConfig {
  // Identity
  vm_role?: VMRole  // deprecated — not used in unified pool model
  vm_id: string

  // VM Connection
  vm_ip: string               // default '127.0.0.1' in local mode
  ssh_user?: string
  ssh_key_path?: string

  // Extensions (unified pool)
  ext_start: number
  ext_end: number

  // Legacy dual-range fields (kept for backward compat, no longer used by backend)
  uac_ext_start?: number
  uac_ext_end?: number
  uas_ext_start?: number
  uas_ext_end?: number

  // SIP Connection (Primary)
  sbc_host: string
  sbc_port: number
  sip_transport: SipTransport
  sip_scheme?: SipScheme         // default: 'SIP'
  domain: string
  sip_password: string

  // TLS — only consulted when sip_transport === 'TLS'
  tls_mode?: TLSMode               // default: 'insecure'
  tls_ca_path?: string             // PEM file with trusted CA(s)
  tls_cert_path?: string           // PEM file with client certificate
  tls_key_path?: string            // PEM file with client private key
  tls_server_name?: string         // SNI / cert verification hostname

  // SIP Connection (Secondary / Failover)
  secondary_host?: string
  secondary_port?: number
  failover_enabled?: boolean
  dns_servers?: string

  // Registration / Subscription
  register_expires?: number        // default: 3600 (seconds)
  subscribe_expires?: number       // default: 3600 (seconds)
  register_rate_cps?: number       // default: 10 — REGISTERs per second

  // Traffic
  cps: number
  hold_time_seconds: number
  media_enabled?: boolean
  metrics_port: number
  peer_stop_url?: string

  // Media
  rtp_codec?: RtpCodec             // default: 'G711_ULAW'
  rtp_ptime?: number               // default: 20 ms

  // Run Control
  traffic_mode?: TrafficMode
  call_count?: number
  duration_hours?: number
  start_time_iso?: string          // optional scheduled start (ISO 8601 UTC)
}

export interface VMPair {
  pair_id: string
  pair_label: string
  uac: VMConfig
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
  // Unified pool counts
  idle_count?: number
  non_idle_count?: number
  reg_only_count?: number
}

export interface PrePhaseStatus {
  vm_id: string
  role?: VMRole
  register_complete: boolean
  register_count: number
  register_total: number
  subscribe_complete: boolean
  subscribe_count: number
  subscribe_total: number
  extensions_ready: boolean
  // Unified pool result counts
  idle_count?: number
  reg_only_count?: number
  failed_count?: number
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
