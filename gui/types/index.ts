export type VMRole = 'UAC' | 'UAS'
export type TrafficMode = 'smoke' | 'timed' | 'unlimited'
export type SipTransport = 'TCP' | 'TLS' | 'UDP'
export type SipScheme = 'SIP' | 'SIPS'
export type TLSMode = 'insecure' | 'server_ca' | 'client_cert' | 'mutual'
export type RtpCodec = 'G711_ULAW' | 'G711_ALAW' | 'G729' | 'OPUS'
export type RunPhase =
  | 'IDLE'
  | 'PRE_PHASE'        // legacy alias of REGSUB_RUNNING
  | 'PRE_REGISTER'     // legacy alias of REGSUB_RUNNING
  | 'REGSUB_READY'     // waiting for Start Reg/Sub click
  | 'REGSUB_RUNNING'   // REGISTER + SUBSCRIBE in flight (live progress)
  | 'REGSUB_DONE'      // all reg/sub done — gates Start Traffic
  | 'TRAFFIC_READY'    // legacy alias of REGSUB_DONE
  | 'TRAFFIC'
  | 'STOPPING'
  | 'CLEANUP_READY'
  | 'CLEANING_UP'
  | 'COMPLETE'
  | 'DONE'
  | 'FAILED'

// PrepStatus tracks the optional async unregister flush invoked by the
// corner "Start Prep" button on the Reg/Sub view. Always present in
// TrafficMetrics; defaults to 'idle' before the operator clicks the button.
export type PrepStatus = 'idle' | 'running' | 'done' | 'failed'
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
  qos_enabled: boolean                 // default: true — track jitter, packet loss, OOO per call
  qos_mos_estimation: boolean          // default: true — compute MOS score (G.711 R-factor approximation)
  // Phase 2 (RISKY — default OFF): RTCP Sender Report transmission.
  // Enabling this advertises a=rtcp-mux in SDP and sends RTCP SR on the RTP
  // socket every rtcp_sr_interval_seconds. Required for RTT measurement,
  // but only safe when the SBC is known to support RFC 5761 RTCP-mux.
  rtcp_sr_enabled: boolean             // default: false
  rtcp_sr_interval_seconds: number     // default: 5 — clamp 1..60
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
  qos_enabled: true,
  qos_mos_estimation: true,
  rtcp_sr_enabled: false,
  rtcp_sr_interval_seconds: 5,
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

  // SIP timers (RFC 3261 §17.1.1, INVITE client transaction).
  // Both optional — backend uses RFC defaults when unset.
  t1_ms?: number                   // RFC default 500 — Timer A retransmit interval (UDP only)
  timer_b_seconds?: number         // RFC default 32 (= 64*T1) — INVITE transaction timeout

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

  // QoS / Media metrics admin knobs (Phase 1).
  // qos_enabled defaults to true on the backend; included here so the GUI
  // can opt-out a customer who doesn't want media-quality computation.
  qos_enabled?: boolean
  qos_mos_estimation?: boolean

  // RTCP Sender Report transmission (Phase 2 — RISKY, default OFF).
  // rtcp_mux_enabled is auto-coerced to true by the backend whenever
  // rtcp_sr_enabled=true (RFC 5761 multiplexing is required for safe
  // same-port RTCP transmission); GUI does not need to set it explicitly.
  rtcp_sr_enabled?: boolean
  rtcp_sr_interval_seconds?: number
  rtcp_mux_enabled?: boolean
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
  // calls_answered: count of calls that completed the INV/200/ACK three-way
  // handshake (UAC sent ACK, or UAS received ACK). Always ≥ calls_completed.
  calls_answered?: number
  calls_completed: number
  calls_failed: number
  asr: number
  avg_pdd_ms: number
  min_pdd_ms: number
  max_pdd_ms: number
  avg_hold_ms: number
  socket_count: number
  registered_count: number
  registered_total?: number
  subscribed_count?: number
  subscribed_total?: number
  // prep_status drives the corner Prep button visual state and the
  // disabled/enabled state of Start Reg/Sub. Backend defaults to 'idle'
  // until the operator clicks Start Prep.
  prep_status?: PrepStatus
  run_elapsed_seconds: number
  // Unified pool counts
  idle_count?: number
  non_idle_count?: number
  reg_only_count?: number
  // Cleanup (unregister) progress, populated during CLEANING_UP and frozen
  // at completion so the post-run UI can render the result strip.
  cleanup_count?: number
  cleanup_total?: number
  cleanup_failed?: string[]

  // QoS / Media aggregates (Phase 1) — averages over calls that produced
  // non-zero values; media_quality_counts is a 4-bucket histogram analogous
  // to RTPHealth (OK/WARNING/CRITICAL/UNKNOWN).
  avg_jitter_ms?: number
  avg_mos_score?: number
  avg_packet_loss_pct?: number
  media_quality_counts?: {
    OK: number
    WARNING: number
    CRITICAL: number
    UNKNOWN: number
  }
  // Phase 2 — round-trip time averaged across calls that produced an RTCP
  // SR/RR exchange. Always 0 when rtcp_sr_enabled is false.
  avg_rtt_ms?: number
}

// CleanupStatus mirrors the backend GET /api/cleanup/status payload and the
// cleanup_* fields on TrafficMetrics. Flat shape (count/total/failed)
// chosen for symmetry with PrePhaseStatus.
export interface CleanupStatus {
  count: number
  total: number
  failed_extensions: string[]
  in_progress: boolean
  complete: boolean
  // Wall-clock seconds the cleanup took. Set by the GUI when it observes
  // the transition from CLEANING_UP → COMPLETE, so it survives a refresh.
  elapsed_seconds?: number
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
  // answered: true if the INV/200/ACK three-way handshake completed
  // (orthogonal to result — a call can be answered=true, result=FAILED if
  // media or BYE handshake failed afterwards).
  answered?: boolean
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

  // Phase-1 QoS / Media metrics (per-call). Zero / undefined means the
  // metric was not produced for this call (no media, QoS disabled, or
  // RTCP not received from the SBC).
  jitter_ms?: number
  packet_loss_pct?: number
  lost_packets?: number
  ooo_packets?: number
  rtt_ms?: number
  remote_jitter_ms?: number
  remote_loss_pct?: number
  mos_score?: number
  media_quality_flag?: 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN'
  call_setup_ms?: number
  prack_rtt_ms?: number
  sip_txn_rtt_ms?: number
  bye_completion_ms?: number
}

export interface AggregateMetrics {
  total_attempted: number
  total_answered?: number
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
