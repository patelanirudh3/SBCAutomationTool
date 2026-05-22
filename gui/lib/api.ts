import type { VMConfig, TrafficMetrics, RunPhase } from '@/types'

const BASE_URL =
  process.env.NEXT_PUBLIC_COORDINATOR_URL ?? 'http://localhost:8082'

export class APIError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
    this.name = 'APIError'
  }
}

// parseJsonResponse — robust JSON-or-text response handler used by every
// per-VM POST / PUT / DELETE caller below.
//
// Why: the previous pattern called `await res.json()` unconditionally and
// only checked `res.ok` afterwards. When a backend returns a non-JSON body
// (e.g. Go's net/http default `404 page not found\n` for a missing route)
// the JSON parser threw before we could read the actual HTTP status, so
// the operator saw a cryptic "Unexpected non-whitespace character at
// position 4" instead of "HTTP 404: 404 page not found".
//
// This helper:
//   1. Reads the body as text (always succeeds).
//   2. Tries to JSON.parse it; on failure, leaves data=null.
//   3. On non-2xx, throws APIError with `HTTP {status}: {body.error|body|statusText}`.
//   4. On 2xx, returns the parsed object (or {} when the body was empty).
async function parseJsonResponse<T>(res: Response): Promise<T> {
  const text = await res.text().catch(() => '')
  let data: unknown = null
  if (text) {
    try { data = JSON.parse(text) } catch { /* body is plain text */ }
  }
  if (!res.ok) {
    const errMsg =
      data && typeof data === 'object' && 'error' in data &&
      typeof (data as Record<string, unknown>).error === 'string'
        ? (data as { error: string }).error
        : (text || res.statusText || 'request failed')
    throw new APIError(res.status, `HTTP ${res.status}: ${errMsg}`)
  }
  return (data ?? {}) as T
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // Only set Content-Type when sending a body — GET requests must not send it
  // because that triggers a CORS preflight OPTIONS the backend doesn't handle
  const headers: Record<string, string> = options?.body != null
    ? { 'Content-Type': 'application/json' }
    : {}
  const res = await fetch(`${BASE_URL}${path}`, {
    headers,
    ...options,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText)
    throw new APIError(res.status, text)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

export interface StartTestPayload {
  config: VMConfig
}

export async function startTest(payload: StartTestPayload): Promise<void> {
  return request('/api/test/start', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function stopTest(): Promise<void> {
  return request('/api/test/stop', { method: 'POST' })
}

export interface TestStatus {
  phase: RunPhase
  running: boolean
  elapsed_seconds: number
}

export async function getTestStatus(): Promise<TestStatus> {
  return request<TestStatus>('/api/test/status')
}

// ---------------------------------------------------------------------------
// Config push
// ---------------------------------------------------------------------------

export async function putConfig(config: VMConfig): Promise<void> {
  return request('/api/config', {
    method: 'PUT',
    body: JSON.stringify(config),
  })
}

// ---------------------------------------------------------------------------
// Simple boolean ping — 3s timeout, used by "Start Monitoring" button
// ---------------------------------------------------------------------------

export async function pingVM(ip: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${ip}:${port}/api/ping`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch { return false }
}

// ---------------------------------------------------------------------------
// HTTP health check — hits the VM's FastAPI process at http://{vmIp}:{metricsPort}/api/ping
// ---------------------------------------------------------------------------

export async function checkHealth(
  vmIp: string,
  metricsPort: number
): Promise<{ reachable: boolean; error?: string }> {
  const url = `http://${vmIp}:${metricsPort}/api/ping`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
    return { reachable: res.ok }
  } catch (err) {
    return {
      reachable: false,
      error: err instanceof Error ? err.message : 'Connection refused',
    }
  }
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export async function getMetrics(): Promise<TrafficMetrics[]> {
  return request<TrafficMetrics[]>('/metrics')
}

// ---------------------------------------------------------------------------
// VMs
// ---------------------------------------------------------------------------

export interface VMSummary {
  vm_id: string
  role: 'UAC' | 'UAS'
  ext_range: string
  status: string
  cps: number
  concurrent: number
}

export async function getVMs(): Promise<VMSummary[]> {
  return request<VMSummary[]>('/api/vms')
}

// ---------------------------------------------------------------------------
// Per-VM status + metrics — bypass BASE_URL, go directly to ip:port
// No custom headers → no CORS preflight
// ---------------------------------------------------------------------------

export interface VMStatusResponse {
  phase: string
  running: boolean
  elapsed_seconds: number
  vm_id: string
}

export async function getStatusFor(
  ip: string,
  port: number
): Promise<VMStatusResponse> {
  const res = await fetch(`http://${ip}:${port}/api/test/status`)
  return parseJsonResponse<VMStatusResponse>(res)
}

export async function getMetricsFor(
  ip: string,
  port: number
): Promise<TrafficMetrics> {
  const res = await fetch(`http://${ip}:${port}/metrics`)
  return parseJsonResponse<TrafficMetrics>(res)
}

// ---------------------------------------------------------------------------
// Per-VM call events — GET /api/calls on a specific VM
// Returns [] on any error so callers never need try/catch
// ---------------------------------------------------------------------------

export async function getCallsFor(
  ip: string,
  port: number
): Promise<import('@/types').CallEvent[]> {
  try {
    const res = await fetch(`http://${ip}:${port}/api/calls`)
    if (!res.ok) return []
    return (await res.json()) as import('@/types').CallEvent[]
  } catch { return [] }
}

// ---------------------------------------------------------------------------
// Per-VM call spines — GET /api/call-spines on a specific VM (UAC)
// Returns [] on any error so callers never need try/catch
// ---------------------------------------------------------------------------

export async function getCallSpinesFor(
  ip: string,
  port: number,
  retries = 2,
  delayMs = 2000
): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`http://${ip}:${port}/api/call-spines`)
      if (!res.ok) return []
      const spines = (await res.json()) as Record<string, unknown>[]
      if (spines.length > 0) return spines
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, delayMs))
      }
    } catch {
      if (attempt >= retries) return []
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Build AggregateMetrics from fetched call events
//
// UAC is the source of truth for session-level totals because each call
// session produces TWO records in /api/calls (one per leg, kept for spine
// correlation). Counting both legs would double `total_attempted` etc. —
// e.g. a 15-call smoke test would report 30. The first arg is named
// `allEvents` (not `uacEvents`) to make this filtering explicit; the
// second is reserved for symmetry / future cross-VM correlation work.
// ---------------------------------------------------------------------------

export function buildAggregate(
  allEvents: import('@/types').CallEvent[],
  _uasEventsReserved: import('@/types').CallEvent[],
  runId: string,
  startedAt: string
): import('@/types').AggregateMetrics {
  // Accept records that are explicitly direction='uac' OR have no direction
  // field at all (older payloads). Anything tagged 'uas' is the callee leg
  // of a session UAC has already counted.
  const uacOnly = allEvents.filter((e) => e.direction !== 'uas')
  const attempted = uacOnly.length
  const answered = uacOnly.filter((e) => e.answered === true).length
  const hasAcknowledgedField = uacOnly.some((e) => typeof e.acknowledged === 'boolean')
  const completed = uacOnly.filter((e) => e.result === 'COMPLETED').length
  // Older/backed-out backend builds do not include the per-call
  // `acknowledged` flag. A completed call necessarily reached INV/200/ACK
  // before RTP and BYE/200, so completed is the safest lower-bound fallback.
  const acknowledged = hasAcknowledgedField
    ? uacOnly.filter((e) => e.acknowledged === true).length
    : completed
  const failed = uacOnly.filter((e) => e.result === 'FAILED').length
  const rtpEvents = allEvents.filter((e) =>
    (e.rtp_tx_pkts ?? 0) > 0 ||
    (e.rtp_rx_pkts ?? 0) > 0 ||
    (e.lost_packets ?? 0) > 0
  )
  const totalRtpTx = rtpEvents.reduce((sum, e) => sum + (e.rtp_tx_pkts ?? 0), 0)
  const totalRtpRx = rtpEvents.reduce((sum, e) => sum + (e.rtp_rx_pkts ?? 0), 0)
  const totalRtpRxFromSbc = rtpEvents.reduce((sum, e) => sum + (e.rtp_rx_from_sbc_pkts ?? 0), 0)
  const totalRtpExpected = rtpEvents.reduce((sum, e) => sum + (e.rtp_expected_pkts ?? 0), 0)
  const totalRtpLost = rtpEvents.reduce((sum, e) => sum + (e.lost_packets ?? 0), 0)
  const totalRtpSsrcCount = rtpEvents.reduce((sum, e) => sum + (e.rtp_ssrc_count ?? 0), 0)
  const avgRtpTx = rtpEvents.length > 0 ? Math.round((totalRtpTx / rtpEvents.length) * 100) / 100 : 0
  const avgRtpRxFromSbc = rtpEvents.length > 0 ? Math.round((totalRtpRxFromSbc / rtpEvents.length) * 100) / 100 : 0
  const rtpLossDenominator = totalRtpExpected > 0 ? totalRtpExpected : totalRtpRxFromSbc + totalRtpLost
  const rtpLossPct = rtpLossDenominator > 0
    ? Math.round((totalRtpLost / rtpLossDenominator) * 10000) / 100
    : 0
  const effectiveRx = totalRtpRxFromSbc > 0 ? totalRtpRxFromSbc : totalRtpRx
  const asymmetryBase = Math.max(totalRtpTx, effectiveRx)
  const rtpAsymmetryPct = asymmetryBase > 0
    ? Math.round((Math.abs(totalRtpTx - effectiveRx) / asymmetryBase) * 10000) / 100
    : 0
  const rtpAsymmetryFlag = rtpAsymmetryPct > 15 ? 'CRITICAL' : rtpAsymmetryPct > 5 ? 'WARNING' : 'OK'
  return {
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    total_attempted: attempted,
    total_answered: answered,
    total_acknowledged: acknowledged,
    total_completed: completed,
    total_failed: failed,
    aggregate_asr: attempted > 0 ? Math.round((answered / attempted) * 1000) / 10 : 0,
    total_rtp_tx_pkts: totalRtpTx,
    total_rtp_rx_pkts: totalRtpRx,
    total_rtp_rx_from_sbc_pkts: totalRtpRxFromSbc,
    total_rtp_expected_pkts: totalRtpExpected,
    total_rtp_lost_pkts: totalRtpLost,
    total_rtp_ssrc_count: totalRtpSsrcCount,
    avg_rtp_tx_pkts: avgRtpTx,
    avg_rtp_rx_from_sbc_pkts: avgRtpRxFromSbc,
    rtp_loss_pct: rtpLossPct,
    rtp_asymmetry_pct: rtpAsymmetryPct,
    rtp_asymmetry_flag: rtpAsymmetryFlag,
  }
}

// ---------------------------------------------------------------------------
// Per-VM config push — PUT /api/config on a specific VM backend
// ---------------------------------------------------------------------------

export async function putConfigFor(
  ip: string,
  port: number,
  config: Record<string, unknown>
): Promise<{ status: string; vm_id?: string; error?: string }> {
  const res = await fetch(`http://${ip}:${port}/api/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
    signal: AbortSignal.timeout(10_000),
  })
  return parseJsonResponse<{ status: string; vm_id?: string }>(res)
}

export interface CertificateUploadResult {
  path: string
  kind: string
  subject?: string
  issuer?: string
  not_before?: string
  not_after?: string
  fingerprint_sha256?: string
}

export async function uploadCertificateFor(
  ip: string,
  port: number,
  kind: 'ca' | 'client_cert' | 'client_key',
  file: File
): Promise<CertificateUploadResult> {
  const form = new FormData()
  form.append('type', kind)
  form.append('file', file)
  const res = await fetch(`http://${ip}:${port}/api/certificates/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(15_000),
  })
  return parseJsonResponse<CertificateUploadResult>(res)
}

