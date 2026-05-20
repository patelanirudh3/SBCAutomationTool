// Shared navigation-guard logic used by HomeGuardButton (top-left "Home"
// chevron) and StepIndicator (top-centre Config / Reg-Sub / Traffic /
// Report / Cleanup tabs). Both surfaces guard against operators leaving an
// in-flight phase and surface the same Emergency Cleanup & Reset escape
// hatch when the GUI's phase implies the operator might otherwise be
// locked out.

import type { RunPhase } from '@/types'

export interface GuardConfig {
  title: string
  message: string
  /** warn = amber (soft; override allowed), block = rose (hard; emergency
   *  reset is always offered when severity is 'block'). */
  severity: 'warn' | 'block'
  allowOverride?: boolean
  overrideLabel?: string
}

// getGuardConfig — returns null if navigation away from `phase` is safe,
// or a config describing how to warn/block the operator otherwise.
//
// The previous home-only version had no escape from REGSUB_DONE /
// TRAFFIC_READY — operators ended up locked. NavGuardDialog now ALWAYS
// renders the Emergency Cleanup & Reset button when severity === 'block',
// so this map only needs to describe what to show, not how to escape.
export function getGuardConfig(phase: RunPhase): GuardConfig | null {
  switch (phase) {
    case 'IDLE':
    case 'COMPLETE':
    case 'FAILED':
    case 'DONE':
      return null

    case 'TRAFFIC':
      return {
        title: 'Traffic Run In Progress',
        message:
          'A traffic run is currently active. Use Graceful Stop or Force Stop on the dashboard before navigating away.',
        severity: 'block',
      }

    case 'STOPPING':
      return {
        title: 'Stop In Progress',
        message:
          'The traffic run is stopping. Please wait for it to complete before leaving.',
        severity: 'block',
      }

    case 'PRE_PHASE':
    case 'PRE_REGISTER':
    case 'REGSUB_RUNNING':
      return {
        title: 'Registration In Progress',
        message:
          'SIP extensions are currently being registered and subscribed. Please wait for registration to finish before leaving.',
        severity: 'block',
      }

    case 'REGSUB_READY':
      return {
        title: 'Reg/Sub Not Yet Started',
        message:
          'You are on the Reg/Sub setup page but have not clicked Start Reg/Sub yet. Are you sure you want to leave?',
        severity: 'warn',
        allowOverride: true,
        overrideLabel: 'Leave anyway',
      }

    case 'REGSUB_DONE':
    case 'TRAFFIC_READY':
      return {
        title: 'Extensions Ready — Run Not Started',
        message:
          'Extensions are registered and idle. Start a traffic run, unregister, or use Emergency Cleanup & Reset before leaving.',
        severity: 'block',
      }

    case 'CLEANUP_READY':
      return {
        title: 'Extensions Still Registered',
        message:
          'SIP extensions are still registered on the SBC. Click "Unregister / Unsubscribe" on the report to clean up properly. You may also choose to leave them registered if you intend to run again shortly.',
        severity: 'warn',
        allowOverride: true,
        overrideLabel: 'Leave registered & go home',
      }

    case 'CLEANING_UP':
      return {
        title: 'Cleanup In Progress',
        message:
          'Unregister / Unsubscribe is currently running. Please wait for it to finish before leaving.',
        severity: 'block',
      }

    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Step navigation rules
// ---------------------------------------------------------------------------

export type StepIndex = 0 | 1 | 2 | 3 | 4

// Step → route mapping. Traffic, Report, and Cleanup share /run because the
// /run page switches views/cards based on phase.
export const STEP_ROUTES: Record<StepIndex, string> = {
  0: '/config',
  1: '/launch',
  2: '/run',
  3: '/run',
  4: '/run',
}

export const STEP_LABELS: Record<StepIndex, string> = {
  0: 'Config',
  1: 'Reg / Sub',
  2: 'Traffic',
  3: 'Report',
  4: 'Cleanup',
}

// reachableForwardStep — returns the highest step index reachable for
// the given phase. Used by StepIndicator to disable upcoming steps that
// the operator hasn't unlocked yet (e.g. Step 2 "Running" should not be
// clickable while still on Config because the engine hasn't started).
export function reachableForwardStep(phase: RunPhase): StepIndex {
  switch (phase) {
    case 'IDLE':
      return 0
    case 'PRE_PHASE':
    case 'PRE_REGISTER':
    case 'REGSUB_READY':
    case 'REGSUB_RUNNING':
    case 'REGSUB_DONE':
    case 'TRAFFIC_READY':
      return 1
    case 'TRAFFIC':
    case 'STOPPING':
      return 2
    case 'CLEANUP_READY':
    case 'CLEANING_UP':
    case 'COMPLETE':
    case 'DONE':
      return 4
    case 'FAILED':
      return 3
    default:
      return 0
  }
}

// activeStepForPhase returns the step currently active for visual rendering.
// It differs from reachableForwardStep for terminal states, where all steps
// are reachable but Cleanup should be shown as the active/completed endpoint.
export function activeStepForPhase(phase: RunPhase): StepIndex {
  switch (phase) {
    case 'IDLE':
      return 0
    case 'PRE_PHASE':
    case 'PRE_REGISTER':
    case 'REGSUB_READY':
    case 'REGSUB_RUNNING':
    case 'REGSUB_DONE':
    case 'TRAFFIC_READY':
      return 1
    case 'TRAFFIC':
    case 'STOPPING':
      return 2
    case 'CLEANUP_READY':
    case 'CLEANING_UP':
    case 'COMPLETE':
    case 'DONE':
      return 4
    case 'FAILED':
      return 3
    default:
      return 0
  }
}

// isStepNavigable — true when clicking step `target` from the current
// phase should be allowed (subject to guard dialogs for blocked-but-not-
// upcoming destinations). Upcoming steps return false and the
// StepIndicator renders them as `cursor-not-allowed`.
export function isStepNavigable(phase: RunPhase, target: StepIndex): boolean {
  return target <= reachableForwardStep(phase)
}
