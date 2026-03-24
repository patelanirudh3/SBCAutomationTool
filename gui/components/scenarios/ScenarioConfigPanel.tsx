'use client'

import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { CheckCircle2, Play, Info } from 'lucide-react'
import { useTrafficStore } from '@/store/traffic'
import { cn } from '@/lib/utils'
import type { Scenario } from '@/types'

interface ScenarioConfigPanelProps {
  scenario: Scenario
}

export function ScenarioConfigPanel({ scenario }: ScenarioConfigPanelProps) {
  const pairs = useTrafficStore((s) => s.pairs)
  const activePairIndex = useTrafficStore((s) => s.activePairIndex)
  const pair = pairs[activePairIndex]

  const [uacExt, setUacExt] = useState(String(pair?.uac.uac_ext_start ?? '4001000'))
  const [uasExt, setUasExt] = useState(String(pair?.uac.uas_ext_start ?? '4001005'))
  const [sbcHost, setSbcHost] = useState(pair?.uac.sbc_host ?? '10.133.63.117')
  const [sbcPort, setSbcPort] = useState(String(pair?.uac.sbc_port ?? 5060))
  const [domain, setDomain] = useState(pair?.uac.domain ?? 'avaya.com')
  const [password, setPassword] = useState(pair?.uac.sip_password ?? '123456')

  const [holdDuration, setHoldDuration] = useState('3')
  const [preHoldRtp, setPreHoldRtp] = useState('2')
  const [postHoldRtp, setPostHoldRtp] = useState('2')

  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const isHoldScenario = scenario.id === 'hold_unhold'
  const isBasicCall = scenario.id === 'basic_call'

  async function handleRun() {
    if (!isBasicCall) {
      setToastMsg(`${scenario.name} scenario execution coming soon`)
      setTimeout(() => setToastMsg(null), 3000)
      return
    }

    try {
      const uacIp = pair?.uac.vm_ip ?? '127.0.0.1'
      const uacPort = pair?.uac.metrics_port ?? 8082
      await fetch(`http://${uacIp}:${uacPort}/api/test/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          run_id: `scenario-${Date.now()}`,
          pair_id: 'pair-1',
          scenario: scenario.id,
        }),
      })
      setToastMsg('Scenario run started')
      setTimeout(() => setToastMsg(null), 3000)
    } catch {
      setToastMsg('Failed to start scenario — check backend connectivity')
      setTimeout(() => setToastMsg(null), 4000)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Endpoint config */}
      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-foreground/70 mb-4">
          Endpoint Configuration
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <Field label="UAC Extension" value={uacExt} onChange={setUacExt} />
          <Field label="UAS Extension" value={uasExt} onChange={setUasExt} />
          <Field label="SBC Host" value={sbcHost} onChange={setSbcHost} />
          <Field label="SBC Port" value={sbcPort} onChange={setSbcPort} />
          <Field label="Domain" value={domain} onChange={setDomain} />
          <Field label="SIP Password" value={password} onChange={setPassword} type="password" />
        </div>
      </section>

      {/* Scenario parameters — only for hold_unhold */}
      <section
        className={cn(
          'rounded-xl border border-border bg-card p-5 transition-opacity duration-300',
          isHoldScenario ? 'opacity-100' : 'opacity-30 pointer-events-none'
        )}
      >
        <h3 className="text-xs font-bold uppercase tracking-widest text-foreground/70 mb-4">
          Scenario Parameters
        </h3>
        <div className="grid grid-cols-3 gap-4">
          <Field label="Hold Duration (sec)" value={holdDuration} onChange={setHoldDuration} />
          <Field label="Pre-hold RTP (sec)" value={preHoldRtp} onChange={setPreHoldRtp} />
          <Field label="Post-hold RTP (sec)" value={postHoldRtp} onChange={setPostHoldRtp} />
        </div>
      </section>

      {/* Assertions (read-only) */}
      <section className="rounded-xl border border-border bg-card p-5">
        <h3 className="text-xs font-bold uppercase tracking-widest text-foreground/70 mb-3">
          Assertions
        </h3>
        <div className="flex flex-col gap-2">
          {scenario.assertions.map((a) => (
            <div key={a} className="flex items-center gap-2.5">
              <CheckCircle2 className="size-3.5 text-emerald-400/60 shrink-0" />
              <span className="text-sm text-foreground/80">{a}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Run button */}
      <Button
        onClick={handleRun}
        className="gap-2 bg-violet-600 hover:bg-violet-500 text-white w-full"
        size="lg"
      >
        <Play className="size-4" />
        Run Scenario
      </Button>

      {/* Toast */}
      {toastMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-secondary/60 px-4 py-2.5">
          <Info className="size-4 text-violet-400 shrink-0" />
          <span className="text-sm text-foreground">{toastMsg}</span>
        </div>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-medium text-foreground/65">{label}</Label>
      <Input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-9 text-sm font-mono bg-secondary/30"
      />
    </div>
  )
}
