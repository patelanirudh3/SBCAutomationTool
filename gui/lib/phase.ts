import type { RunPhase } from '@/types'

// Map a raw backend phase string (from /metrics, /api/test/status, or the
// WebSocket push) onto the GUI's RunPhase union.
//
// The backend uses a slightly broader vocabulary (PRE_REGISTER,
// PRE_SUBSCRIBE, DONE) than the GUI cares about. Collapse those into the
// GUI phases that actually drive rendering:
//
//   PRE_REGISTER | PRE_SUBSCRIBE → PRE_PHASE
//   DONE                          → COMPLETE
//
// CLEANING_UP is passed through unchanged so the post-run UI can render
// the unregister progress card. Anything unrecognised falls back to IDLE.
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
    case 'TRAFFIC_READY':
      return 'TRAFFIC_READY'
    case 'PRE_PHASE':
    case 'PRE_REGISTER':
    case 'PRE_SUBSCRIBE':
      return 'PRE_PHASE'
    case 'DONE':
    case 'COMPLETE':
      return 'COMPLETE'
    default:
      return 'IDLE'
  }
}
