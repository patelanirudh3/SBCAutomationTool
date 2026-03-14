# /build-gui — SBCAutomationTool Traffic Dashboard
## Master Spec — Reference this file in every Cursor prompt via @build-gui.md

---

## Project Context
- GUI lives in `SBCAutomationTool/gui/` (Next.js 14 App Router, TypeScript, Bun)
- Backend: FastAPI coordinator at `http://localhost:8082` (configurable via env)
- Stack: Next.js + shadcn/ui + Tremor v3 + Framer Motion + Zustand + Zod
- Theme: Dark slate (Datadog-style). Hardcode `className="dark"` on `<html>`. No toggle.
- Fonts: `Space Mono` for metrics/numbers/log lines, `DM Sans` for UI labels and body
- Colors: Tailwind v4 oklch — do NOT use HSL. Do NOT use tailwind.config.ts for theme.
  Set all theme tokens in `app/globals.css` `.dark` block using oklch values.
  - Background:     oklch(0.13 0.02 250)   ← slate-950
  - Card:           oklch(0.17 0.02 250)   ← slate-900
  - Border:         oklch(0.30 0.02 250)   ← slate-700
  - Success accent: use Tailwind `emerald-400` class
  - Warning accent: use Tailwind `amber-400` class
  - Error accent:   use Tailwind `rose-500` class
- Reference @PHASE1_5CALL_DESIGN.md, @RTP_FLOW_REFERENCE.md and @README.md for all domain logic

---

## API Contract (DO NOT change backend — GUI adapts to this)

```
REST:
  POST /api/test/start         body: { config: VMConfig }
  POST /api/test/stop
  GET  /api/test/status        → { phase, running, elapsed_seconds }
  GET  /api/metrics            → TrafficMetrics[] (all VMs)
  GET  /api/vms                → [{ vm_id, role, ext_range, status, cps, concurrent }]
  PUT  /api/config             → Push config to VM, triggers yaml creation
  GET  /api/ping               → { reachable: true } used for live reachability check

WebSocket:
  WS /api/metrics/stream       → pushes TrafficMetrics every 10s
```

---

## Run Modes

The tool supports two run modes stored in Zustand as `runMode: 'local' | 'multi-vm'`.

### Local Mode
- Single machine (Windows laptop, dev VM, Monday demo)
- One process = UAC, another process = UAS, same machine
- Coordinator on localhost, ports 8081 (UAS) and 8082 (UAC)
- Entry: mode selector → Local card → goes directly to /config (Screen 1A)

### Multi-VM Mode
- Up to 5 UAC VMs + 5 UAS VMs = max 5 pairs
- Each VM has its own IP, coordinator port, optional SSH credentials
- For Monday demo: Multi-VM card is visible but shows "Coming Soon — Phase 2" overlay
- Do not disable or hide it — show it prominently but locked

---

## Folder Structure

```
gui/
├── app/
│   ├── layout.tsx                    ← Root layout, dark bg, fonts, TooltipProvider
│   ├── page.tsx                      ← Mode selector (entry point)
│   ├── config/
│   │   └── page.tsx                  ← Screen 1: VM Pair Config (Local mode)
│   ├── launch/
│   │   └── page.tsx                  ← Screen 2: Pre-phase checklist
│   └── run/
│       └── page.tsx                  ← Screen 3 (live) + Screen 4 (post-run), phase-aware
├── components/
│   ├── layout/
│   │   ├── Navbar.tsx                ← Logo, phase indicator, WS status dot
│   │   └── StepIndicator.tsx         ← Config → Launch → Running → Complete (4 steps)
│   ├── mode/
│   │   └── ModeSelector.tsx          ← Entry: Local card + Multi-VM "Coming Soon" card
│   ├── config/
│   │   ├── VMPairBook.tsx            ← Side-by-side book layout, divider with ↔ icon
│   │   ├── VMConfigPanel.tsx         ← Single VM config form (role-aware: UAC or UAS)
│   │   ├── TrafficModeSelector.tsx   ← Three radio cards: smoke / timed / unlimited
│   │   └── ConfigValidator.tsx       ← Inline Zod validation shown under each field
│   ├── launch/
│   │   ├── PrePhasePanel.tsx         ← UAS + UAC checklist side-by-side
│   │   ├── ChecklistItem.tsx         ← Animated: pending → spinning → ok/fail
│   │   └── LaunchCountdown.tsx       ← Ring countdown "Starting UAC in 3s…"
│   ├── dashboard/
│   │   ├── ASRGauge.tsx              ← Hero metric: large %, green/amber/red
│   │   ├── CPSGauge.tsx              ← Live CPS vs target line
│   │   ├── ConcurrentCallsBar.tsx    ← Bar with ceiling alarm pulse
│   │   ├── VMMetricsCard.tsx         ← Per-VM stats card (UAC or UAS)
│   │   ├── AggregatePanel.tsx        ← total_attempted / completed / asr
│   │   ├── LiveChart.tsx             ← Tremor AreaChart, WS-fed, 60s window
│   │   └── RunTimer.tsx              ← Elapsed time HH:MM:SS
│   └── postrun/
│       ├── SummaryCard.tsx           ← Exit status badges + final metrics
│       ├── CallTable.tsx             ← Per-call rows with sort + pagination
│       ├── FailureAnalysis.tsx       ← Root cause card, shown only on FAILED phase
│       └── DownloadReport.tsx        ← Export run as JSON
├── lib/
│   ├── api.ts                        ← REST client, base URL from env
│   ├── ws.ts                         ← WebSocket, auto-reconnect, exponential backoff
│   ├── mock-data.ts                  ← Full mock for MOCK_MODE demo
│   └── config-schema.ts              ← Zod schema, all cross-field rules
├── store/
│   └── traffic.ts                    ← Zustand store
└── types/
    └── index.ts                      ← All shared TypeScript types
```

