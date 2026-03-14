'use client'

import { useEffect, useCallback, useState, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { motion, AnimatePresence } from 'framer-motion'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChecklistItem, type ChecklistState } from './ChecklistItem'
import { LaunchCountdown } from './LaunchCountdown'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'
import type { PrePhaseStatus, VMRole } from '@/types'

// ---------------------------------------------------------------------------
// Per-side checklist model
// ---------------------------------------------------------------------------

interface CheckItem {
  key: string
  label: string
  state: ChecklistState
  failLog?: string
}

function makeUASItems(n: number): CheckItem[] {
  return [
    { key: 'register', label: `REGISTER complete: 0/${n} OK, 0 failed`, state: 'pending' },
    { key: 'subscribe', label: `SUBSCRIBE complete: 0/${n} OK, 0 failed`, state: 'pending' },
    { key: 'extensions', label: `ALL EXTENSIONS READY — 0 registered, 0 subscribed`, state: 'pending' },
    { key: 'auto_start', label: `UAS auto-answer started for ${n} extensions`, state: 'pending' },
    { key: 'auto_active', label: `UAS auto-answer mode active on ${n} extensions`, state: 'pending' },
  ]
}

function makeUACItems(n: number): CheckItem[] {
  return [
    { key: 'register', label: `REGISTER complete: 0/${n} OK, 0 failed`, state: 'pending' },
    { key: 'subscribe', label: `SUBSCRIBE complete: 0/${n} OK, 0 failed`, state: 'pending' },
    { key: 'extensions', label: `ALL EXTENSIONS READY — 0 registered, 0 subscribed`, state: 'pending' },
  ]
}

// ---------------------------------------------------------------------------
// Side panel (UAS or UAC)
// ---------------------------------------------------------------------------

