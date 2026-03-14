# /build-gui — SBCAutomationTool Traffic Dashboard

## Project Context
- GUI lives in `SBCAutomationTool/gui/` (Next.js 14, TypeScript, Bun)
- Backend: FastAPI coordinator at `http://localhost:8082` (configurable)
- Stack: Next.js + shadcn/ui + Tremor + Framer Motion + Zustand + Zod
- Theme: Dark slate (Datadog-style). No light mode needed.
- Reference @PHASE1_5CALL_DESIGN.md and @README.md for all domain logic

---

## API Contract (DO NOT change backend — GUI adapts to this)
```
REST:
    POST /api/test/start   body: { config: VMConfig }
    POST /api/test/stop
    GET  /api/test/status  → { phase, running, elapsed_seconds }
    GET  /api/metrics      → TrafficMetrics[] (all VMs)
    GET  /api/vms          → [{ vm_id, role, ext_range, status, cps, concurrent }]

WebSocket:
    WS /api/metrics/stream → pushes TrafficMetrics every 10s
```

---

## Folder Structure to Create
```
gui/
├── app/
│   ├── layout.tsx                   ← Root layout, dark bg, font
│   ├── page.tsx                     ← Redirect to /config
│   ├── config/
│   │   └── page.tsx                 ← Screen 1: VM Pair Config
│   ├── launch/
│   │   └── page.tsx                 ← Screen 2: Pre-phase checklist
│   └── run/
│       └── page.tsx                 ← Screen 3+4: Live + Post-run
├── components/
│   ├── layout/
│   │   ├── Navbar.tsx               ← Top nav: logo, phase indicator, status dot
│   │   └── StepIndicator.tsx        ← Config → Launch → Running → Complete
│   ├── config/
│   │   ├── VMPairBook.tsx           ← Side-by-side UAC/UAS "book" layout
│   │   ├── VMConfigPanel.tsx        ← Single VM config form (UAC or UAS)
│   │   ├── TrafficModeSelector.tsx  ← smoke/timed/unlimited with linked fields
│   │   └── ConfigValidator.tsx      ← Inline Zod validation, rule explanations
│   ├── launch/
│   │   ├── PrePhasePanel.tsx        ← UAS checklist + UAC checklist side-by-side
│   │   ├── ChecklistItem.tsx        ← Animated line item (pending/ok/fail)
│   │   └── LaunchCountdown.tsx      ← "UAC starts in 3s" animated countdown
│   ├── dashboard/
│   │   ├── ASRGauge.tsx             ← Large ASR %, green/amber/red threshold
│   │   ├── CPSGauge.tsx             ← Live CPS vs configured target line
│   │   ├── ConcurrentCallsBar.tsx   ← Bar with ceiling alarm
│   │   ├── VMMetricsCard.tsx        ← Per-VM stats card (UAC or UAS)
│   │   ├── AggregatePanel.tsx       ← Combined total_attempted/completed/asr
│   │   ├── LiveChart.tsx            ← Tremor AreaChart, WS-fed, 60s window
│   │   └── RunTimer.tsx             ← Elapsed time display
│   └── postrun/
│       ├── SummaryCard.tsx          ← Exit status badges + final metrics
│       ├── CallTable.tsx            ← Per-call rows: ext pair, result, PDD,
│       │                               hold_ms, MEDIA_VERIFIED/PARTIAL/FAILED
│       └── DownloadReport.tsx       ← Export run as JSON
├── lib/
│   ├── api.ts                       ← REST client, base URL from env
│   ├── ws.ts                        ← WebSocket client, auto-reconnect, backoff
│   ├── mock-data.ts                 ← Full mock for demo without live backend
│   └── config-schema.ts             ← Zod schema mirroring VMConfig dataclass
├── store/
│   └── traffic.ts                   ← Zustand: vmConfigs, phase, metrics, calls
└── types/
    └── index.ts                     ← VMConfig, TrafficMetrics, CallEvent types
```

---