---

## Types (`types/index.ts`)

```typescript
export type VMRole = 'UAC' | 'UAS'
export type TrafficMode = 'smoke' | 'timed' | 'unlimited'
export type SipTransport = 'TCP' | 'TLS' | 'UDP'
export type RunPhase = 'IDLE' | 'PRE_PHASE' | 'TRAFFIC' | 'COMPLETE' | 'FAILED'
export type RunMode = 'local' | 'multi-vm'

export interface VMConfig {
  // Identity
  vm_role: VMRole
  vm_id: string

  // VM Connection (used in multi-VM mode; in local mode defaults to localhost)
  vm_ip: string                   // default: '127.0.0.1' for local mode
  ssh_user?: string               // optional, for future deploy
  ssh_key_path?: string           // optional, for future deploy

  // Extensions
  uac_ext_start: number
  uac_ext_end: number
  uas_ext_start: number
  uas_ext_end: number

  // SIP Connection
  sbc_host: string
  sbc_port: number
  sip_transport: SipTransport
  domain: string
  sip_password: string

  // Traffic
  cps: number
  hold_time_seconds: number
  metrics_port: number
  peer_stop_url?: string          // UAC only — auto-derived from UAS vm_ip + metrics_port

  // Run Control (UAC only)
  traffic_mode?: TrafficMode
  call_count?: number             // smoke mode
  duration_hours?: number         // timed mode

  // Registration
  register_rate: number
  register_timeout: number
  register_retry: number
}

export interface VMPair {
  pair_id: string                 // e.g. 'pair-1'
  pair_label: string              // e.g. 'Pair 1'
  uac: VMConfig
  uas: VMConfig
  validated: boolean
  saved: boolean
  save_error?: string
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
  auto_answer_started: boolean    // UAS only — never shown on UAC panel
  auto_answer_active: boolean     // UAS only — never shown on UAC panel
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

export interface ReachabilityStatus {
  vm_id: string
  reachable: boolean
  checking: boolean
  error?: string
}
```

---

## Zustand Store (`store/traffic.ts`)

```typescript
interface TrafficStore {
  // Mode
  runMode: RunMode
  setRunMode: (m: RunMode) => void

  // VM Pairs (multi-vm) or single pair (local)
  pairs: VMPair[]
  activePairIndex: number
  addPair: () => void
  updatePair: (index: number, pair: VMPair) => void
  setActivePair: (index: number) => void

  // Reachability
  reachability: Record<string, ReachabilityStatus>
  setReachability: (vm_id: string, status: ReachabilityStatus) => void

  // Phase
  phase: RunPhase
  setPhase: (p: RunPhase) => void

  // Pre-phase
  uasPrePhase: PrePhaseStatus | null
  uacPrePhase: PrePhaseStatus | null
  setUASPrePhase: (s: PrePhaseStatus) => void
  setUACPrePhase: (s: PrePhaseStatus) => void

  // Live metrics
  uacMetrics: TrafficMetrics | null
  uasMetrics: TrafficMetrics | null
  metricsHistory: { t: number; asr: number; completed: number; failed: number }[]
  updateMetrics: (uac: TrafficMetrics, uas: TrafficMetrics) => void

  // Post-run
  callEvents: CallEvent[]
  aggregate: AggregateMetrics | null
  setCallEvents: (events: CallEvent[]) => void
  setAggregate: (a: AggregateMetrics) => void
}
```

