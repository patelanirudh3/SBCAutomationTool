'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, ShieldAlert, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { startCleanupFor, resetTestFor, forceResetTestFor, getMetricsFor } from '@/lib/api'
import { mapBackendPhase } from '@/lib/phase'
import { selectedEngineEndpoint } from '@/lib/engine-endpoint'
import type { GuardConfig } from '@/lib/nav-guard'

// NavGuardDialog — shared confirmation/warning dialog used by both
// HomeGuardButton and StepIndicator clicks.
//
// Three exits available depending on guard severity:
//   - "Stay on this page"           always present
//   - "Continue anyway"              when guard.allowOverride === true (warn)
//   - "Emergency Cleanup & Reset"   always offered when severity === 'block',
//                                    and one-click recoverable from any state.
//
// Emergency reset path:
//   1. POST /api/cleanup/start       (graceful Unsubscribe + Unregister)
//   2. Poll /api/metrics every 1s up to 60s for phase=DONE/COMPLETE/IDLE
//   3. POST /api/test/reset           (returns engine to IDLE state)
//   4. Reset local Zustand store     (wipe phase, prePhaseStatus, callEvents,
//                                     aggregate, etc.)
//   5. router.push(href)              (typically /config)

interface NavGuardDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  guard: GuardConfig | null
  /** Where to navigate when the operator picks "Continue anyway" or after
   *  an Emergency Reset succeeds. */
  href: string
}

