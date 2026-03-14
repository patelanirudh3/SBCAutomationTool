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
} from '@/types'

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
      register_rate: 10,
      register_timeout: 8,
      register_retry: 3,
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
      register_rate: 10,
      register_timeout: 8,
      register_retry: 3,
    },
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
  updateMetrics: (uac: TrafficMetrics, uas: TrafficMetrics) => void

  // WebSocket connection status
  wsStatus: 'connected' | 'reconnecting' | 'disconnected'
  setWsStatus: (s: 'connected' | 'reconnecting' | 'disconnected') => void

  // Post-run
  callEvents: CallEvent[]
  aggregate: AggregateMetrics | null
  setCallEvents: (events: CallEvent[]) => void
  setAggregate: (a: AggregateMetrics) => void

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
  wsStatus: 'disconnected' as const,
  callEvents: [] as CallEvent[],
  aggregate: null,
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

  setActivePair: (index) => set({ activePairIndex: index }),

  setReachability: (vm_id, status) =>
    set((state) => ({
      reachability: { ...state.reachability, [vm_id]: status },
    })),

  setPhase: (p) => set({ phase: p }),

  setUASPrePhase: (s) => set({ uasPrePhase: s }),
  setUACPrePhase: (s) => set({ uacPrePhase: s }),

  updateMetrics: (uac, uas) =>
    set((state) => ({
      uacMetrics: uac,
      uasMetrics: uas,
      metricsHistory: [
        ...state.metricsHistory.slice(-59),
        {
          t: Date.now(),
          asr: uac.asr,
          completed: uac.calls_completed,
          failed: uac.calls_failed,
        },
      ],
    })),

  setWsStatus: (s) => set({ wsStatus: s }),

  setCallEvents: (events) => set({ callEvents: events }),
  setAggregate: (a) => set({ aggregate: a }),

  reset: () => set({ ...initialState, pairs: [makePair(0)] }),
}))
