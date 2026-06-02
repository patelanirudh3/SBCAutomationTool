import { create } from 'zustand'
import type {
  VMPair,
  RunMode,
  RunPhase,
  PrePhaseStatus,
  CleanupStatus,
  TrafficMetrics,
  CallEvent,
  AggregateMetrics,
  ReachabilityStatus,
  AdvancedSettings,
} from '@/types'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'
import { mapBackendPhase } from '@/lib/phase'

// ---------------------------------------------------------------------------
// Persist full VM pair config across page reloads (localStorage)
// ---------------------------------------------------------------------------

const CONFIG_KEY = 'cci-studio-config'

function _loadConfig(): VMPair[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as VMPair[]) : null
  } catch { return null }
}

function _saveConfig(pairs: VMPair[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(CONFIG_KEY, JSON.stringify(pairs))
  } catch { /* localStorage unavailable */ }
}

interface MetricsHistoryPoint {
  t: number
  asr: number
  completed: number
  failed: number
}

function makeDefaultConfig(vmId: string, metricsPort: number) {
  return {
    vm_id: vmId,
    vm_ip: '127.0.0.1',
    local_ip_mode: 'single' as const,
    local_host: '',
    vip_interface: '',
    vip_cidr: '',
    vip_first_ip: '',
    vip_count: undefined,
    vip_gateway_ip: '',
    vip_sanity_target_ip: '',
    ext_start: 4001000,
    ext_end: 4001009,
    register_expires: 3600,
    subscribe_expires: 3600,
    subscribe_events: ['dialog'],
    subscribe_refresh_events: ['dialog'],
    subscribe_unsubscribe_events: ['dialog'],
    register_rate_cps: 10,
    cleanup_batch_size: 10,
    t1_ms: 500,
    timer_b_seconds: 32,
    sbc_host: '10.133.63.117',
    sbc_port: 5060,
    dual_registration_enabled: false,
    secondary_host: '',
    secondary_port: 5060,
    failover_enabled: false,
    failover_mode: 'graceful' as const,
    dns_servers: '',
    sip_transport: 'TCP' as const,
    sip_scheme: 'SIP' as const,
    domain: 'avaya.com',
    sip_password: '123456',
    tls_mode: 'insecure' as const,
    tls_ca_path: '',
    tls_cert_path: '',
    tls_key_path: '',
    tls_server_name: '',
    tls_min_version: '1.2' as const,
    tls_max_version: 'auto' as const,
    cps: 1,
    hold_time_seconds: 5,
    ramp_up_seconds: 30,
    media_enabled: true,
    media_security: 'rtp' as const,
    srtp_crypto_suites: ['AES_CM_128_HMAC_SHA1_80' as const],
    srtp_key_mode: 'auto' as const,
    rtp_codec: 'G711_ULAW' as const,
    rtp_ptime: 20,
    metrics_port: metricsPort,
    traffic_mode: 'smoke' as const,
    call_count: 10,
  }
}

function makePair(index: number): VMPair {
  const pairId = `pair-${index + 1}`
  return {
    pair_id: pairId,
    pair_label: `Pair ${index + 1}`,
    uac: makeDefaultConfig('traffic-local', 8082),
    advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS },
    validated: false,
    saved: false,
  }
}

interface TrafficStore {
  // Mode
  runMode: RunMode
  setRunMode: (m: RunMode) => void

  // VM Pairs
  pairs: VMPair[]
  activePairIndex: number
  addPair: () => void
  updatePair: (index: number, pair: VMPair) => void
  updateAdvancedSettings: (pairIndex: number, settings: AdvancedSettings) => void
  setActivePair: (index: number) => void

  // Reachability
  reachability: Record<string, ReachabilityStatus>
  setReachability: (vm_id: string, status: ReachabilityStatus) => void

  // Phase
  phase: RunPhase
  setPhase: (p: RunPhase) => void

  // Pre-phase (unified pool)
  prePhaseStatus: PrePhaseStatus | null
  setPrePhaseStatus: (s: PrePhaseStatus) => void

