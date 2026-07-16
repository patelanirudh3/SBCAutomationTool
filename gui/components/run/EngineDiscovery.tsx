'use client'

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation'
import { parseEngineParam, runtimeEngineEndpoint, saveSelectedEngineEndpoint } from '@/lib/engine-endpoint'
import { useTrafficStore } from '@/store/traffic'

export function EngineDiscovery() {
  const searchParams = useSearchParams()
  const setSelectedEngine = useTrafficStore((s) => s.setSelectedEngine)

  useEffect(() => {
    const fromUrl = parseEngineParam(searchParams.get('engine'))
    if (fromUrl) {
      saveSelectedEngineEndpoint(fromUrl)
      setSelectedEngine(fromUrl)
      return
    }

    const current = useTrafficStore.getState().selectedEngine
    if (!current) {
      const runtime = runtimeEngineEndpoint()
      if (runtime) {
        saveSelectedEngineEndpoint(runtime)
        setSelectedEngine(runtime)
      }
    }
  }, [searchParams, setSelectedEngine])

  return null
}
