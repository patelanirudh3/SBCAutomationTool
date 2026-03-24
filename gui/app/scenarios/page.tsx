'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion } from 'framer-motion'
import { FlaskConical, CheckCircle2, Clock, ChevronRight } from 'lucide-react'
import { Navbar } from '@/components/layout/Navbar'
import { Button } from '@/components/ui/button'
import { useTrafficStore } from '@/store/traffic'
import { getScenarios } from '@/lib/api'
import { cn } from '@/lib/utils'
import type { Scenario } from '@/types'

const FALLBACK_SCENARIOS: Scenario[] = [
  {
    id: 'basic_call',
    name: 'Basic Call',
    description: 'Place a SIP call through the SBC to CM and verify end-to-end signaling + media.',
    status: 'available',
    assertions: ['SIP 200 OK received', 'RTP bidirectional', 'BYE completes cleanly'],
  },
  {
    id: 'hold_unhold',
    name: 'Hold / Unhold',
    description: 'Place a call, put it on hold via re-INVITE, verify hold music / silence, then resume.',
    status: 'coming_soon',
    assertions: ['Hold re-INVITE accepted', 'RTP paused during hold', 'RTP resumes after unhold', 'Call completes normally'],
  },
  {
    id: 'blind_transfer',
    name: 'Blind Transfer',
    description: 'Transfer an active call to a third party using SIP REFER.',
    status: 'coming_soon',
    assertions: ['REFER accepted (202)', 'New INVITE to transfer target', 'Original call released'],
  },
  {
    id: 'attended_transfer',
    name: 'Attended Transfer',
    description: 'Consult with transfer target before completing the transfer.',
    status: 'coming_soon',
    assertions: ['Consultation call established', 'REFER with Replaces header', 'Media path updated'],
  },
]

export default function ScenariosPage() {
  const [scenarios, setScenarios] = useState<Scenario[]>(FALLBACK_SCENARIOS)
  const [loading, setLoading] = useState(true)
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)
  const pair = pairs[activePairIndex]

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const fetched = await getScenarios(
        pair?.uac.vm_ip ?? '127.0.0.1',
        pair?.uac.metrics_port ?? 8082
      )
      if (!cancelled) {
        setScenarios(fetched.length > 0 ? fetched : FALLBACK_SCENARIOS)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [pair])

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 overflow-y-auto py-8">
        <div className="max-w-4xl mx-auto px-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-8">
            <div className="flex size-10 items-center justify-center rounded-xl bg-violet-500/15">
              <FlaskConical className="size-5 text-violet-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-foreground">Feature Scenarios</h1>
              <p className="text-sm text-muted-foreground">
                Validate specific SIP features against your infrastructure
              </p>
            </div>
          </div>

          {/* Scenario grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {scenarios.map((scenario, i) => (
              <motion.div
                key={scenario.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: i * 0.06 }}
              >
                <ScenarioCard scenario={scenario} />
              </motion.div>
            ))}
          </div>

          {loading && (
            <p className="text-center text-sm text-muted-foreground mt-6 animate-pulse">
              Loading scenarios from backend…
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function ScenarioCard({ scenario }: { scenario: Scenario }) {
  const isAvailable = scenario.status === 'available'

  return (
    <div
      className={cn(
        'rounded-xl border bg-card p-5 flex flex-col gap-3 transition-all duration-200',
        isAvailable
          ? 'border-border hover:border-violet-500/40 hover:shadow-lg hover:shadow-violet-500/5'
          : 'border-border/60 opacity-70'
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between">
        <h3 className="text-base font-bold text-foreground">{scenario.name}</h3>
        <span
          className={cn(
            'rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-widest shrink-0',
            isAvailable
              ? 'bg-emerald-400/15 text-emerald-400'
              : 'bg-amber-400/15 text-amber-400'
          )}
        >
          {isAvailable ? 'Available' : 'Coming Soon'}
        </span>
      </div>

      {/* Description */}
      <p className="text-sm text-muted-foreground leading-relaxed">
        {scenario.description}
      </p>

      {/* Assertions */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-foreground/60">
          Assertions
        </span>
        {scenario.assertions.map((a) => (
          <div key={a} className="flex items-center gap-2">
            <CheckCircle2
              className={cn(
                'size-3 shrink-0',
                isAvailable ? 'text-emerald-400/60' : 'text-muted-foreground/30'
              )}
            />
            <span
              className={cn(
                'text-xs',
                isAvailable ? 'text-foreground/70' : 'text-muted-foreground/40'
              )}
            >
              {a}
            </span>
          </div>
        ))}
      </div>

      {/* Action */}
      <div className="pt-1">
        {isAvailable ? (
          <Link href={`/scenarios/${scenario.id}/config`}>
            <Button
              variant="outline"
              size="sm"
              className="gap-2 border-violet-500/40 text-violet-400 hover:bg-violet-500/10 hover:border-violet-400 w-full justify-center"
            >
              Configure & Run
              <ChevronRight className="size-3.5" />
            </Button>
          </Link>
        ) : (
          <Button
            variant="outline"
            size="sm"
            disabled
            className="gap-2 w-full justify-center"
          >
            <Clock className="size-3.5" />
            Coming Soon
          </Button>
        )}
      </div>
    </div>
  )
}