export interface TLSVerifyResult {
  ok: boolean
  error?: string
  negotiated_version?: string
  cipher_suite?: string
  peer_subject?: string
  peer_issuer?: string
  peer_not_after?: string
  fingerprint_sha256?: string
}

export async function verifyTLSFor(
  ip: string,
  port: number,
  config: Record<string, unknown>
): Promise<TLSVerifyResult> {
  const res = await fetch(`http://${ip}:${port}/api/tls/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
    signal: AbortSignal.timeout(15_000),
  })
  return parseJsonResponse<TLSVerifyResult>(res)
}

// ---------------------------------------------------------------------------
// Per-VM traffic start — POST /api/test/start on a specific VM backend
// ---------------------------------------------------------------------------

export async function startTestFor(
  ip: string,
  port: number,
  runId: string,
  pairId: string
): Promise<{ status: string; vm_id?: string; error?: string }> {
  const res = await fetch(`http://${ip}:${port}/api/test/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ run_id: runId, pair_id: pairId }),
    signal: AbortSignal.timeout(10_000),
  })
  return parseJsonResponse<{ status: string; vm_id?: string }>(res)
}

// ---------------------------------------------------------------------------
// Per-VM stop — POST /api/test/stop on a specific VM backend
// ---------------------------------------------------------------------------

