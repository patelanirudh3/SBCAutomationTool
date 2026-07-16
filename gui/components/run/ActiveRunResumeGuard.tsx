'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { getMetricsFor, getStatusFor } from '@/lib/api'
import { mapBackendPhase } from '@/lib/phase'
import { useTrafficStore } from '@/store/traffic'
import { selectedEngineEndpoint } from '@/lib/engine-endpoint'
import type { RunPhase } from '@/types'

const RESUME_PHASES = new Set<RunPhase>([
  'CONNECTING_TRANSPORTS',
  'REGSUB_READY',
  'REGSUB_RUNNING',
  'REGSUB_DONE',
  'TRAFFIC_READY',
  'TRAFFIC',
  'STOPPING',
  'CLEANUP_READY',
  'CLEANING_UP',
])

export function ActiveRunResumeGuard() {
  const router = useRouter()
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const store = useTrafficStore.getState()
    store.hydrateConfig()

    const check = async () => {
      const latest = useTrafficStore.getState()
      const pair = latest.pairs[latest.activePairIndex]
      const endpoint = selectedEngineEndpoint(pair?.uac)
      if (!latest.selectedEngine && endpoint.source !== 'pair' && endpoint.source !== 'default') {
        latest.setSelectedEngine(endpoint)
      }

      try {
        const status = await getStatusFor(endpoint.ip, endpoint.port)
        const phase = mapBackendPhase(status.phase)
        if (!RESUME_PHASES.has(phase)) return

        latest.setPhase(phase)
        const metrics = await getMetricsFor(endpoint.ip, endpoint.port).catch(() => null)
        if (metrics) {
          useTrafficStore.getState().updateUACMetrics(metrics)
        }
        router.replace('/run')
      } catch {
        // If the worker is not reachable, keep the normal page behavior.
      }
    }

    void check()
  }, [router])

  return null
}
