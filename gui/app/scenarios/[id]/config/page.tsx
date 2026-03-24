'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, FlaskConical } from 'lucide-react'
import { Navbar } from '@/components/layout/Navbar'
import { ScenarioConfigPanel } from '@/components/scenarios/ScenarioConfigPanel'
import { useTrafficStore } from '@/store/traffic'
import { getScenarios } from '@/lib/api'
import type { Scenario } from '@/types'

export default function ScenarioConfigPage() {
  const params = useParams<{ id: string }>()
  const scenarioId = params.id

  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)
  const pair = pairs[activePairIndex]

  const [scenario, setScenario] = useState<Scenario | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const all = await getScenarios(
        pair?.uac.vm_ip ?? '127.0.0.1',
        pair?.uac.metrics_port ?? 8082
      )
      if (!cancelled) {
        const found = all.find((s) => s.id === scenarioId) ?? null
        if (!found && scenarioId === 'basic_call') {
          setScenario({
            id: 'basic_call',
            name: 'Basic Call',
            description: 'Place a SIP call through the SBC to CM and verify end-to-end signaling + media.',
            status: 'available',
            assertions: ['SIP 200 OK received', 'RTP bidirectional', 'BYE completes cleanly'],
          })
        } else {
          setScenario(found)
        }
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [pair, scenarioId])

  return (
    <div className="min-h-screen flex flex-col">
      <Navbar />

      <div className="flex-1 overflow-y-auto py-8">
        <div className="max-w-2xl mx-auto px-6">
          {/* Back link */}
          <Link
            href="/scenarios"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors mb-6"
          >
            <ArrowLeft className="size-3.5" />
            Back to Scenarios
          </Link>

          {loading ? (
            <p className="text-sm text-muted-foreground animate-pulse">Loading scenario…</p>
          ) : scenario ? (
            <>
              {/* Header */}
              <div className="flex items-center gap-3 mb-6">
                <div className="flex size-9 items-center justify-center rounded-lg bg-violet-500/15">
                  <FlaskConical className="size-4 text-violet-400" />
                </div>
                <div>
                  <h1 className="text-lg font-bold text-foreground">{scenario.name}</h1>
                  <p className="text-sm text-muted-foreground">{scenario.description}</p>
                </div>
              </div>

              <ScenarioConfigPanel scenario={scenario} />
            </>
          ) : (
            <p className="text-sm text-rose-400">Scenario &quot;{scenarioId}&quot; not found.</p>
          )}
        </div>
      </div>
    </div>
  )
}
