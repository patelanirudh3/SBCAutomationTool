export type VMRole = 'UAC' | 'UAS'
export type TrafficMode = 'smoke' | 'timed' | 'unlimited'
export type SipTransport = 'TCP' | 'TLS' | 'UDP'
export type SipScheme = 'SIP' | 'SIPS'
export type LocalIPMode = 'single' | 'unique_vip' | 'vip_pool'
export type TLSMode = 'insecure' | 'server_ca' | 'client_cert' | 'mutual'
export type RtpCodec = 'G711_ULAW' | 'G711_ALAW' | 'G729' | 'OPUS'
export type MediaSecurity = 'rtp' | 'srtp_sdes'
export type SRTPCryptoSuite = 'AES_CM_128_HMAC_SHA1_80' | 'AES_CM_128_HMAC_SHA1_32'
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

export type RtpMode = '3phase' | '3phase_coverage' | 'continuous'

export interface AdvancedSettings {
  register_batch_size: number          // default: 10 — concurrent batch size for TCP connect + REGISTER
  register_batch_delay_ms: number      // default: 500 — delay (ms) between TCP socket / REGISTER batches
  register_timeout: number             // default: 5 — per-REGISTER and per-SUBSCRIBE response wait (s)
  register_retry: number               // default: 3 — retry attempts for REGISTER and SUBSCRIBE
  subscribe_concurrency: number        // default: 10 — max concurrent SUBSCRIBE operations
  rtp_mode: RtpMode                    // default: '3phase'
  rtp_burst_seconds: number            // default: 2
  rtp_keepalive_interval: number       // default: 3
  rtp_media_coverage_pct: number       // default: 25 — coverage-mode RTP volume relative to continuous
  rtp_start_burst_share_pct: number    // default: 20 — percentage of coverage budget sent after ACK
  rtp_end_burst_share_pct: number      // default: 20 — percentage of coverage budget sent before BYE
  rtp_mid_burst_seconds: number        // default: 3 — duration of each mid-call full-rate burst
  rtp_coverage_keepalive_enabled: boolean // default: true — low-rate RTP during coverage idle gaps
  rtp_coverage_keepalive_pps: number    // default: 3 — RTP keepalive packets per second during gaps
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
  // OS-level TCP keepalive period (seconds) applied to the SBC connection.
  // Detects silently-dropped sockets (NAT/firewall idle, SBC idle timeouts)
  // without waiting for the next failed Send. 0 disables keepalive (legacy).
  // Validation enforces 0 OR 5..300 s range.
  tcp_keepalive_seconds: number        // default: 30
  // Whether UAC advertises Supported: 100rel on outbound INVITEs (RFC 3262).
  // Default OFF — back-to-back emission of 200/PRACK + 200/INVITE on the
  // same dialog reliably triggers a 15-byte TCP sequence gap on at least
  // one SBC's send pipeline (deterministic 100% loss of 200/INVITE).
  // Disable unless the SBC has been independently verified to handle
  // consecutive 2xx responses correctly. Backend mirror: VMConfig.Use100Rel.
  use_100rel: boolean                  // default: false
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
  rtp_media_coverage_pct: 25,
  rtp_start_burst_share_pct: 20,
  rtp_end_burst_share_pct: 20,
  rtp_mid_burst_seconds: 3,
  rtp_coverage_keepalive_enabled: true,
  rtp_coverage_keepalive_pps: 3,
  metrics_interval: 3,
  rtp_pcap: false,
  qos_enabled: true,
  qos_mos_estimation: true,
  rtcp_sr_enabled: false,
  rtcp_sr_interval_seconds: 5,
  tcp_keepalive_seconds: 30,
  use_100rel: false,
}

export interface VMConfig {
  // Identity
  vm_role?: VMRole  // deprecated — not used in unified pool model
  vm_id: string

  // VM Connection
  vm_ip: string               // default '127.0.0.1' in local mode
  ssh_user?: string
  ssh_key_path?: string
  local_ip_mode?: LocalIPMode
  local_host?: string
  vip_interface?: string
  vip_cidr?: string
  vip_first_ip?: string
  vip_count?: number
  vip_gateway_ip?: string
  vip_sanity_target_ip?: string

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
  tls_min_version?: '1.2' | '1.3'
  tls_max_version?: 'auto' | '1.2' | '1.3'

  // SIP Connection (Secondary / Failover)
  secondary_host?: string
  secondary_port?: number
  failover_enabled?: boolean
  dns_servers?: string

