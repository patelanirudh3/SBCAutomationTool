import type { ControllerCallStats } from '@/types'

interface ControllerCallSummaryProps {
  stats?: Record<string, ControllerCallStats> | null
}

export function ControllerCallSummary({ stats }: ControllerCallSummaryProps) {
  const rows = Object.values(stats ?? {}).sort((a, b) =>
    a.controller.localeCompare(b.controller),
  )

  if (rows.length === 0) {
    return null
  }

  return (
    <div className="rounded-xl border border-slate-700/50 bg-card">
      <div className="border-b border-slate-700/40 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-100">Controller Call Distribution</h3>
        <p className="mt-1 text-xs text-slate-400">
          UAC calls are INVITEs sent through that controller. UAS calls are calls where the selected callee belongs to that controller.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-slate-700/40 text-[10px] uppercase tracking-widest text-slate-400">
              <th className="px-4 py-2 text-left">Controller</th>
              <th className="px-4 py-2 text-right">UAC Calls</th>
              <th className="px-4 py-2 text-right">UAS Calls</th>
              <th className="px-4 py-2 text-right">Completed</th>
              <th className="px-4 py-2 text-right">Failed</th>
              <th className="px-4 py-2 text-right">Failed as UAC Ctrl</th>
              <th className="px-4 py-2 text-right">Failed as UAS Ctrl</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.controller} className="border-b border-slate-700/20 last:border-0">
                <td className="px-4 py-2 font-mono text-sky-300">{row.controller}</td>
                <td className="px-4 py-2 text-right font-mono text-slate-200">{row.uac_calls}</td>
                <td className="px-4 py-2 text-right font-mono text-slate-200">{row.uas_calls}</td>
                <td className="px-4 py-2 text-right font-mono text-emerald-300">{row.completed}</td>
                <td className="px-4 py-2 text-right font-mono text-rose-300">{row.failed}</td>
                <td className="px-4 py-2 text-right font-mono text-rose-300">{row.failed_as_uac_controller}</td>
                <td className="px-4 py-2 text-right font-mono text-amber-300">{row.failed_as_uas_controller}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
