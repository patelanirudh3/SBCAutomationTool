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
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
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
  return request<TrafficMetrics[]>('/api/metrics')
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