  // Registration / Subscription
  register_expires?: number        // default: 3600 (seconds)
  subscribe_expires?: number       // default: 3600 (seconds)
  subscribe_event?: string         // legacy single-event alias
  subscribe_events?: string[]      // default: ['dialog']
  subscribe_refresh_events?: string[]
  subscribe_unsubscribe_events?: string[]
  register_rate_cps?: number       // default: 10 — REGISTERs per second

  // SIP timers (RFC 3261 §17.1.1, INVITE client transaction).
  // Both optional — backend uses RFC defaults when unset.
  t1_ms?: number                   // RFC default 500 — Timer A retransmit interval (UDP only)
  timer_b_seconds?: number         // RFC default 32 (= 64*T1) — INVITE transaction timeout

  // Traffic
  cps: number
  hold_time_seconds: number
  // Wall-clock seconds the engine should take to climb from 0 cps to
  // the configured cps when traffic starts. Mirrors backend
  // VMConfig.RampUpSeconds. 0 disables ramp-up (full speed from t=0).
  ramp_up_seconds?: number
  // Optional explicit ceiling for concurrent calls. When >0 it overrides
  // the cps × hold_time_seconds steady-state estimate (mirrors backend
  // VMConfig.EffectiveMaxConcurrent in go/internal/config/config.go).
  max_concurrent_calls?: number
  media_enabled?: boolean
  metrics_port: number
  peer_stop_url?: string

  // OS-level TCP keepalive seconds for the SBC connection. Mirrors
  // VMConfig.TCPKeepAliveSeconds in go/internal/config/config.go. 0 disables;
  // valid non-zero range 5..300. See AdvancedSettings.tcp_keepalive_seconds.
  tcp_keepalive_seconds?: number

  // Media
  media_security?: MediaSecurity
  srtp_crypto_suites?: SRTPCryptoSuite[]
  srtp_key_mode?: 'auto'
  rtp_codec?: RtpCodec             // default: 'G711_ULAW'
  rtp_ptime?: number               // default: 20 ms
  rtp_mode?: RtpMode
  rtp_burst_seconds?: number
  rtp_keepalive_interval?: number
  rtp_media_coverage_pct?: number
  rtp_start_burst_share_pct?: number
  rtp_end_burst_share_pct?: number
  rtp_mid_burst_seconds?: number
  rtp_coverage_keepalive_enabled?: boolean
  rtp_coverage_keepalive_pps?: number

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
  // concurrent_calls: dialogs in the post-ACK / pre-BYE-completion phase
  // (RFC 3261 §13.2.2.4 "confirmed" state). Reflects only truly established
  // calls — does NOT include calls in the INVITE→ACK setup window. Sourced
  // from PoolEngine.establishedCount / 2 on the backend.
  concurrent_calls: number
  // calls_invite_sent: total INVITEs we transmitted, regardless of whether
  // the SBC ever responded. The gap calls_invite_sent − calls_attempted is
  // diagnostic of network/SBC-reachability problems (INVITEs that left our
  // process but never elicited a 100 Trying).
  calls_invite_sent?: number
  // calls_attempted: INVITEs that the SBC accepted (received a 100 Trying).
  // Strict "the SBC saw our request" boundary; auth-retry second-100 is
  // suppressed by a once-per-call guard on the backend.
  calls_attempted: number
  // calls_answered: number of INVITEs that received a 200 OK response
  // (RFC 3261 §13.2.2.4 sense — "answered"). Independent of whether ACK
  // followed. Compare against calls_acknowledged to spot 100rel/PRACK or
  // SBC 200-OK delivery problems (high answered + low acknowledged means
  // the called party answered but the caller never confirmed).
  calls_answered?: number
  // calls_acknowledged: number of INVITEs that completed the full
  // INV/200/ACK three-way handshake (UAC sent ACK, UAS received ACK).
  // Below this counter the call is in established media phase.
  calls_acknowledged?: number
  calls_completed: number
  calls_failed: number
  // asr: Answer Seizure Ratio = calls_answered / calls_attempted * 100.
  asr: number
  // csr: Call Success Ratio = calls_completed / calls_attempted * 100.
  csr?: number
  avg_pdd_ms: number
  min_pdd_ms: number
  max_pdd_ms: number
  avg_hold_ms: number
  socket_count: number
  transport_connect_total?: number
  transport_connect_done?: number
  transport_connect_failed?: number
  transport_connect_active?: boolean
  transport_connect_failure_sample_limit?: number
  transport_connect_failed_details?: TransportConnectFailure[]
  registered_count: number
  registered_total?: number
  subscribed_count?: number
  subscribed_total?: number
  subscriptions_by_event?: Record<string, SubscriptionEventStats>
  // prep_status drives the corner Prep button visual state and the
  // disabled/enabled state of Start Reg/Sub. Backend defaults to 'idle'
  // until the operator clicks Start Prep.
  prep_status?: PrepStatus
  run_elapsed_seconds: number
  // Unified pool counts (3-state model). non_idle_count is the legacy
  // alias for setting_up_count + established_count, kept for backward
  // compatibility. New code should prefer established_count for the
  // "currently in call" tile because it excludes the transient call-setup
  // window between INVITE and ACK.
  idle_count?: number
  non_idle_count?: number
  setting_up_count?: number
  established_count?: number
  reg_only_count?: number
  // Cleanup (unregister) progress, populated during CLEANING_UP and frozen
  // at completion so the post-run UI can render the result strip.
  cleanup_count?: number
  cleanup_total?: number
  cleanup_failed?: string[]
  cleanup_unsubscribe_count?: number
  cleanup_unsubscribe_skipped?: number
  cleanup_unsubscribe_failed?: string[]
  cleanup_unsubscribe_by_event?: Record<string, SubscriptionEventStats>
  cleanup_unregister_count?: number
  cleanup_unregister_failed?: string[]