## Types to Define First (`types/index.ts`)
```typescript
// Mirrors VMConfig dataclass from callflow_tool/traffic/config.py
export type VMRole = 'UAC' | 'UAS'
export type TrafficMode = 'smoke' | 'timed' | 'unlimited'
export type SipTransport = 'TCP' | 'TLS' | 'UDP'
export type RunPhase = 'IDLE' | 'PRE_PHASE' | 'TRAFFIC' | 'COMPLETE' | 'FAILED'

export interface VMConfig {
    vm_role: VMRole
    vm_id: string
    uac_ext_start: number
    uac_ext_end: number
    uas_ext_start: number
    uas_ext_end: number
    sbc_host: string
    sbc_port: number
    sip_transport: SipTransport
    domain: string
    sip_password: string
    cps: number
    hold_time_seconds: number
    metrics_port: number
    peer_stop_url?: string      // UAC only, auto-derived from UAS config
    traffic_mode?: TrafficMode  // UAC only
    call_count?: number         // UAC + smoke mode
    duration_hours?: number     // UAC + timed mode
    register_rate: number
    register_timeout: number
    register_retry: number
}

export interface TrafficMetrics {
    vm_id: string
    phase: RunPhase
    running: boolean
    cps_actual: number
    concurrent_calls: number
    calls_attempted: number
    calls_completed: number
    calls_failed: number
    asr: number
    avg_pdd_ms: number
    min_pdd_ms: number
    max_pdd_ms: number
    avg_hold_ms: number
    socket_count: number
    registered_count: number
    run_elapsed_seconds: number
}

export interface PrePhaseStatus {
    vm_id: string
    role: VMRole
    register_complete: boolean
    register_count: number
    register_total: number
    subscribe_complete: boolean
    subscribe_count: number
    subscribe_total: number
    extensions_ready: boolean
    auto_answer_started: boolean  // UAS only
    auto_answer_active: boolean   // UAS only
}

export interface CallEvent {
    call_id: string
    uac_ext: string
    uas_ext: string
    result: 'COMPLETED' | 'FAILED'
    failure_reason?: string
    pdd_ms: number
    hold_ms: number
    media_status: 'MEDIA_VERIFIED' | 'MEDIA_PARTIAL' | 'MEDIA_FAILED' | 'NO_MEDIA'
    rtp_tx_pkts?: number
    rtp_rx_pkts?: number
    timestamp: string
}

export interface AggregateMetrics {
    total_attempted: number
    total_completed: number
    total_failed: number
    aggregate_asr: number
    run_id: string
    started_at: string
    ended_at?: string
}
```

---

## Screen 1 — VM Pair Config (`/config`)

### Layout
- Full-width two-column layout — left = UAC, right = UAS
- Thin vertical divider between them with a ↔ link icon
- Top: `StepIndicator` showing step 1 of 4 active
- Bottom: `[Validate]` button (left) and `[Save & Continue →]` button (right)

### VMConfigPanel behavior
- UAC panel shows ALL fields including `traffic_mode`, `call_count`,
    `duration_hours`, `peer_stop_url`
- UAS panel hides `traffic_mode`, `call_count`, `duration_hours`
- `peer_stop_url` in UAC is AUTO-DERIVED: when UAS `vm_id` and
    `metrics_port` change, UAC `peer_stop_url` updates to
    `http://<uas_sbc_host>:<uas_metrics_port>/api/test/stop`
    Show this as a read-only derived field with a 🔗 icon explaining the link
- Show extension count derived from range: `ext 4001000–4001004 = 5 extensions`
    Update live as user types

### TrafficModeSelector
- Three radio cards (not a dropdown): smoke | timed | unlimited
- Selecting smoke: shows `call_count` field, greys out `duration_hours`
- Selecting timed: shows `duration_hours` with helper presets:
    `[15 min]  [1h BHCC]  [8h]  [24h overnight]` — clicking preset fills field
- Selecting unlimited: greys out both fields with note
    "Runs until coordinator POST /api/test/stop"