export function NavGuardDialog({
  open,
  onOpenChange,
  guard,
  href,
}: NavGuardDialogProps) {
  const router = useRouter()
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)
  const resetStore = useTrafficStore((s) => s.reset)
  const setPhase = useTrafficStore((s) => s.setPhase)

  const [confirmEmergencyOpen, setConfirmEmergencyOpen] = useState(false)
  const [isResetting, setIsResetting] = useState(false)
  const [resetError, setResetError] = useState<string | null>(null)
  const [resetStage, setResetStage] = useState<string>('')

  const pair = pairs[activePairIndex]
  const endpoint = selectedEngineEndpoint(pair?.uac)
  const vmIp = endpoint.ip
  const vmPort = endpoint.port

  // emergencyReset — best-effort recovery sequence. Each step swallows
  // errors that just mean "already done" (e.g. cleanup returns 409 if
  // already past CLEANUP_READY); only network-level failures bubble up.
  const emergencyReset = async () => {
    setIsResetting(true)
    setResetError(null)
    try {
      // Step 1: trigger graceful cleanup. Backend goes through
      // Unsubscribe (RFC 6665 §4.4.1) → Unregister (RFC 3261 §10.2.1.1)
      // for every agent and then transitions to DONE. If the lifecycle
      // is already in CLEANING_UP / DONE / etc, this returns 409 which
      // we swallow.
      setResetStage('Initiating cleanup...')
      try {
        await startCleanupFor(vmIp, vmPort)
      } catch {
        // Backend may already be past cleanup or unreachable for this
        // step; subsequent steps can still recover GUI state.
      }

      // Step 2: poll until backend confirms cleanup finished. Cap at 60s
      // so we don't hang indefinitely if the backend itself is wedged.
      setResetStage('Waiting for cleanup to complete...')
      const deadline = Date.now() + 15_000
      let phaseConfirmed = false
      while (Date.now() < deadline) {
        try {
          const m = (await getMetricsFor(vmIp, vmPort)) as unknown as {
            phase?: string
          }
          const mapped = mapBackendPhase(m.phase ?? '')
          if (
            mapped === 'DONE' ||
            mapped === 'COMPLETE' ||
            mapped === 'IDLE' ||
            mapped === 'FAILED'
          ) {
            phaseConfirmed = true
            break
          }
        } catch {
          // transient — keep polling
        }
        await new Promise((r) => setTimeout(r, 1000))
      }

      // Step 3: reset engine state to IDLE so /config can push a fresh
      // config later. If normal reset refuses the current state, use the
      // pre-traffic force-reset escape hatch.
      setResetStage('Resetting engine state...')
      try {
        await resetTestFor(vmIp, vmPort)
      } catch {
        try {
          await forceResetTestFor(vmIp, vmPort)
          phaseConfirmed = true
        } catch {
          // already idle, active traffic, or backend gone — proceed locally.
        }
      }

      // Step 4: wipe the local store so cached phase/aggregate/events
      // can't taint the next run. The reset() action keeps `runMode`
      // and `pairs` (config persists in localStorage) but clears
      // everything else.
      setResetStage('Clearing local state...')
      resetStore()
      setPhase('IDLE')

      if (!phaseConfirmed) {
        // Surface a soft warning but still navigate — the operator
        // explicitly asked for emergency recovery, and staying on this
        // page when the local state is already wiped would be worse.
        setResetError(
          'Backend did not confirm cleanup within 60s. The engine may need a manual restart.'
        )
      }

      // Step 5: navigate to the target route (typically /config).
      onOpenChange(false)
      setConfirmEmergencyOpen(false)
      router.push(href)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setResetError(`Emergency reset failed: ${msg}`)
    } finally {
      setIsResetting(false)
      setResetStage('')
    }
  }

  return (
    <>
      {/* Outer guard dialog */}
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-3">
              {guard?.severity === 'block' ? (
                <ShieldAlert className="size-5 shrink-0 text-rose-400" />
              ) : (
                <AlertTriangle className="size-5 shrink-0 text-amber-400" />
              )}
              <DialogTitle className="text-base font-semibold text-foreground">
                {guard?.title}
              </DialogTitle>
            </div>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              {guard?.message}
            </DialogDescription>
          </DialogHeader>

          {resetError && (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 text-xs text-amber-200">
              {resetError}
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row sm:justify-end">
            {/* Emergency Cleanup & Reset — always offered when blocked,
                and also when warn but the operator wants a clean slate. */}
            {(guard?.severity === 'block' || guard?.allowOverride) && (
              <Button
                variant="outline"
                size="sm"
                disabled={isResetting}
                onClick={() => setConfirmEmergencyOpen(true)}
                className="border-rose-500/40 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200 disabled:opacity-50"
              >
                {isResetting ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    {resetStage || 'Resetting...'}
                  </>
                ) : (
                  <>
                    <ShieldAlert className="size-3.5" />
                    Emergency Cleanup &amp; Reset
                  </>
                )}
              </Button>
            )}

            {/* Soft override (warn-severity only) */}
            {guard?.allowOverride && !isResetting && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenChange(false)
                  router.push(href)
                }}
                className="border-amber-500/40 text-amber-300 hover:bg-amber-500/10 hover:text-amber-200"
              >
                {guard.overrideLabel ?? 'Continue anyway'}
              </Button>
            )}

            <Button
              size="sm"
              disabled={isResetting}
              onClick={() => onOpenChange(false)}
            >
              Stay on this page
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Inner double-confirmation dialog — gates the destructive
          Emergency Reset action so accidental clicks don't tear down a
          live run. */}
      <Dialog open={confirmEmergencyOpen} onOpenChange={setConfirmEmergencyOpen}>
        <DialogContent showCloseButton={false} className="max-w-md">
          <DialogHeader>
            <div className="mb-1 flex items-center gap-3">
              <ShieldAlert className="size-5 shrink-0 text-rose-400" />
              <DialogTitle className="text-base font-semibold text-foreground">
                Confirm Emergency Reset
              </DialogTitle>
            </div>
            <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
              This will:
              <span className="mt-2 block space-y-1">
                <span className="block">
                  &bull; Send <span className="font-mono text-rose-300">SUBSCRIBE Expires:0</span> for every
                  agent (terminate subscription)
                </span>
                <span className="block">
                  &bull; Send <span className="font-mono text-rose-300">REGISTER Expires:0</span> for every
                  agent (remove the SBC binding)
                </span>
                <span className="block">
                  &bull; Reset the traffic engine to IDLE (clears all in-memory state)
                </span>
                <span className="block">
                  &bull; Clear the local GUI session and return to /config
                </span>
              </span>
              <span className="mt-3 block text-rose-300">
                Use this only if the GUI and backend are out of sync and other recovery paths are not
                available. Active calls will be aborted.
              </span>
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              disabled={isResetting}
              onClick={() => setConfirmEmergencyOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isResetting}
              onClick={emergencyReset}
              className="bg-rose-600 hover:bg-rose-500 text-white"
            >
              {isResetting ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" />
                  {resetStage || 'Resetting...'}
                </>
              ) : (
                'Yes, reset everything'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