---

## Entry Point — Mode Selector (`app/page.tsx`)

Two large cards side by side, full viewport height centered:

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│                     ⚡ CCI Traffic Tool                        │
│              SBC Automation & Load Testing Platform            │
│                                                                 │
│   ┌──────────────────────────┐  ┌──────────────────────────┐   │
│   │                          │  │                          │   │
│   │   🖥  Local / Dev        │  │   🖧  Multi-VM           │   │
│   │                          │  │   ┌──────────────────┐   │   │
│   │  Single machine          │  │   │  Coming Soon     │   │   │
│   │  UAC + UAS same box      │  │   │  Phase 2         │   │   │
│   │                          │  │   └──────────────────┘   │   │
│   │  Perfect for:            │  │                          │   │
│   │  • Dev & smoke tests     │  │  Up to 5 UAC + 5 UAS VMs │   │
│   │  • Single VM demos       │  │  BHCC lab, 40K calls/hr  │   │
│   │  • Monday demos ✓        │  │  Independent IP + creds  │   │
│   │                          │  │                          │   │
│   │  [ Start Local →  ]      │  │  [ Notify me ]           │   │
│   └──────────────────────────┘  └──────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

- Local card: full interactable, hover lifts with subtle glow, click → /config
- Multi-VM card: visible but overlaid with frosted glass "Coming Soon — Phase 2" badge
  - Still shows content beneath so CTOs understand what's coming
  - Cursor: not-allowed on card body, but "Notify me" button is clickable (no-op for now)
- Framer Motion: cards animate in with staggered slide-up on load

---

## Screen 1 — VM Pair Config (`/config`)

### Layout
- Full-width two-column layout (book) — UAC left, UAS right
- Thin vertical divider with ↔ link icon in center
- Top: `StepIndicator` step 1 of 4 active
- Bottom bar: `[Validate]` left, `[Save & Continue →]` right
  - Save & Continue only enabled after Validate passes (green)

### VMConfigPanel — Role-Aware Fields

**Both UAC and UAS show:**
- IDENTITY: vm_id
- VM CONNECTION:
  - IP Address (default: `127.0.0.1` for local mode, prefilled)
  - SSH User (optional field, placeholder "ubuntu — optional")
  - SSH Key Path (optional, placeholder "/home/user/.ssh/id_rsa — optional")
- SIP CONNECTION: sbc_host, sbc_port, transport (dropdown), domain, sip_password
- EXTENSIONS:
  - UAC range: start + end → show "# N ext" badge live
  - UAS range: start + end → show "# N ext" badge live
  - Rule: ranges must not overlap, shown inline if violated
- TRAFFIC: cps, hold_time_seconds, metrics_port
  - Reachability indicator: after vm_ip + metrics_port are filled and user blurs out,
    show spinner → ● green "Reachable" or ● red "Unreachable (connection refused)"
    Calls `GET /api/ping` at `http://{vm_ip}:{metrics_port}/api/ping` (HTTP health check,
    confirms the FastAPI process is running — not an ICMP ping)

**UAC only — additional sections:**
- RUN CONTROL:
  - TrafficModeSelector (3 radio cards)
  - call_count or duration_hours based on mode
- COORDINATION:
  - peer_stop_url: read-only derived field
    `http://<uas_vm_ip>:<uas_metrics_port>/api/test/stop`
    Show 🔗 icon + tooltip "Auto-derived from UAS IP and metrics port"
    Updates live when UAS vm_ip or metrics_port changes

**UAS only — hide entirely:**
- traffic_mode, call_count, duration_hours, peer_stop_url

### TrafficModeSelector
- Three horizontal radio cards: Smoke | Timed | Unlimited
- Smoke selected (default):
  - Shows: `Call Count [  10  ]`
  - Hides: duration_hours
- Timed selected:
  - Shows: `Duration [  1.0  ] hours`
  - Shows preset buttons: `[15 min]  [1h BHCC]  [8h]  [24h]`
  - Clicking preset fills the field immediately
  - Shows derived value: `→ max_calls = CPS × H × 3600 = 21,600`