function SidePanel({
  role,
  vmId,
  items,
  active,
  onRetry,
  hasFailed,
}: {
  role: VMRole
  vmId: string
  items: CheckItem[]
  active: boolean
  onRetry?: () => void
  hasFailed: boolean
}) {
  const isUAS = role === 'UAS'

  return (
    <motion.div
      animate={{ opacity: active ? 1 : 0.35 }}
      transition={{ duration: 0.5 }}
      className="flex flex-1 flex-col"
    >
      {/* Side header */}
      <div className="flex items-center justify-between border-b border-border bg-card/80 px-5 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] font-bold tracking-widest',
              isUAS ? 'bg-violet-500/15 text-violet-400' : 'bg-blue-500/15 text-blue-400'
            )}
          >
            {role}
          </span>
          <span className="font-mono text-sm text-foreground">{vmId}</span>
        </div>
        {hasFailed && onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5 text-xs">
            <RotateCcw className="size-3" />
            Retry
          </Button>
        )}
      </div>

      {/* Checklist */}
      <div className="flex-1 space-y-3 px-5 py-5">
        {items.map((item) => (
          <ChecklistItem
            key={item.key}
            label={item.label}
            state={item.state}
            failLog={item.failLog}
          />
        ))}
      </div>
    </motion.div>
  )
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export function PrePhasePanel() {
  const router = useRouter()
  const { pairs, activePairIndex, setPhase, setUASPrePhase, setUACPrePhase } = useTrafficStore()
  const pair = pairs[activePairIndex]
  const extCount = pair ? pair.uas.uas_ext_end - pair.uas.uas_ext_start + 1 : 10

  const [uasItems, setUasItems] = useState<CheckItem[]>(() => makeUASItems(extCount))
  const [uacItems, setUacItems] = useState<CheckItem[]>(() => makeUACItems(extCount))
  const [uasActive, setUasActive] = useState(true)
  const [uacActive, setUacActive] = useState(false)
  const [showCountdown, setShowCountdown] = useState(false)
  const [uasComplete, setUasComplete] = useState(false)
  const [uacComplete, setUacComplete] = useState(false)
  const isMock = process.env.NEXT_PUBLIC_MOCK_MODE === 'true'
  const hasStartedRef = useRef(false)

  // Advance a specific item to a new state with dynamic label
  const advanceItem = useCallback(
    (
      setter: React.Dispatch<React.SetStateAction<CheckItem[]>>,
      key: string,
      state: ChecklistState,
      label?: string,
      failLog?: string
    ) => {
      setter((prev) =>
        prev.map((it) =>
          it.key === key ? { ...it, state, label: label ?? it.label, failLog } : it
        )
      )
    },
    []
  )

  // Set an item to 'checking' before resolving — spinner is visible long enough to read
  const transitionItem = useCallback(
    async (
      setter: React.Dispatch<React.SetStateAction<CheckItem[]>>,
      key: string,
      finalState: ChecklistState,
      label: string
    ) => {
      advanceItem(setter, key, 'checking')
      await new Promise((r) => setTimeout(r, 800))
      advanceItem(setter, key, finalState, label)
    },
    [advanceItem]
  )

  // ---------------------------------------------------------------------------
  // MOCK_MODE simulation
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!isMock || hasStartedRef.current) return
    hasStartedRef.current = true

    setPhase('PRE_PHASE')

    const run = async () => {
      const n = extCount

      // UAS steps — 1s between each so the audience can read each line
      await transitionItem(setUasItems, 'register', 'ok', `REGISTER complete: ${n}/${n} OK, 0 failed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'subscribe', 'ok', `SUBSCRIBE complete: ${n}/${n} OK, 0 failed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'extensions', 'ok', `ALL EXTENSIONS READY — ${n} registered, ${n} subscribed`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'auto_start', 'ok', `UAS auto-answer started for ${n} extensions`)
      await new Promise((r) => setTimeout(r, 1000))
      await transitionItem(setUasItems, 'auto_active', 'ok', `UAS auto-answer mode active on ${n} extensions`)

      setUasComplete(true)

      // Update store
      setUASPrePhase({
        vm_id: pair?.uas.vm_id ?? 'uas-local',
        role: 'UAS',
        register_complete: true,
        register_count: n,
        register_total: n,
        subscribe_complete: true,
        subscribe_count: n,
        subscribe_total: n,
        extensions_ready: true,
        auto_answer_started: true,
        auto_answer_active: true,
      })

      // Show countdown + activate UAC
      setShowCountdown(true)
    }

    run()
  }, [isMock, extCount, pair, setPhase, setUASPrePhase, transitionItem])

  // Countdown complete → start UAC
  const handleCountdownDone = useCallback(async () => {
    setShowCountdown(false)
    setUacActive(true)

    if (!isMock) return

    const n = extCount
    await new Promise((r) => setTimeout(r, 500))

    await transitionItem(setUacItems, 'register', 'ok', `REGISTER complete: ${n}/${n} OK, 0 failed`)
    await new Promise((r) => setTimeout(r, 1000))
    await transitionItem(setUacItems, 'subscribe', 'ok', `SUBSCRIBE complete: ${n}/${n} OK, 0 failed`)
    await new Promise((r) => setTimeout(r, 1000))
    await transitionItem(setUacItems, 'extensions', 'ok', `ALL EXTENSIONS READY — ${n} registered, ${n} subscribed`)

    setUacComplete(true)

    setUACPrePhase({
      vm_id: pair?.uac.vm_id ?? 'uac-local',
      role: 'UAC',
      register_complete: true,
      register_count: n,
      register_total: n,
      subscribe_complete: true,
      subscribe_count: n,
      subscribe_total: n,
      extensions_ready: true,
      auto_answer_started: false,
      auto_answer_active: false,
    })
  }, [isMock, extCount, pair, setUACPrePhase, transitionItem])

  // Auto-navigate when all UAC items are green — 1.5s so user sees the final state
  useEffect(() => {
    if (uacComplete) {
      const timeout = setTimeout(() => {
        setPhase('TRAFFIC')
        router.push('/run')
      }, 1500)
      return () => clearTimeout(timeout)
    }
  }, [uacComplete, setPhase, router])

  // Retry handler (per-side)
  const handleRetryUAS = useCallback(() => {
    setUasItems(makeUASItems(extCount))
    setUasComplete(false)
    hasStartedRef.current = false
  }, [extCount])

  const handleRetryUAC = useCallback(() => {
    setUacItems(makeUACItems(extCount))
    setUacComplete(false)
  }, [extCount])

  const uasFailed = uasItems.some((it) => it.state === 'failed')
  const uacFailed = uacItems.some((it) => it.state === 'failed')

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Top banner */}
      <div className="flex items-center gap-2 border-b border-amber-500/20 bg-amber-500/5 px-5 py-2.5">
        <AlertTriangle className="size-3.5 shrink-0 text-amber-400" />
        <p className="text-xs text-amber-300">
          Launching UAS first. UAC will start automatically when UAS is ready.
        </p>
      </div>

      {/* Two-column layout */}
      <div className="flex flex-1 overflow-hidden">
        <SidePanel
          role="UAS"
          vmId={pair?.uas.vm_id ?? 'uas-local'}
          items={uasItems}
          active={uasActive}
          onRetry={handleRetryUAS}
          hasFailed={uasFailed}
        />

        {/* Divider */}
        <div className="w-px shrink-0 bg-border/30" />

        <SidePanel
          role="UAC"
          vmId={pair?.uac.vm_id ?? 'uac-local'}
          items={uacItems}
          active={uacActive}
          onRetry={handleRetryUAC}
          hasFailed={uacFailed}
        />
      </div>

      {/* Countdown overlay */}
      <AnimatePresence>
        {showCountdown && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          >
            <LaunchCountdown seconds={3} onComplete={handleCountdownDone} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
