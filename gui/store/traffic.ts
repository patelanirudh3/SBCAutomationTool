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

interface MetricsHistoryPoint {
  t: number
  asr: number
  completed: number
  failed: number
}

function makePair(index: number): VMPair {
  const pairId = `pair-${index + 1}`
  return {
    pair_id: pairId,
    pair_label: `Pair ${index + 1}`,
    uac: {
      vm_role: 'UAC',
      vm_id: 'uac-local',
      vm_ip: '127.0.0.1',
      uac_ext_start: 4001000,
      uac_ext_end: 4001004,
      uas_ext_start: 4001005,
      uas_ext_end: 4001009,
      sbc_host: '10.133.63.117',
      sbc_port: 5060,
      sip_transport: 'TCP',
      domain: 'avaya.com',
      sip_password: '123456',
      cps: 1,
      hold_time_seconds: 5,
      metrics_port: 8082,
      peer_stop_url: 'http://127.0.0.1:8081/api/test/stop',
      traffic_mode: 'smoke',
      call_count: 10,
    },
    uas: {
      vm_role: 'UAS',
      vm_id: 'uas-local',
      vm_ip: '127.0.0.1',
      uac_ext_start: 4001000,
      uac_ext_end: 4001004,
      uas_ext_start: 4001005,
      uas_ext_end: 4001009,
      sbc_host: '10.133.63.117',
      sbc_port: 5060,
      sip_transport: 'TCP',
      domain: 'avaya.com',
      sip_password: '123456',
      cps: 1,
      hold_time_seconds: 5,
      metrics_port: 8081,
    },
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

  // Pre-phase
  uasPrePhase: PrePhaseStatus | null
  uacPrePhase: PrePhaseStatus | null
  setUASPrePhase: (s: PrePhaseStatus) => void
  setUACPrePhase: (s: PrePhaseStatus) => void

  // Live metrics
  uacMetrics: TrafficMetrics | null
  uasMetrics: TrafficMetrics | null
  metricsHistory: MetricsHistoryPoint[]
  updateUACMetrics: (m: TrafficMetrics) => void
  updateUASMetrics: (m: TrafficMetrics) => void

  // WebSocket connection status — one entry per VM role
  wsStatus: { uac: 'connected' | 'reconnecting' | 'disconnected'; uas: 'connected' | 'reconnecting' | 'disconnected' }
  setWsStatus: (role: 'uac' | 'uas', s: 'connected' | 'reconnecting' | 'disconnected') => void

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

  // Reset
  reset: () => void
}

const initialState = {
  runMode: 'local' as RunMode,
  pairs: [makePair(0)],
  activePairIndex: 0,
  reachability: {} as Record<string, ReachabilityStatus>,
  phase: 'IDLE' as RunPhase,
  uasPrePhase: null,
  uacPrePhase: null,
  uacMetrics: null,
  uasMetrics: null,
  metricsHistory: [] as MetricsHistoryPoint[],
  wsStatus: { uac: 'disconnected', uas: 'disconnected' } as { uac: 'connected' | 'reconnecting' | 'disconnected'; uas: 'connected' | 'reconnecting' | 'disconnected' },
  callEvents: [] as CallEvent[],
  callSpines: [] as Record<string, unknown>[],
  aggregate: null,
  currentRunId: '',
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

  setUASPrePhase: (s) => set({ uasPrePhase: s }),
  setUACPrePhase: (s) => set({ uacPrePhase: s }),

  updateUACMetrics: (m) =>
    set((state) => ({
      uacMetrics: m,
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

  updateUASMetrics: (m) => set({ uasMetrics: m }),

  setWsStatus: (role, s) =>
    set((state) => ({
      wsStatus: { ...state.wsStatus, [role]: s },
    })),

  setCallEvents: (events) => set({ callEvents: events }),
  setCallSpines: (spines) => set({ callSpines: spines }),
  setAggregate: (a) => set({ aggregate: a }),

  setCurrentRunId: (id) => set({ currentRunId: id }),

  reset: () => {
    const { runMode, pairs } = get()
    set({ ...initialState, runMode, pairs })
  },
}))