- Unlimited selected:
  - Greys both fields
  - Shows note: "Runs until coordinator POST /api/test/stop"

### Inline Validation (Zod, fires on blur per field)
- Shown as small red text directly under the offending field
- `smoke` + `call_count = 0` → "call_count required for smoke mode"
- `timed` + `duration_hours = 0` → "duration_hours required for timed mode"
- `uac_ext_start >= uac_ext_end` → "End must be greater than Start"
- UAC and UAS ranges overlap → "UAC and UAS extension ranges must not overlap"
- `peer_stop_url` invalid → "Must be a valid http:// URL"
- `sbc_port` out of range → "Port must be between 1 and 65535"

### Validate button behavior
- Runs full Zod parse on both UAC and UAS configs
- On pass: button turns green "✅ All valid", Save & Continue unlocks
- On fail: scrolls to first error, button stays grey

### Save & Continue behavior
- In Local mode: no VM API call needed — saves configs to Zustand, navigates to /launch
- (Multi-VM mode — Phase 2: would POST to each VM coordinator)

---

## Screen 2 — Pre-Phase Launch (`/launch`)

### Layout
- Same two-column book layout as config
- Top banner (amber): "Launching UAS first. UAC will start automatically when UAS is ready."
- UAS panel active (full opacity), UAC panel greyed out (opacity-40) initially

### PrePhasePanel

**UAS side — 5 checklist items:**
```
○ → ✅  REGISTER complete: N/N OK, 0 failed
○ → ✅  SUBSCRIBE complete: N/N OK, 0 failed
○ → ✅  ALL EXTENSIONS READY — N registered, N subscribed
○ → ✅  UAS auto-answer started for N extensions        ← UAS ONLY
○ → ✅  UAS auto-answer mode active on N extensions     ← UAS ONLY
```

**UAC side — 3 checklist items (no auto-answer lines ever):**
```
○ → ✅  REGISTER complete: N/N OK, 0 failed
○ → ✅  SUBSCRIBE complete: N/N OK, 0 failed
○ → ✅  ALL EXTENSIONS READY — N registered, N subscribed
```

### ChecklistItem states
- pending:  grey circle dot, static
- checking: animated spinning arc (CSS), amber color
- ok:       green ✅, Framer Motion scale-in bounce
- failed:   red ✗, shows raw log line below in monospace font

### Sequence
1. UAS process starts → poll log file for UAS ready lines
2. Initial sleep: 10–12 seconds before beginning log polling
3. Each log line matched → that ChecklistItem transitions to ok
4. N is dynamic — parse count from the log line text, do not hardcode 10
5. All 5 UAS items green → UAC panel opacity animates to full
6. Show `LaunchCountdown`: animated SVG ring counting down 3s
   Text: "All UAS extensions ready — Starting UAC…"
7. UAC process starts → poll for UAC ready lines (no sleep needed, start polling immediately)
8. All 3 UAC items green → auto-navigate to /run

### On failure
- Failed item → red, log line shown beneath in mono
- "Retry" button appears for that side only
- Do not restart the other side

### MOCK_MODE behavior
- Simulate 500ms delay between each checklist item resolving
- UAS items resolve first, then countdown, then UAC items
- Auto-navigate to /run after all items green

---

## Screen 3 — Live Traffic Dashboard (`/run`, phase = TRAFFIC)

### Row 1 — Hero (full width)
```
┌─────────────────────────────────────────────────────────────┐
│   ASR  92.4%  🟡                        RUN TIME  9m 12s   │
│   ████████████████████░░░░░░  (animated fill bar)          │
│   threshold: >95% green · 80–95% amber · <80% red          │
└─────────────────────────────────────────────────────────────┘
```

### Row 2 — VM Cards side by side

**UAC card:**
```
UAC  uac-local                              ● TRAFFIC
─────────────────────────────────────────
Attempted      20        Completed    19
Failed          1 🔴     PDD avg    143ms
CPS         ●───────── 5.98 / 6 configured
Hold avg    10.0s       Sockets       10
```

**UAS card:**
```
UAS  uas-local                              ● TRAFFIC
─────────────────────────────────────────
Answered       19        Failed         0
ASR          100% 🟢    Registered  10/10
Sockets        10
```

