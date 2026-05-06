import type { RunPhase } from '@/types'

// Map a raw backend phase string (from /metrics, /api/test/status, or the
// WebSocket push) onto the GUI's RunPhase union.
//
// The backend now emits explicit REGSUB_READY / REGSUB_RUNNING / REGSUB_DONE
// for the operator-gated Reg/Sub lifecycle. Older clients still see the
// legacy aliases (PRE_REGISTER, PRE_PHASE, TRAFFIC_READY).
export function mapBackendPhase(rawPhase: string | undefined | null): RunPhase {
  const p = (rawPhase ?? '').toUpperCase()
  switch (p) {
    case 'FAILED':
      return 'FAILED'
    case 'TRAFFIC':
      return 'TRAFFIC'
    case 'STOPPING':
      return 'STOPPING'
    case 'CLEANUP_READY':
      return 'CLEANUP_READY'
    case 'CLEANING_UP':
      return 'CLEANING_UP'
    case 'REGSUB_READY':
      return 'REGSUB_READY'
    case 'REGSUB_RUNNING':
    case 'PRE_PHASE':
    case 'PRE_REGISTER':
    case 'PRE_SUBSCRIBE':
      return 'REGSUB_RUNNING'
    case 'REGSUB_DONE':
    case 'TRAFFIC_READY':
      return 'REGSUB_DONE'
    case 'DONE':
    case 'COMPLETE':
      return 'COMPLETE'
    default:
      return 'IDLE'
  }
}
