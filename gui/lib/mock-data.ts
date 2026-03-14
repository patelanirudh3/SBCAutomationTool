import type {
  VMConfig,
  TrafficMetrics,
  PrePhaseStatus,
  CallEvent,
  AggregateMetrics,
} from '@/types'

// ---------------------------------------------------------------------------
// Mock configs
// ---------------------------------------------------------------------------

export const MOCK_UAC_CONFIG: VMConfig = {
  vm_role: 'UAC',
  vm_id: 'uac-local',
  vm_ip: '127.0.0.1',
  uac_ext_start: 4001000,
  uac_ext_end: 4001009,
  uas_ext_start: 4002000,
  uas_ext_end: 4002009,
  sbc_host: '10.133.63.117',
  sbc_port: 5060,
  sip_transport: 'TCP',
  domain: 'avaya.com',
  sip_password: '123456',
  cps: 2,
  hold_time_seconds: 10,
  metrics_port: 8082,
  peer_stop_url: 'http://127.0.0.1:8081/api/test/stop',
  traffic_mode: 'smoke',
  call_count: 20,
  register_rate: 10,
  register_timeout: 8,
  register_retry: 3,
}

export const MOCK_UAS_CONFIG: VMConfig = {
  vm_role: 'UAS',
  vm_id: 'uas-local',
  vm_ip: '127.0.0.1',
  uac_ext_start: 4001000,
  uac_ext_end: 4001009,
  uas_ext_start: 4002000,
  uas_ext_end: 4002009,
  sbc_host: '10.133.63.117',
  sbc_port: 5060,
  sip_transport: 'TCP',
  domain: 'avaya.com',
  sip_password: '123456',
  cps: 2,
  hold_time_seconds: 10,
  metrics_port: 8081,
  register_rate: 10,
  register_timeout: 8,
  register_retry: 3,
}

// ---------------------------------------------------------------------------
// Mock pre-phase status
// ---------------------------------------------------------------------------

export const MOCK_UAS_PRE_PHASE: PrePhaseStatus = {
  vm_id: 'uas-local',
  role: 'UAS',
  register_complete: true,
  register_count: 10,
  register_total: 10,
  subscribe_complete: true,
  subscribe_count: 10,
  subscribe_total: 10,
  extensions_ready: true,
  auto_answer_started: true,
  auto_answer_active: true,
}

export const MOCK_UAC_PRE_PHASE: PrePhaseStatus = {
  vm_id: 'uac-local',
  role: 'UAC',
  register_complete: true,
  register_count: 10,
  register_total: 10,
  subscribe_complete: true,
  subscribe_count: 10,
  subscribe_total: 10,
  extensions_ready: true,
  auto_answer_started: false,
  auto_answer_active: false,
}

// ---------------------------------------------------------------------------
// Mock live metrics
// ---------------------------------------------------------------------------

export const MOCK_UAC_METRICS: TrafficMetrics = {
  vm_id: 'uac-local',
  phase: 'TRAFFIC',
  running: true,
  cps_actual: 1.98,
  concurrent_calls: 8,
  calls_attempted: 20,
  calls_completed: 18,
  calls_failed: 2,
  asr: 90.0,
  avg_pdd_ms: 143,
  min_pdd_ms: 98,
  max_pdd_ms: 212,
  avg_hold_ms: 10020,
  socket_count: 10,
  registered_count: 10,
  run_elapsed_seconds: 45,
}

export const MOCK_UAS_METRICS: TrafficMetrics = {
  vm_id: 'uas-local',
  phase: 'TRAFFIC',
  running: true,
  cps_actual: 1.97,
  concurrent_calls: 8,
  calls_attempted: 18,
  calls_completed: 18,
  calls_failed: 0,
  asr: 100.0,
  avg_pdd_ms: 141,
  min_pdd_ms: 96,
  max_pdd_ms: 210,
  avg_hold_ms: 10015,
  socket_count: 10,
  registered_count: 10,
  run_elapsed_seconds: 45,
}

// ---------------------------------------------------------------------------
// Mock aggregate
// ---------------------------------------------------------------------------