  // Cleanup (unregister) progress — populated while phase === CLEANING_UP
  // and frozen at completion so a refresh still shows the final result.
  cleanupStatus: CleanupStatus | null
  setCleanupStatus: (s: CleanupStatus | null) => void

  // Pool counts (from live metrics, 3-state granularity).
  // nonIdleCount is the legacy combined view (settingUp + established) kept
  // for backward compatibility; the GUI's "currently in call" tile reads
  // establishedCount instead.
  idleCount: number
  nonIdleCount: number
  settingUpCount: number
  establishedCount: number
  regOnlyCount: number

  // Live metrics
  uacMetrics: TrafficMetrics | null
  metricsHistory: MetricsHistoryPoint[]
  updateUACMetrics: (m: TrafficMetrics) => void

  // WebSocket connection status
  wsStatus: { uac: 'connected' | 'reconnecting' | 'disconnected' }
  setWsStatus: (role: 'uac', s: 'connected' | 'reconnecting' | 'disconnected') => void

  // Post-run
  callEvents: CallEvent[]
  callSpines: Record<string, unknown>[]
  aggregate: AggregateMetrics | null
  setCallEvents: (events: CallEvent[]) => void
  setCallSpines: (spines: Record<string, unknown>[]) => void
  setAggregate: (a: AggregateMetrics | null) => void

  // Run-level ID (one per traffic run, shared by all pairs)
  currentRunId: string
  setCurrentRunId: (id: string) => void

  // Chat panel
  chatPanelOpen: boolean
  setChatPanelOpen: (open: boolean) => void

  // Hydrate persisted config from localStorage (call after mount to avoid SSR mismatch)
  hydrateConfig: () => void

  // Reset
  reset: () => void
}

const initialState = {
  runMode: 'local' as RunMode,
  pairs: [makePair(0)],
  activePairIndex: 0,
  reachability: {} as Record<string, ReachabilityStatus>,
  phase: 'IDLE' as RunPhase,
  prePhaseStatus: null,
  cleanupStatus: null as CleanupStatus | null,
  idleCount: 0,
  nonIdleCount: 0,
  settingUpCount: 0,
  establishedCount: 0,
  regOnlyCount: 0,
  uacMetrics: null,
  metricsHistory: [] as MetricsHistoryPoint[],
  wsStatus: { uac: 'disconnected' } as { uac: 'connected' | 'reconnecting' | 'disconnected' },
  callEvents: [] as CallEvent[],
  callSpines: [] as Record<string, unknown>[],
  aggregate: null,
  currentRunId: '',
  chatPanelOpen: false,
}