  // QoS / Media aggregates (Phase 1) — averages over calls that produced
  // non-zero values; media_quality_counts is a 4-bucket histogram analogous
  // to RTPHealth (OK/WARNING/CRITICAL/UNKNOWN).
  avg_jitter_ms?: number
  avg_mos_score?: number
  avg_packet_loss_pct?: number
  total_rtp_tx_pkts?: number
  total_rtp_rx_pkts?: number
  total_rtp_rx_from_sbc_pkts?: number
  total_rtp_expected_pkts?: number
  total_rtp_lost_pkts?: number
  total_rtp_ssrc_count?: number
  avg_rtp_tx_pkts?: number
  avg_rtp_rx_from_sbc_pkts?: number
  rtp_loss_pct?: number
  rtp_asymmetry_pct?: number
  rtp_asymmetry_flag?: 'OK' | 'WARNING' | 'CRITICAL'
  media_quality_counts?: {
    OK: number
    WARNING: number
    CRITICAL: number
    UNKNOWN: number
  }
  // Phase 2 — round-trip time averaged across calls that produced an RTCP
  // SR/RR exchange. Always 0 when rtcp_sr_enabled is false.
  avg_rtt_ms?: number
  host_health?: HostHealth
  parser_health?: ParserHealth
  media_security?: MediaSecurity
  srtp_crypto_suites?: SRTPCryptoSuite[]
  srtp_crypto_suite?: SRTPCryptoSuite
  host_cpu_avg_percent?: number
  host_cpu_max_percent?: number
  process_cpu_core_avg_percent?: number
  process_cpu_core_max_percent?: number
  softirq_cpu_max_percent?: number
  iowait_cpu_max_percent?: number

  // Graceful-drain timer surfaced when the timed-mode deadline fires or
  // when the operator clicks Graceful Stop. While `graceful_drain_active`
  // is true the run timer (`run_elapsed_seconds`) is frozen at the
  // deadline value and the GUI renders the drain countdown instead.
  graceful_drain_active?: boolean
  graceful_drain_total_seconds?: number
  graceful_drain_seconds_remaining?: number

  // Re-Run pre-flight REGISTER refresh result. Surfaces a non-blocking
  // warning banner during the iteration when some agents could not refresh
  // their SBC binding before traffic resumed.
  reregister_status?: {
    iteration: number
    attempted: number
    refreshed: number
    full_reregistered: number
    failed: number
    failed_extensions?: string[]
  }

  // Post-drain pool reconciliation result. When `failed` is true, the GUI
  // renders a red alert in the Final Report advising the operator to
  // Unregister rather than Re-Run with stuck agents.
  reconciliation_status?: {
    expected_idle: number
    actual_idle: number
    attempt: number
    reconciled: boolean
    failed: boolean
    stuck_agents?: string[]
  }
}

export interface SubscriptionEventStats {
  total: number
  successful: number
  failed: number
  notify_received: number
}