### Row 3 — Charts
- `LiveChart`: Tremor AreaChart, dual series (completed, failed), 60s rolling window
  WS-fed. Dark background, no white. Series colors: emerald-400 + rose-500
- `ConcurrentCallsBar`: horizontal progress bar
  Label: "Concurrent Calls  1,074 / 1,080"
  Red pulsing glow if >95% of ceiling

### WebSocket behavior
- Connect on /run page mount using `lib/ws.ts`
- Auto-reconnect: exponential backoff 1s → 2s → 4s → 8s → max 30s
- Navbar status dot: green=live, amber=reconnecting, red=disconnected
- On disconnect: subtle top banner "Reconnecting to metrics stream…" — charts freeze but don't reset
- MOCK_MODE: simulate metrics updating every 2s, auto-transition to COMPLETE after ~20 updates

---

## Screen 4 — Post-Run Summary (`/run`, phase = COMPLETE or FAILED)

Same `/run` page — switches view based on Zustand `phase`.

### SummaryCard
```
┌─────────────────────────────────────────────────────────┐
│  RUN COMPLETE                                           │
│                                                         │
│  UAC  ✅ exit 0              UAS  ✅ exit 0            │
│  Duration: 45.2s             Run ID: run-20260313-xxxx  │
│                                                         │
│  Total Attempted  20     Total Completed  19            │
│  Total Failed      1     Aggregate ASR   95.0% 🟢       │
│                                                         │
│  Log files:                                             │
│  traffic_uac-local_<timestamp>.log                      │
│  traffic_summary_uac-local_<timestamp>.log              │
│  traffic_uas-local_<timestamp>.log                      │
│  traffic_summary_uas-local_<timestamp>.log              │
└─────────────────────────────────────────────────────────┘
```

### FailureAnalysis card (only shown on phase = FAILED)
Shown between SummaryCard and CallTable:
```
ROOT CAUSE (most likely):
  → <parsed from logs>

SUPPORTING EVIDENCE (correlated by timestamp):
  [HH:MM:SS] UAS: <log line>
  [HH:MM:SS] UAC: <log line>

RECOMMENDATION:
  → <one actionable line>
```

### CallTable
Columns: `#` | `UAC ext` | `UAS ext` | `Result` | `PDD ms` | `Hold ms` | `Media` | `Reason`
- Result: green COMPLETED / red FAILED badge
- Media: MEDIA_VERIFIED ✅ / MEDIA_PARTIAL 🟡 / MEDIA_FAILED 🔴 / NO_MEDIA —
- Default 20 rows, paginate beyond
- Sortable by Result and PDD ms
- Log lines font: Space Mono

---

## Mock Data Layer (`lib/mock-data.ts`)

Create complete mock matching ALL types:
- 10 extensions, smoke mode, 20 calls, 19 completed, 1 failed (404 on ext 4001008)
- ASR 95%, avg_pdd_ms 145, avg_hold_ms 10000
- 20 CallEvent rows: 18 MEDIA_VERIFIED, 1 MEDIA_PARTIAL, 1 MEDIA_FAILED
- Full PrePhaseStatus: UAS with all 5 items, UAC with 3 items
- metricsHistory: 30 data points simulating a smooth traffic run

MOCK_MODE behavior (NEXT_PUBLIC_MOCK_MODE=true):
- Mode selector works normally (Local → /config)
- Config screen: prefill with realistic values, reachability check returns green after 800ms
- Validate: always passes instantly
- Save & Continue: succeeds after 600ms delay
- Launch: checklist items resolve with 500ms stagger, countdown fires, auto-navigates to /run
- Dashboard: metrics update every 2s, after ~20 updates phase switches to COMPLETE
- Post-run: shows SummaryCard + full mock CallTable

---

## .env.local

```
NEXT_PUBLIC_COORDINATOR_URL=http://localhost:8082
NEXT_PUBLIC_MOCK_MODE=true
```

---

## Do NOT do any of the following
- Do not modify anything in `callflow_tool/`
- Do not create a separate CSS file — all styling via Tailwind classes + globals.css
- Do not use `pages/` router — App Router only
- Do not use `localStorage` — Zustand in-memory only
- Do not add Redux, React Query, or Axios — Zustand + native fetch/WS only
- Do not use HSL color values — oklch only in globals.css
- Do not hardcode extension counts — always parse N dynamically from log lines
- Do not show UAS auto-answer lines on UAC pre-phase panel — ever
- Do not use Inter or Roboto — use DM Sans + Space Mono only