export async function stopTestFor(
  ip: string,
  port: number
): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}/api/test/stop`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  return parseJsonResponse<{ status: string }>(res)
}

// ---------------------------------------------------------------------------
// Phase-gated lifecycle endpoints (new unified-pool model)
// ---------------------------------------------------------------------------

// postNoBody — shared helper for the dozen phase-gate endpoints that all
// follow the same shape: POST a path, no body, expect a small JSON {status}
// response. Routes through parseJsonResponse so a stale-binary 404 (or any
// other non-JSON error body) surfaces as a readable HTTP-status message.
async function postNoBody(ip: string, port: number, path: string): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  return parseJsonResponse<{ status: string }>(res)
}

export function startPrePhaseFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/prephase/start')
}

// startPrepFor — fire-and-forget unregister flush. Returns 200 immediately.
// The actual completion is observed via the prep_status field on metrics.
export function startPrepFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/prep/start')
}

// startRegSubFor — gates the REGISTER + SUBSCRIBE phase. Backend returns 409
// if prep_status == 'running' (defensive guardrail; GUI also disables button).
export function startRegSubFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/regsub/start')
}

// abortRegSubFor — cancels in-flight Reg/Sub by setting stopNew so RegisterAll
// / SubscribeAll halt new batches and let in-flight work drain.
export function abortRegSubFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/regsub/abort')
}

// restartTrafficFor — re-enter the traffic loop from CLEANUP_READY without
// re-running prep / register / subscribe. Reuses the existing populated pool.
export function restartTrafficFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/restart-traffic')
}

export function startTrafficFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/traffic/start')
}

export function startCleanupFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/cleanup/start')
}

export function gracefulStopFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/shutdown/graceful')
}

export function interruptStopFor(ip: string, port: number): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/shutdown/interrupt')
}

// ---------------------------------------------------------------------------
// Per-VM reset — POST /api/test/reset on a specific VM backend
// ---------------------------------------------------------------------------

export async function resetTestFor(
  ip: string,
  port: number
): Promise<{ status: string; state?: string }> {
  const res = await fetch(`http://${ip}:${port}/api/test/reset`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  return parseJsonResponse<{ status: string; state?: string }>(res)
}

// ---------------------------------------------------------------------------
// Per-VM shutdown — POST /api/shutdown on a specific VM backend
// ---------------------------------------------------------------------------

export function shutdownFor(
  ip: string,
  port: number
): Promise<{ status: string }> {
  return postNoBody(ip, port, '/api/shutdown')
}

// ---------------------------------------------------------------------------
// URL builders — used by WS hooks and any per-VM REST calls
// ---------------------------------------------------------------------------

export function vmUrl(ip: string, port: number): string {
  return `http://${ip}:${port}`
}

export function vmWsUrl(ip: string, port: number): string {
  // Server mounts WS at /metrics/stream (no /api prefix) — see metrics.py line 319
  return `ws://${ip}:${port}/metrics/stream`
}

// ---------------------------------------------------------------------------
// Scenarios — GET /api/scenarios on a specific VM (typically UAC)
// ---------------------------------------------------------------------------

export async function getScenarios(
  ip: string,
  port: number
): Promise<import('@/types').Scenario[]> {
  try {
    const res = await fetch(`http://${ip}:${port}/api/scenarios`)
    if (!res.ok) return []
    return (await res.json()) as import('@/types').Scenario[]
  } catch { return [] }
}