export interface HostHealth {
  cpu_percent?: number
  cpu_user_percent?: number
  cpu_system_percent?: number
  cpu_iowait_percent?: number
  cpu_irq_percent?: number
  cpu_softirq_percent?: number
  cpu_steal_percent?: number
  cpu_idle_percent?: number
  load1?: number
  load5?: number
  load15?: number
  mem_total_bytes?: number
  mem_available_bytes?: number
  mem_used_percent?: number
  process_cpu_percent?: number
  process_cpu_percent_vm?: number
  process_cpu_percent_core?: number
  process_rss_bytes?: number
  process_vms_bytes?: number
  process_threads?: number
  process_read_bytes?: number
  process_write_bytes?: number
  process_read_syscalls?: number
  process_write_syscalls?: number
  disk_total_bytes?: number
  disk_free_bytes?: number
  disk_used_percent?: number
  udp_in_datagrams?: number
  udp_in_errors?: number
  udp_rcvbuf_errors?: number
  net_rx_bytes?: number
  net_tx_bytes?: number
  goroutines?: number
  open_fds?: number
  uptime_seconds?: number
  top_process_mode?: PerformanceDiagnosticsMode
  top_processes?: TopProcessSnapshot[]
  top_process_sample_unix?: number
  performance_warnings?: string[]
}

export type PerformanceDiagnosticsMode = 'off' | 'warning_only' | 'slow'

export interface TopProcessSnapshot {
  pid: number
  name: string
  cpu_percent_core?: number
  rss_bytes?: number
}

export interface ParserHealth {
  invalid_start_line?: number
  invalid_content_length?: number
  conflicting_content_length?: number
  malformed_header?: number
  folded_header_without_parent?: number
}

// CleanupStatus mirrors the backend GET /api/cleanup/status payload and the
// cleanup_* fields on TrafficMetrics. Flat shape (count/total/failed)
// chosen for symmetry with PrePhaseStatus.
export interface CleanupStatus {
  count: number
  total: number
  failed_extensions: string[]
  unsubscribe_count?: number
  unsubscribe_skipped?: number
  unsubscribe_failed_extensions?: string[]
  unsubscribe_by_event?: Record<string, SubscriptionEventStats>
  unregister_count?: number
  unregister_failed_extensions?: string[]
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
  // answered: true when 200 OK was sent (UAS) or received (UAC) in
  // response to the INVITE — RFC 3261 §13.2.2.4 sense. Independent of
  // whether ACK followed.
  answered?: boolean
  // acknowledged: true when the full INV/200/ACK three-way handshake
  // completed. Orthogonal to result — a call can be acknowledged=true,
  // result=FAILED if media or BYE handshake failed afterwards.
  acknowledged?: boolean
  failure_reason?: string
  sip_local_ip?: string
  sip_local_port?: number
  pdd_ms: number
  hold_ms: number
  media_status: 'MEDIA_VERIFIED' | 'MEDIA_PARTIAL' | 'MEDIA_FAILED' | 'NO_MEDIA'
  rtp_tx_pkts?: number
  rtp_rx_pkts?: number
  rtp_rx_from_sbc_pkts?: number
  rtp_rx_other_pkts?: number
  rtp_asymmetry_flag?: string
  rtp_expected_pkts?: number
  rtp_ssrc_count?: number
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

export interface TransportConnectFailure {
  ext: string
  local_ip?: string
  remote?: string
  error?: string
}

export interface AggregateMetrics {
  total_attempted: number
  // total_answered: 200 OK count (semantic match to TrafficMetrics.calls_answered).
  total_answered?: number
  // total_acknowledged: full INV/200/ACK count.
  total_acknowledged?: number
  total_completed: number
  total_failed: number
  // aggregate_asr: Answer Seizure Ratio = total_answered / total_attempted * 100.
  aggregate_asr: number
  total_rtp_tx_pkts?: number
  total_rtp_rx_pkts?: number
  total_rtp_rx_from_sbc_pkts?: number
  total_rtp_expected_pkts?: number
  total_rtp_lost_pkts?: number
  total_rtp_ssrc_count?: number
  avg_rtp_tx_pkts?: number
  avg_rtp_rx_from_sbc_pkts?: number
  rtp_loss_pct?: number
  rtp_asymmetry_pct?: number
  rtp_asymmetry_flag?: 'OK' | 'WARNING' | 'CRITICAL'
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
