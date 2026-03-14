import type { TrafficMetrics } from '@/types'

const BASE_URL =
  process.env.NEXT_PUBLIC_COORDINATOR_URL ?? 'http://localhost:8082'

const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/api/metrics/stream'

const BACKOFF_STEPS_MS = [1000, 2000, 4000, 8000, 16000, 30000]

export type WSStatus = 'connected' | 'reconnecting' | 'disconnected'

export interface MetricsStreamHandlers {
  onMetrics: (metrics: TrafficMetrics[]) => void
  onStatusChange: (status: WSStatus) => void
  onError?: (err: Event) => void
}

export class MetricsStream {
  private ws: WebSocket | null = null
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(private handlers: MetricsStreamHandlers) {}

  connect(): void {
    if (this.closed) return
    this.ws = new WebSocket(WS_URL)

    this.ws.onopen = () => {
      this.reconnectAttempt = 0
      this.handlers.onStatusChange('connected')
    }

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as TrafficMetrics[]
        this.handlers.onMetrics(Array.isArray(data) ? data : [data])
      } catch {
        // silently ignore malformed frames
      }
    }

    this.ws.onerror = (err: Event) => {
      this.handlers.onError?.(err)
    }

    this.ws.onclose = () => {
      if (this.closed) return
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    const delayMs =
      BACKOFF_STEPS_MS[Math.min(this.reconnectAttempt, BACKOFF_STEPS_MS.length - 1)]
    this.reconnectAttempt++
    this.handlers.onStatusChange('reconnecting')

    this.reconnectTimer = setTimeout(() => {
      if (!this.closed) this.connect()
    }, delayMs)
  }

  disconnect(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
    this.handlers.onStatusChange('disconnected')
  }

  get status(): WSStatus {
    if (!this.ws) return 'disconnected'
    if (this.ws.readyState === WebSocket.OPEN) return 'connected'
    return 'reconnecting'
  }
}

// ---------------------------------------------------------------------------
// React hook — manages lifecycle tied to component mount/unmount
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react'

export function useMetricsStream(
  handlers: MetricsStreamHandlers,
  enabled = true
): void {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers

  useEffect(() => {
    if (!enabled) return

    const stream = new MetricsStream({
      onMetrics: (m) => handlersRef.current.onMetrics(m),
      onStatusChange: (s) => handlersRef.current.onStatusChange(s),
      onError: (e) => handlersRef.current.onError?.(e),
    })

    stream.connect()
    return () => stream.disconnect()
  }, [enabled])
}