### Inline Validation (Zod, on blur)
Show rules contextually under the relevant field, not in a separate panel:
- `traffic_mode=smoke` and `call_count=0` → red: "call_count required for smoke mode"
- `cps × duration_hours × 3600` → show derived max_calls below duration field
- `peer_stop_url` format check → must be valid http URL
- `uac_ext_start < uac_ext_end` → enforce
- `uas_ext_start` must not overlap `uac_ext_start` range

---

## Screen 2 — Pre-Phase Launch (`/launch`)

### Layout
- Same two-column structure as config — UAC left, UAS right
- UAS panel starts active, UAC panel greyed out initially
- Top banner: "Launching UAS first. UAC will start automatically when UAS is ready."

### PrePhasePanel — checklist items animate in via Framer Motion
UAS side shows all 5 items:
```
○ → ✅  REGISTER complete: N/N OK
○ → ✅  SUBSCRIBE complete: N/N OK
○ → ✅  ALL EXTENSIONS READY — N registered, N subscribed
○ → ✅  UAS auto-answer started for N extensions      ← UAS ONLY
○ → ✅  UAS auto-answer mode active on N extensions   ← UAS ONLY
```
UAC side shows 3 items (no auto-answer):
```
○ → ✅  REGISTER complete: N/N OK
○ → ✅  SUBSCRIBE complete: N/N OK
○ → ✅  ALL EXTENSIONS READY — N registered, N subscribed
```
- N is dynamic — parse the count from the log line, don't hardcode
- Each item: pending (grey dot) → checking (spinning) → ok (green ✅) → failed (red ✗)
- Once all UAS items green: show `LaunchCountdown` ("Starting UAC in 3s...")
    with animated ring countdown
- Once all UAC items green: auto-navigate to `/run`

### On failure
- Failed item turns red, shows extracted log line beneath it in mono font
- "Retry UAS" button appears, does not restart UAC

---

## Screen 3 — Live Traffic Dashboard (`/run`, running state)

### Layout — 3 rows
**Row 1 — Hero metrics (full width)**
```
┌─────────────────────────────────────────────────────────┐
│  ASR   92.4%  🟡          RUN TIME   9m 12s             │
│  ████████████████████░░░░                               │
│  Threshold: green >95%, amber 80-95%, red <80%          │
└─────────────────────────────────────────────────────────┘
```

**Row 2 — Side by side VM cards**
```
┌──────────────────────────┬──────────────────────────────┐
│ UAC  uac-local           │ UAS  uas-local               │
│ Attempted:   20          │ Answered:    19              │
│ Completed:   19          │ Failed:      0               │
│ Failed:       1 🔴       │ ASR:       100%  🟢          │
│ PDD avg:    143ms        │                              │
│ Hold avg:  10.0s         │ Registered:  10 / 10         │
│ CPS: ●──────────  5.98/6 │ Sockets:     10              │
└──────────────────────────┴──────────────────────────────┘
```

**Row 3 — Charts + concurrent calls**
- `LiveChart`: Tremor AreaChart, dual series (UAC completed, UAC failed),
    60-second rolling window, WS-fed
- `ConcurrentCallsBar`: horizontal bar, current/max, red pulse if >95% ceiling

### WebSocket behavior
- Connect on page mount, auto-reconnect with exponential backoff (1s, 2s, 4s, max 30s)
- Show connection status dot in Navbar: green=connected, amber=reconnecting, red=disconnected
- On disconnect show subtle banner "Reconnecting..." — do not disrupt the charts

---

## Screen 4 — Post-Run Summary (`/run`, completed state — same page, phase switch)

### Triggered when both PIDs exit (phase = COMPLETE or FAILED)

### SummaryCard
```
┌─────────────────────────────────────────────────────────┐
│  RUN COMPLETE  ──────────────────────────────────────── │
│  UAC  ✅ exit 0          UAS  ✅ exit 0                 │
│  Duration: 45.2s         Run ID: run-20260313-120640    │
│                                                         │
│  Total Attempted:  20    Total Completed:  19           │
│  Total Failed:      1    Aggregate ASR:  95.0%  🟢      │
│                                                         │
│  Log files:                                             │
│   traffic_uac-local_20260313_120640.log                 │
│   traffic_summary_uac-local_20260313_120640.log         │
│   traffic_uas-local_20260313_120413.log                 │
│   traffic_summary_uas-local_20260313_120413.log         │
└─────────────────────────────────────────────────────────┘
```