export const useTrafficStore = create<TrafficStore>((set, get) => ({
  ...initialState,

  setRunMode: (m) => set({ runMode: m }),

  addPair: () =>
    set((state) => ({
      pairs: [...state.pairs, makePair(state.pairs.length)],
    })),

  updatePair: (index, pair) =>
    set((state) => {
      const pairs = [...state.pairs]
      pairs[index] = pair
      _saveConfig(pairs)
      return { pairs }
    }),

  updateAdvancedSettings: (pairIndex, settings) =>
    set((state) => {
      const pairs = [...state.pairs]
      if (pairs[pairIndex]) {
        pairs[pairIndex] = { ...pairs[pairIndex], advancedSettings: settings }
      }
      return { pairs }
    }),

  setActivePair: (index) => set({ activePairIndex: index }),

  setReachability: (vm_id, status) =>
    set((state) => ({
      reachability: { ...state.reachability, [vm_id]: status },
    })),

  setPhase: (p) => set({ phase: p }),

  setPrePhaseStatus: (s) => set({ prePhaseStatus: s }),

  setCleanupStatus: (s) => set({ cleanupStatus: s }),

  updateUACMetrics: (m) =>
    set((state) => {
      // Always map raw backend phase through the normaliser so callers
      // can't accidentally store a backend-only string (e.g. 'DONE') that
      // the GUI's RunPhase-driven gates ignore.
      const mappedPhase = m.phase ? mapBackendPhase(m.phase) : state.phase

      // Mirror cleanup_count/total/failed onto the dedicated CleanupStatus
      // slice so progress card / poller / final report all share one
      // source of truth. Detect "complete" off the count here so the GUI
      // is responsive even before the backend trips its own complete flag.
      let cleanupStatus = state.cleanupStatus
      const total = m.cleanup_total ?? 0
      const count = m.cleanup_unregister_count ?? m.cleanup_count ?? 0
      const unregisterFailed = m.cleanup_unregister_failed ?? m.cleanup_failed ?? cleanupStatus?.unregister_failed_extensions ?? cleanupStatus?.failed_extensions ?? []
      const unsubscribeFailed = m.cleanup_unsubscribe_failed ?? cleanupStatus?.unsubscribe_failed_extensions ?? []
      const unsubscribeByEvent = m.cleanup_unsubscribe_by_event ?? cleanupStatus?.unsubscribe_by_event
      const eventUnsubscribeCount = unsubscribeByEvent
        ? Object.values(unsubscribeByEvent).reduce((sum, stats) => sum + (stats.total ?? 0), 0)
        : undefined
      const unsubscribeCount = eventUnsubscribeCount ?? m.cleanup_unsubscribe_count ?? cleanupStatus?.unsubscribe_count ?? 0
      const unsubscribeSkipped = m.cleanup_unsubscribe_skipped ?? cleanupStatus?.unsubscribe_skipped ?? 0
      if (
        total > 0 ||
        count > 0 ||
        unsubscribeCount > 0 ||
        unsubscribeSkipped > 0 ||
        unregisterFailed.length > 0 ||
        unsubscribeFailed.length > 0
      ) {
        cleanupStatus = {
          count,
          total: Math.max(total, cleanupStatus?.total ?? 0),
          failed_extensions: unregisterFailed,
          unsubscribe_count: unsubscribeCount,
          unsubscribe_skipped: unsubscribeSkipped,
          unsubscribe_failed_extensions: unsubscribeFailed,
          unsubscribe_by_event: unsubscribeByEvent,
          unregister_count: count,
          unregister_failed_extensions: unregisterFailed,
          in_progress: mappedPhase === 'CLEANING_UP',
          complete: total > 0 && count >= total,
          elapsed_seconds: cleanupStatus?.elapsed_seconds,
        }
      }

      return {
        uacMetrics: m,
        phase: mappedPhase,
        idleCount: m.idle_count ?? state.idleCount,
        nonIdleCount: m.non_idle_count ?? state.nonIdleCount,
        settingUpCount: m.setting_up_count ?? 0,
        // Backed-out backend builds do not emit established_count. In that
        // schema, concurrent_calls already represents established in-call
        // sessions, so use it as the compatibility source for the tile.
        establishedCount: m.established_count ?? m.concurrent_calls ?? state.establishedCount,
        regOnlyCount: m.reg_only_count ?? state.regOnlyCount,
        cleanupStatus,
        metricsHistory: [
          ...state.metricsHistory.slice(-59),
          {
            t: Date.now(),
            asr: m.asr,
            completed: m.calls_completed,
            failed: m.calls_failed,
          },
        ],
      }
    }),

  setWsStatus: (role, s) =>
    set((state) => ({
      wsStatus: { ...state.wsStatus, [role]: s },
    })),

  setCallEvents: (events) => set({ callEvents: events }),
  setCallSpines: (spines) => set({ callSpines: spines }),
  setAggregate: (a) => set({ aggregate: a }),

  setCurrentRunId: (id) => set({ currentRunId: id }),

  setChatPanelOpen: (open) => set({ chatPanelOpen: open }),

  hydrateConfig: () => {
    const saved = _loadConfig()
    if (!saved?.length) return
    // Merge saved pairs with defaults to handle any new fields added since last save
    const merged = saved.map((sp) => ({
      ...makePair(0),
      ...sp,
      uac: { ...makeDefaultConfig(sp.uac?.vm_id ?? 'traffic-local', sp.uac?.metrics_port ?? 8082), ...sp.uac },
      advancedSettings: { ...DEFAULT_ADVANCED_SETTINGS, ...(sp.advancedSettings ?? {}) },
    }))
    set({ pairs: merged })
  },

  reset: () => {
    const { runMode, pairs } = get()
    set({ ...initialState, runMode, pairs })
  },
}))
