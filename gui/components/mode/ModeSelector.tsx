'use client'

import { motion } from 'framer-motion'
import { useRouter } from 'next/navigation'
import { Monitor, Network, Zap, CheckCircle, Lock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'

const cardVariants = {
  hidden: { opacity: 0, y: 32 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: 0.1 + i * 0.12, duration: 0.45, ease: 'easeOut' as const },
  }),
}

export function ModeSelector() {
  const router = useRouter()
  const setRunMode = useTrafficStore((s) => s.setRunMode)

  const handleLocal = () => {
    setRunMode('local')
    router.push('/config')
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-12">
      {/* Header */}
      <motion.div
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-12 text-center"
      >
        <div className="mb-3 flex items-center justify-center gap-2">
          <Zap className="size-6 text-emerald-400" strokeWidth={2.5} />
          <h1 className="text-2xl font-bold tracking-tight text-foreground">
            CCI Traffic Tool
          </h1>
        </div>
        <p className="text-sm text-muted-foreground">
          CCI Automation &amp; Load Testing Platform
        </p>
      </motion.div>

      {/* Cards */}
      <div className="grid w-full max-w-3xl grid-cols-2 gap-6">

        {/* ── Local / Dev card ─────────────────────────────── */}
        <motion.div
          custom={0}
          variants={cardVariants}
          initial="hidden"
          animate="visible"
          whileHover={{ y: -4, transition: { duration: 0.18 } }}
          onClick={handleLocal}
          className={cn(
            'group relative flex cursor-pointer flex-col rounded-xl border border-border bg-card p-6',
            'transition-shadow hover:border-emerald-500/50 hover:shadow-[0_0_24px_oklch(0.52_0.17_160/0.18)]'
          )}
        >
          <div className="mb-4 flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-lg bg-emerald-500/10">
              <Monitor className="size-5 text-emerald-400" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Local / Dev</h2>
              <p className="text-xs text-muted-foreground">Single machine</p>
            </div>
          </div>

          <p className="mb-4 text-sm text-muted-foreground">
            Co-located UAC &amp; UAS with a single coordinator. No external dependencies.
          </p>

          <ul className="mb-6 space-y-1.5 text-sm">
            {[
              'Dev & smoke tests',
              'Single VM deployment',
              'Configurable call rates',
              'Real-time call metrics',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle className="size-3.5 shrink-0 text-emerald-400" />
                {item}
              </li>
            ))}
          </ul>

          <Button
            size="sm"
            className="mt-auto w-full bg-emerald-500 text-black hover:bg-emerald-400"
            onClick={(e) => { e.stopPropagation(); handleLocal() }}
          >
            Start Local
            <span className="ml-1">→</span>
          </Button>
        </motion.div>

        {/* ── Multi-VM card (Coming Soon) ───────────────────── */}
        <motion.div
          custom={1}
          variants={cardVariants}
          initial="hidden"
          animate="visible"
          className="relative flex flex-col rounded-xl border border-border bg-card p-6"
        >
          {/* Card content (visible behind overlay) */}
          <div className="mb-4 flex items-center gap-3 opacity-50">
            <div className="flex size-10 items-center justify-center rounded-lg bg-blue-500/10">
              <Network className="size-5 text-blue-400" />
            </div>
            <div>
              <h2 className="font-semibold text-foreground">Multi-VM</h2>
              <p className="text-xs text-muted-foreground">Distributed lab</p>
            </div>
          </div>

          <ul className="mb-6 space-y-1.5 text-sm opacity-50">
            {[
              'Up to 5 UAC + 5 UAS VMs',
              'BHCC lab, 40K+ calls/hr',
              'Independent IP + creds',
            ].map((item) => (
              <li key={item} className="flex items-center gap-2 text-muted-foreground">
                <CheckCircle className="size-3.5 shrink-0 text-blue-400" />
                {item}
              </li>
            ))}
          </ul>

          <Button
            variant="outline"
            size="sm"
            className="mt-auto w-full opacity-50"
            onClick={() => {}}
          >
            Notify me
          </Button>

          {/* Frosted glass "Coming Soon" overlay */}
          <div
            className={cn(
              'absolute inset-0 flex flex-col items-center justify-center rounded-xl',
              'bg-card/70 backdrop-blur-[2px]'
            )}
            style={{ cursor: 'not-allowed' }}
          >
            <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card/90 px-5 py-4 shadow-lg">
              <Lock className="size-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">Coming Soon</span>
              <span className="text-xs text-muted-foreground">Phase 2</span>
            </div>
          </div>
        </motion.div>
      </div>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
        className="mt-8 text-xs text-muted-foreground/60"
      >
        CCIAutomationTool · Phase 1 · Local Mode
      </motion.p>
    </div>
  )
}
