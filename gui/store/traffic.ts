import { create } from 'zustand'
import type {
  VMPair,
  RunMode,
  RunPhase,
  PrePhaseStatus,
  TrafficMetrics,
  CallEvent,
  AggregateMetrics,
  ReachabilityStatus,
  AdvancedSettings,
} from '@/types'
import { DEFAULT_ADVANCED_SETTINGS } from '@/types'

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
    ext_start: 4001000,
    ext_end: 4001009,
    register_expires: 3600,
    subscribe_expires: 3600,
    register_rate_cps: 10,
    sbc_host: '10.133.63.117',
    sbc_port: 5060,
    secondary_host: '',
    secondary_port: 5060,
    failover_enabled: false,
    dns_servers: '',
    sip_transport: 'TCP' as const,
    sip_scheme: 'SIP' as const,
    domain: 'avaya.com',
    sip_password: '123456',
    cps: 1,
    hold_time_seconds: 5,
    media_enabled: true,
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

  // Pool counts (from live metrics)
  idleCount: number
  nonIdleCount: number
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
  setAggregate: (a: AggregateMetrics) => void

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
  idleCount: 0,
  nonIdleCount: 0,
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

  updateUACMetrics: (m) =>
    set((state) => ({
      uacMetrics: m,
      phase: m.phase ?? state.phase,
      idleCount: m.idle_count ?? state.idleCount,
      nonIdleCount: m.non_idle_count ?? state.nonIdleCount,
      regOnlyCount: m.reg_only_count ?? state.regOnlyCount,
      metricsHistory: [
        ...state.metricsHistory.slice(-59),
        {
          t: Date.now(),
          asr: m.asr,
          completed: m.calls_completed,
          failed: m.calls_failed,
        },
      ],
    })),

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
