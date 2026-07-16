import type { VMConfig } from '@/types'

export type EngineEndpointSource = 'url' | 'runtime' | 'storage' | 'pair' | 'default'

export interface EngineEndpoint {
  ip: string
  port: number
  source: EngineEndpointSource
}

const SELECTED_ENGINE_KEY = 'cci-studio-selected-engine'
const DEFAULT_PORT = 8082

function parseEngineEndpoint(raw?: string | null, source: EngineEndpointSource = 'storage'): EngineEndpoint | null {
  const value = raw?.trim()
  if (!value) return null
  const withoutScheme = value.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  const [host, portRaw] = withoutScheme.split(':')
  if (!host) return null
  const port = portRaw ? Number(portRaw) : DEFAULT_PORT
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return null
  return { ip: host, port: Math.round(port), source }
}

export function parseEngineParam(raw?: string | null): EngineEndpoint | null {
  return parseEngineEndpoint(raw, 'url')
}

export function saveSelectedEngineEndpoint(endpoint: EngineEndpoint): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(SELECTED_ENGINE_KEY, JSON.stringify({ ip: endpoint.ip, port: endpoint.port, source: endpoint.source }))
  } catch { /* localStorage unavailable */ }
}

export function loadSelectedEngineEndpoint(): EngineEndpoint | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(SELECTED_ENGINE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<EngineEndpoint>
    if (!parsed.ip || !parsed.port) return null
    return { ip: parsed.ip, port: parsed.port, source: parsed.source ?? 'storage' }
  } catch {
    return null
  }
}

export function runtimeEngineEndpoint(): EngineEndpoint | null {
  return parseEngineEndpoint(
    process.env.NEXT_PUBLIC_ENGINE_URL ?? process.env.NEXT_PUBLIC_COORDINATOR_URL,
    'runtime',
  )
}

export function pairEngineEndpoint(pairConfig?: Pick<VMConfig, 'vm_ip' | 'metrics_port'> | null): EngineEndpoint | null {
  if (!pairConfig?.vm_ip || !pairConfig.metrics_port) return null
  return { ip: pairConfig.vm_ip, port: pairConfig.metrics_port, source: 'pair' }
}

export function selectedEngineEndpoint(pairConfig?: Pick<VMConfig, 'vm_ip' | 'metrics_port'> | null): EngineEndpoint {
  if (typeof window !== 'undefined') {
    const fromUrl = parseEngineParam(new URLSearchParams(window.location.search).get('engine'))
    if (fromUrl) return fromUrl
  }
  return (
    loadSelectedEngineEndpoint() ??
    runtimeEngineEndpoint() ??
    pairEngineEndpoint(pairConfig) ??
    { ip: '127.0.0.1', port: DEFAULT_PORT, source: 'default' }
  )
}

export function engineBaseUrl(endpoint: Pick<EngineEndpoint, 'ip' | 'port'>): string {
  return `http://${endpoint.ip}:${endpoint.port}`
}

export function engineWsUrl(endpoint: Pick<EngineEndpoint, 'ip' | 'port'>): string {
  return `ws://${endpoint.ip}:${endpoint.port}/metrics/stream`
}