### CallTable
Columns: `#` | `UAC ext` | `UAS ext` | `Result` | `PDD ms` |
`Hold ms` | `Media` | `Failure reason`
- `Result`: green COMPLETED / red FAILED badge
- `Media`: MEDIA_VERIFIED ✅ / MEDIA_PARTIAL 🟡 / MEDIA_FAILED 🔴 / NO_MEDIA —
- Default: show 20 rows, paginate beyond that
- Sortable by result and PDD

### On FAILED phase (non-zero exit)
Show a `FailureAnalysis` card between SummaryCard and CallTable:
```
ROOT CAUSE (most likely):
    → <parsed from logs>

SUPPORTING EVIDENCE (correlated by timestamp):
    [HH:MM:SS] UAS: ...
    [HH:MM:SS] UAC: ...

RECOMMENDATION:
    → <one line>
```

---

## Mock Data Layer (`lib/mock-data.ts`)

Create complete mock that matches ALL types above.
Use realistic values: 10 extensions, smoke mode, ~18/20 calls completed,
1 failure (404), ASR 90%, avg_pdd_ms ~145, hold_time 10s.
Mock PrePhaseStatus with all 5 UAS items and 3 UAC items populated.
Mock 20 CallEvent rows with mixed MEDIA_VERIFIED and one MEDIA_FAILED.

Add a `MOCK_MODE` env flag (`NEXT_PUBLIC_MOCK_MODE=true`) that:
- Uses mock data instead of real API/WS calls
- Simulates pre-phase with 500ms delays per checklist item
- Simulates live metrics updating every 2s
This lets the demo run without a live backend.

---

## Zustand Store (`store/traffic.ts`)
```typescript
interface TrafficStore {
    // Config
    uacConfig: VMConfig | null
    uasConfig: VMConfig | null
    setUACConfig: (c: VMConfig) => void
    setUASConfig: (c: VMConfig) => void

    // Phase
    phase: RunPhase
    setPhase: (p: RunPhase) => void

    // Pre-phase
    uasPrePhase: PrePhaseStatus | null
    uacPrePhase: PrePhaseStatus | null

    // Live metrics
    uacMetrics: TrafficMetrics | null
    uasMetrics: TrafficMetrics | null
    metricsHistory: { t: number; asr: number; completed: number }[]

    // Post-run
    callEvents: CallEvent[]
    aggregate: AggregateMetrics | null
}
```

---

## Theme (`app/globals.css` — Tailwind v4 oklch, NOT tailwind.config.ts)

In the `.dark` block, set these oklch values:
- Background:  `--background: oklch(0.13 0.02 250)`   ← slate-950
- Card:        `--card: oklch(0.17 0.02 250)`          ← slate-900
- Border:      `--border: oklch(0.30 0.02 250)`        ← slate-700
- Success:     use Tailwind `emerald-400` class directly
- Warning:     use Tailwind `amber-400` class directly
- Error:       use Tailwind `rose-500` class directly

Font: Inter for UI, JetBrains Mono for metrics numbers and log lines.
Add to layout.tsx — import both from `next/font/google`.
All Tremor charts: dark theme, no white backgrounds.
Hardcode `className="dark"` on `<html>` in layout.tsx. No toggle needed.
```

---

## .env.local to create
```
NEXT_PUBLIC_COORDINATOR_URL=http://localhost:8082
NEXT_PUBLIC_MOCK_MODE=true
```

---

## Do NOT do any of the following
- Do not modify anything in `callflow_tool/`
- Do not create a separate CSS file — all styling in Tailwind + shadcn
- Do not use `pages/` router — App Router only
- Do not use `localStorage` — Zustand in-memory only
- Do not add Redux, React Query, or Axios — Zustand + native fetch/WS only