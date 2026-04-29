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
  return res.json() as Promise<VMStatusResponse>
}

export async function getMetricsFor(
  ip: string,
  port: number
): Promise<TrafficMetrics> {
  const res = await fetch(`http://${ip}:${port}/metrics`)
  return res.json() as Promise<TrafficMetrics>
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
// UAC is source of truth for attempts (UAC drives all calls)
// ---------------------------------------------------------------------------

export function buildAggregate(
  uacEvents: import('@/types').CallEvent[],
  _uasEvents: import('@/types').CallEvent[],
  runId: string,
  startedAt: string
): import('@/types').AggregateMetrics {
  const attempted = uacEvents.length
  const answered = uacEvents.filter((e) => e.answered === true).length
  const completed = uacEvents.filter((e) => e.result === 'COMPLETED').length
  const failed = attempted - completed
  return {
    run_id: runId,
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    total_attempted: attempted,
    total_answered: answered,
    total_completed: completed,
    total_failed: failed,
    aggregate_asr: attempted > 0 ? Math.round((completed / attempted) * 1000) / 10 : 0,
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
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string; vm_id?: string }
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
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string; vm_id?: string }
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
  return res.json() as Promise<{ status: string }>
}

// ---------------------------------------------------------------------------
// Phase-gated lifecycle endpoints (new unified-pool model)
// ---------------------------------------------------------------------------

export async function startPrePhaseFor(ip: string, port: number): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}/api/prephase/start`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string }
}

export async function startTrafficFor(ip: string, port: number): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}/api/traffic/start`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string }
}

export async function startCleanupFor(ip: string, port: number): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}/api/cleanup/start`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string }
}

export async function gracefulStopFor(ip: string, port: number): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}/api/shutdown/graceful`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string }
}

export async function interruptStopFor(ip: string, port: number): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}/api/shutdown/interrupt`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string }
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
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string; state?: string }
}

// ---------------------------------------------------------------------------
// Per-VM shutdown — POST /api/shutdown on a specific VM backend
// ---------------------------------------------------------------------------

export async function shutdownFor(
  ip: string,
  port: number
): Promise<{ status: string }> {
  const res = await fetch(`http://${ip}:${port}/api/shutdown`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  })
  const data = await res.json()
  if (!res.ok) throw new APIError(res.status, data.error ?? res.statusText)
  return data as { status: string }
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
