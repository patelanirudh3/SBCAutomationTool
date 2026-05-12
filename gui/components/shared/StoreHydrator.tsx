'use client'

import { useEffect } from 'react'
import { useTrafficStore } from '@/store/traffic'

// StoreHydrator — runs once on first client mount and rehydrates the
// Zustand store from localStorage. Mounted at the layout root so EVERY
// route benefits, not just /config.
//
// Why this exists: hydrateConfig() reads the saved pair config (extension
// range, SBC host, advanced settings, TCP keepalive, etc.) from
// localStorage. Without hydration, the store falls back to makePair(0)'s
// defaults — ext_start: 4001000, ext_end: 4001009 → extCount = 10. After
// a browser refresh on /launch or /run the operator sees a completely
// wrong extension count, and "Start Reg/Sub" / "Start Traffic" actions
// would push the wrong config to the backend.
//
// hydrateConfig() is idempotent — calling it from VMPairBook (its
// historical home) AND here is safe; the StrReplace just merges
// localStorage into the in-memory store.
export function StoreHydrator({ children }: { children: React.ReactNode }) {
  const hydrateConfig = useTrafficStore((s) => s.hydrateConfig)

  useEffect(() => {
    hydrateConfig()
  }, [hydrateConfig])

  return <>{children}</>
}