export const MOCK_AGGREGATE: AggregateMetrics = {
  total_attempted: 20,
  total_completed: 18,
  total_failed: 2,
  aggregate_asr: 90.0,
  run_id: 'run-20260314-122347',
  started_at: '2026-03-14T12:23:47Z',
  ended_at: '2026-03-14T12:24:32Z',
}

// ---------------------------------------------------------------------------
// Mock call events — 20 rows, mixed results
// ---------------------------------------------------------------------------

function makeCall(
  idx: number,
  result: 'COMPLETED' | 'FAILED',
  mediaStatus: CallEvent['media_status'],
  failureReason?: string
): CallEvent {
  const uacExt = `400100${idx}`
  const uasExt = `400200${idx}`
  const ts = new Date(Date.parse('2026-03-14T12:23:47Z') + idx * 5000).toISOString()
  return {
    call_id: `call-${String(idx).padStart(3, '0')}`,
    uac_ext: uacExt,
    uas_ext: uasExt,
    result,
    failure_reason: failureReason,
    pdd_ms: 120 + Math.floor(Math.abs(Math.sin(idx) * 100)),
    hold_ms: result === 'COMPLETED' ? 10000 + idx * 50 : 0,
    media_status: mediaStatus,
    rtp_tx_pkts: result === 'COMPLETED' ? 500 + idx * 10 : undefined,
    rtp_rx_pkts: result === 'COMPLETED' ? 498 + idx * 10 : undefined,
    timestamp: ts,
  }
}

export const MOCK_CALL_EVENTS: CallEvent[] = [
  makeCall(0, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(1, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(2, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(3, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(4, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(5, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(6, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(7, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(8, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(9, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(10, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(11, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(12, 'COMPLETED', 'MEDIA_PARTIAL'),
  makeCall(13, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(14, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(15, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(16, 'FAILED', 'MEDIA_FAILED', '404 Not Found'),
  makeCall(17, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(18, 'COMPLETED', 'MEDIA_VERIFIED'),
  makeCall(19, 'FAILED', 'NO_MEDIA', '408 Request Timeout'),
]

// ---------------------------------------------------------------------------
// Mock metrics history — 30 data points for initial chart
// ---------------------------------------------------------------------------

export const MOCK_METRICS_HISTORY = Array.from({ length: 30 }, (_, i) => ({
  t: Date.now() - (30 - i) * 2000,
  asr: 85 + Math.min(i * 0.5, 10) + Math.sin(i) * 2,
  completed: i * 2,
}))

// ---------------------------------------------------------------------------
// Mock simulation helpers
// ---------------------------------------------------------------------------

/** Simulate pre-phase progression with 500ms delay per step */
export async function simulatePrePhase(
  onStep: (role: 'UAS' | 'UAC', field: keyof PrePhaseStatus, count?: number) => void
): Promise<void> {
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

  // UAS steps
  await delay(500)
  onStep('UAS', 'register_complete', 10)
  await delay(500)
  onStep('UAS', 'subscribe_complete', 10)
  await delay(500)
  onStep('UAS', 'extensions_ready')
  await delay(500)
  onStep('UAS', 'auto_answer_started', 10)
  await delay(500)
  onStep('UAS', 'auto_answer_active', 10)

  // UAC steps
  await delay(3500) // simulate the 3s countdown before UAC starts
  onStep('UAC', 'register_complete', 10)
  await delay(500)
  onStep('UAC', 'subscribe_complete', 10)
  await delay(500)
  onStep('UAC', 'extensions_ready')
}

/** Generate an updated metrics snapshot for live simulation */
export function simulateMetricsTick(
  prev: TrafficMetrics,
  attempted: number,
  completed: number,
  failed: number
): TrafficMetrics {
  return {
    ...prev,
    calls_attempted: attempted,
    calls_completed: completed,
    calls_failed: failed,
    asr: attempted > 0 ? Math.round((completed / attempted) * 1000) / 10 : 0,
    cps_actual: Math.round((prev.cps_actual + (Math.random() * 0.2 - 0.1)) * 100) / 100,
    concurrent_calls: Math.min(Math.floor(Math.random() * 3) + 7, 10),
    run_elapsed_seconds: prev.run_elapsed_seconds + 2,
  }
}
