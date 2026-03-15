# GUI ↔ Backend Integration — Analysis & Plan

> **Date:** 2026-03-15
> **Context:** SBCAutomationTool — CCI Traffic Dashboard (Next.js GUI) + Python FastAPI backend
> **Target:** Monday demo readiness on local mode (same machine)

---

## Table of Contents

1. [Architecture: How GUI and Backend Relate Today](#1-architecture)
2. [Topic 1 — Port Correlation from Real Logs](#2-port-correlation)
3. [Topic 2 — WebSocket: What Works, What's Broken](#3-websocket)
4. [Topic 3 — REST Endpoints: Which Are Used and Where](#4-endpoints)
5. [Topic 4 — Dashboard + PostRun Component Audit](#5-component-audit)
6. [Topic 5 — Answers to Integration Questions](#6-answers)
7. [Monday Demo Workflow — START/STOP Buttons](#7-demo-workflow)
8. [Recommended Fixes — Ordered Implementation Plan](#8-fixes)

---

## 1. Architecture: How GUI and Backend Relate Today <a name="1-architecture"></a>

### The Core Fact: FastAPI and Traffic Are One Process

When you run `python -m callflow_tool.traffic.main --config uac.yaml`, a **single Python process** starts with **one asyncio event loop** running everything concurrently:

```
One Python Process (uac)
├── uvicorn (FastAPI)  ─── asyncio task ─── port 8082
├── MetricsCollector   ─── asyncio task ─── shared memory
├── ExtensionAgents    ─── asyncio tasks ── SIP sockets
├── PrePhase engine    ─── asyncio tasks ── REGISTER / SUBSCRIBE
└── CallEngine         ─── asyncio task ─── INVITE / BYE
```

The metrics server and traffic engine share the **same `MetricsCollector` object in memory**. The FastAPI `/metrics` endpoint reads live counters that `CallEngine` writes to in real time. There is no IPC, no pipes, no shared files.

From `callflow_tool/traffic/metrics.py` design note:
> **FastAPI in-process** — No separate monitoring process. Shares the asyncio event loop.

### Current Local Mode Layout (Monday Demo)

```
Machine (Windows/Ubuntu laptop)
│
├── Terminal 1:  bun dev                                          → GUI on port 3000
│
├── Terminal 2:  python -m callflow_tool.traffic.main --config uas.yaml
│                  └─ FastAPI :8081 + UAS (REGISTER → auto-answer)
│
└── Terminal 3:  python -m callflow_tool.traffic.main --config uac.yaml
                   └─ FastAPI :8082 + UAC (REGISTER → INVITE → BYE)
```

### What the GUI Does Today

- **Config screen (`/config`):** Saves config to Zustand (browser memory). Does NOT call any backend API.
- **Launch screen (`/launch`):** In MOCK_MODE simulates pre-phase. In live mode, **has no backend integration** — sits idle.
- **Run screen (`/run`):** Connects WebSocket to UAC FastAPI (port 8082 only). Displays live metrics. Transitions to post-run on phase change.
- **Post-run:** Reads `callEvents` and `aggregate` from Zustand. In live mode, **both are empty** — nothing renders.

---

## 2. Topic 1 — Port Correlation from Real Logs <a name="2-port-correlation"></a>

### Source Data

From `logs/traffic_summary_uac-local_20260314_122347.log` and `logs/traffic_summary_uas-local_20260314_122347.log`.

### Ephemeral SIP Ports (per extension, stable for whole run)

These are the persistent TCP sockets — one per extension, alive for the entire run:

```
UAC side:  ext 4001000 → port 9940   |  UAS side:  ext 4001005 → port 1915
           ext 4001001 → port 9942   |             ext 4001006 → port 1917
           ext 4001002 → port 9944   |             ext 4001007 → port 1919
           ext 4001003 → port 9946   |             ext 4001008 → port 1921
           ext 4001004 → port 9948   |             ext 4001009 → port 1923
```

Ports are sequential/even because the OS allocates them in order. They stay stable unless a TCP reconnection happens (network blip, keep-alive expiry), in which case the extension gets a new port. In a multi-hour BHCC run, occasional reconnects are expected.

### RTP Ports (new UDP port per call, closed when call ends)

Wrap 1 — UAC opened port, UAS opened port (same machine so OS sequential):

```
Call Pair            UAC Port → UAS Port   Delta
4001000→4001005      57085   →  57086       +1 ✅
4001001→4001006      52170   →  52171       +1 ✅
4001002→4001007      51109   →  62966       +11857 ❌ (exception)
4001003→4001008      57611   →  57612       +1 ✅
4001004→4001009      57613   →  57614       +1 ✅
```

The `+1` pattern holds only because both processes are on the same machine — the OS issues ephemeral ports sequentially. The 51109→62966 exception is timing jitter (another socket was allocated between the two by the OS). **This pattern disappears entirely on separate VMs** — each machine has its own port pool.

Wrap 2 — all new RTP ports:

```
4001000→4001005      49914   →  49915       +1
4001001→4001006      63692   →  63693       +1
4001002→4001007      63694   →  63695       +1
4001003→4001008      63696   →  63697       +1
4001004→4001009      63698   →  63699       +1
```

### What's Available for GUI Display

| Data                        | Available Now?                                   | At Scale (21,600 calls)? | Backend Change? |
|-----------------------------|--------------------------------------------------|--------------------------|-----------------|
| UAC ext → UAS ext pairing   | ✅ in `CallEvent` (`uac_ext`, `uas_ext`)         | Pairing matrix, not rows | None            |
| Pool wrap grouping           | `pool_wrap_index` on `CallResult` only (Python)  | Per-wrap summary cards   | Add to CallEvent |
| UAC RTP port per call        | `rtp_local_port` in `CallResult` — NOT in `CallEvent` | Needs backend addition | Add to API/types |
| UAS RTP port per call        | **Not exposed** — UAS knows only its own ports   | Cross-process join       | New endpoint    |
| Ephemeral SIP ports          | Only in summary log file, not in any API         | Needs new endpoint       | New endpoint    |

### Recommendation

- **Do now:** Pairing matrix (which UAC ext called which UAS ext, frequency) — zero backend changes, high demo value.
- **Do now if small:** Pool wrap grouping in CallTable — add `pool_wrap_index` to `CallEvent`.
- **Defer to Phase 2:** RTP port per-call correlation — requires non-trivial cross-process data joining. The correlation is useful for single-call debugging, not useful at 21,600-call scale.
- **Defer to Phase 2:** Ephemeral SIP port table — add `GET /api/extensions` endpoint.

---

## 3. Topic 2 — WebSocket: What Works, What's Broken <a name="3-websocket"></a>

### What `gui/lib/ws.ts` Does Correctly

- `MetricsStream` class handles full lifecycle: connect, reconnect with exponential backoff (1s → 2s → 4s → 8s → 16s → 30s cap), disconnect.
- `useMetricsStream` React hook ties WS lifecycle to component mount/unmount.
- Handles both single-object and array responses: `Array.isArray(data) ? data : [data]`.
- `run/page.tsx` already calls `useMetricsStream(..., !IS_MOCK)` — correctly disabled in mock mode.

### Critical Bug: Single WS, One Backend Only

```typescript
// ws.ts line 6 — hardcoded to one URL
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/api/metrics/stream'
//             ↑ NEXT_PUBLIC_COORDINATOR_URL = http://localhost:8082 (UAC only)
```

The backend pushes **one VM's metrics** per WS connection. UAS (port 8081) has its own independent WS endpoint. The GUI only connects to UAC's WS.

In `run/page.tsx`:

```typescript
onMetrics: (metrics) => {
  const uac = metrics.find((m) => m.vm_id.startsWith('uac'))
  const uas = metrics.find((m) => m.vm_id.startsWith('uas'))
  if (uac && uas) updateMetrics(uac, uas)      // ← never fires: WS only sends ONE VM
  else if (uac) updateMetrics(uac, uac)          // ← THIS fires: UAS card shows UAC data!
},
```

**Result:** UAS VMMetricsCard in live mode shows UAC metrics (duplicate).

### Backend WS Behavior (per `callflow_tool/traffic/metrics.py`)

Each FastAPI server pushes via `run_push_loop()` every `metrics_interval` seconds. The WS sends a single `TrafficMetrics` JSON object (not an array). The client wraps it: `Array.isArray(data) ? data : [data]` → always `[single_metric]`.

### What Needs to Change

The GUI must open **two** WebSocket connections — one to UAC (:8082), one to UAS (:8081). Both URLs are derivable from the pair config already stored in Zustand.

---

## 4. Topic 3 — REST Endpoints: Which Are Used and Where <a name="4-endpoints"></a>

### Endpoints Defined in `gui/lib/api.ts`

| Function            | Endpoint               | Method | Called Anywhere? |
|---------------------|------------------------|--------|------------------|
| `checkHealth()`     | `/api/ping`            | GET    | ✅ VMPairBook (reachability check) |
| `startTest()`       | `/api/test/start`      | POST   | ❌ Never called  |
| `stopTest()`        | `/api/test/stop`       | POST   | ❌ Never called  |
| `getTestStatus()`   | `/api/test/status`     | GET    | ❌ Never called  |
| `putConfig()`       | `/api/config`          | PUT    | ❌ Never called  |
| `getMetrics()`      | `/api/metrics`         | GET    | ❌ Never called  |
| `getVMs()`          | `/api/vms`             | GET    | ❌ Never called  |

### Consequences

1. **Phase never transitions in live mode.** Phase is stuck at `IDLE` in Zustand. The `/run` page shows "Waiting for traffic phase to start…" forever. Nobody calls `GET /api/test/status` to detect that traffic is already running.
2. **Post-run data never appears.** No code fetches call events or aggregate metrics from the backend. `callEvents` and `aggregate` stay as `[]` and `null` in Zustand.
3. **`GET /api/metrics` is never used.** It exists as a one-shot polling alternative to WS but is unused. Could be useful as a fallback.

### Endpoints Live on FastAPI Backend

| Endpoint               | Method | Status | What It Returns |
|------------------------|--------|--------|-----------------|
| `GET /api/ping`        | GET    | ✅ Live | `{ reachable: true, vm_id, role, phase }` |
| `GET /metrics`         | GET    | ✅ Live | Full `TrafficMetrics` snapshot (JSON) |
| `WS /metrics/stream`   | WS     | ✅ Live | Pushes `TrafficMetrics` every `metrics_interval` seconds |
| `GET /api/test/status`  | GET    | ✅ Live | `{ phase, running, elapsed_seconds, vm_id }` |
| `POST /api/test/start`  | POST   | ✅ Stub | Returns `"accepted"` — no real action |
| `POST /api/test/stop`   | POST   | ✅ Live | Triggers graceful shutdown (sets stop_event) |
| `GET /api/vms`          | GET    | ✅ Live | VM info array: `[{ vm_id, role, ext_range, status, cps, asr }]` |
| `GET /api/calls`        | —      | ❌ Missing | Call event list — NOT IMPLEMENTED |
| `PUT /api/config`       | —      | ❌ Missing | Config push from GUI — NOT IMPLEMENTED |
| `GET /api/extensions`   | —      | ❌ Missing | Extension → SIP port map — NOT IMPLEMENTED |

---

## 5. Topic 4 — Dashboard + PostRun Component Audit <a name="5-component-audit"></a>

### Dashboard Components (Screen 3 — TRAFFIC Phase)

| Component             | Data Source                    | Mock Mode | Live Mode Status |
|-----------------------|--------------------------------|-----------|------------------|
| `ASRGauge`            | `uacMetrics.asr`               | ✅ Works  | ⚠️ Shows UAC ASR only |
| `RunTimer`            | `uacMetrics.run_elapsed_seconds`| ✅ Works | ⚠️ UAC time only |
| `AggregatePanel`      | `uacMetrics.*`                 | ✅ Works  | ⚠️ UAC only |
| `VMMetricsCard` (UAC) | `uacMetrics`                   | ✅ Works  | ✅ Correct (single WS) |
| `VMMetricsCard` (UAS) | `uasMetrics`                   | ✅ Works  | ❌ Shows UAC data (duplicate) |
| `LiveChart`           | `metricsHistory` (Zustand)     | ✅ Works  | ⚠️ Updates only from UAC WS |
| `ConcurrentCallsBar`  | `uacMetrics.concurrent_calls`  | ✅ Works  | ⚠️ UAC concurrent only |
| `CPSGauge`            | (exists but unused in /run)    | —         | — |

### PostRun Components (Screen 4 — COMPLETE/FAILED Phase)

| Component           | Data Source              | Mock Mode | Live Mode Status |
|---------------------|--------------------------|-----------|------------------|
| `SummaryCard`       | `aggregate` (Zustand)    | ✅ Works  | ❌ `aggregate` is null → renders nothing |
| `CallTable`         | `callEvents` (Zustand)   | ✅ Works  | ❌ `callEvents` is [] → renders nothing |
| `FailureAnalysis`   | `phase === 'FAILED'` + events | ✅ Works | ❌ Phase never reaches FAILED |
| `DownloadReport`    | `aggregate + callEvents` | ✅ Works  | ❌ Both empty → empty JSON download |

### Root Cause of All PostRun Failures in Live Mode

There is no `GET /api/calls` endpoint in the backend. The backend writes call events to the summary log file (`write_traffic_summary()`) but never exposes them over HTTP. `CallEvent` data never reaches the GUI. Additionally, there is no code to build `AggregateMetrics` from live data — it's only created in mock mode.

### Navbar Integration

`Navbar.tsx` displays:
- Phase badge: reads from `Zustand.phase` — shows "Idle" forever in live mode (phase never set)
- WS dot: reads from `Zustand.wsStatus` — green/amber/red based on UAC WS connection

Both work correctly once the underlying data issues are fixed (phase detection + dual WS).

---

## 6. Topic 5 — Answers to Integration Questions <a name="6-answers"></a>

### Q1: Which endpoints are already live on FastAPI?

See [Section 4 table above](#4-endpoints). Summary:
- **6 endpoints live** (`/api/ping`, `/metrics`, `/metrics/stream` WS, `/api/test/status`, `/api/test/start` stub, `/api/test/stop`, `/api/vms`)
- **3 endpoints missing** (`/api/calls`, `PUT /api/config`, `/api/extensions`)

### Q2: Is the coordinator on the same machine as the GUI?

**Yes — local mode.** Both FastAPI processes (8081 for UAS, 8082 for UAC) and the Next.js GUI (port 3000) run on the same Windows laptop or Ubuntu VM. This is the Monday demo setup. Multi-VM mode is Phase 2.

### Q3: Real WS metrics first or config POST first?

**WS metrics first.** The config screen already works (saves to Zustand). The critical path for the Monday demo is:

```
Config (already works) → Launch (needs START trigger) → Running (needs dual WS + phase detection) → Complete (needs /api/calls endpoint)
```

`PUT /api/config` is a Phase 2 concern — it's needed only when the GUI remotely deploys config to VMs. In local mode the operator writes YAML files manually.

### Correct Order for Backend Integration (Without Breaking Mock)

The mock flow (MOCK_MODE=true) works perfectly today: Config → Launch → Run → Complete, all simulated in-browser. Every integration change below MUST preserve mock mode. The pattern is: gate all live-mode code behind `if (!IS_MOCK)` checks.

**Tier 1 — Critical for Monday demo (pure frontend, zero backend changes):**

1. **FIX A — Dual WebSocket.** Connect to both UAC and UAS WebSocket endpoints. This makes the UAS VMMetricsCard show real UAS data instead of duplicated UAC data.

2. **FIX B — Phase detection via polling.** On `/run` mount (live mode), call `GET /api/test/status` on both UAC and UAS backends. If either returns `phase: "TRAFFIC"`, set Zustand phase to `TRAFFIC`. Poll every 5s until phase transitions to `DONE`/`STOPPING`.

**Tier 2 — Required for post-run screen (small backend + frontend change):**

3. **New endpoint: `GET /api/calls`** — Add to `callflow_tool/traffic/metrics.py`. Return the `collector._call_results` list as serializable dicts with fields matching the `CallEvent` TypeScript type. This unblocks `CallTable`, `FailureAnalysis`, and `DownloadReport` in live mode.

4. **Phase transition handling.** When polling detects `phase=DONE`, call `GET /api/calls` on both UAC and UAS, merge results, compute `AggregateMetrics`, store both in Zustand, then set `phase='COMPLETE'`.

**Tier 3 — Post-run enhancements (after demo is solid):**

5. **Pairing matrix card.** Purely frontend — uses existing `CallEvent.uac_ext` / `uas_ext` to show which UAC extension called which UAS extension, grouped by pool wrap.

6. **`pool_wrap_index` in CallEvent.** Small backend change — add wrap index to `CallResult` → expose in `/api/calls`.

7. **Ephemeral SIP port table.** Add `GET /api/extensions` to FastAPI, returning `{ ext → sip_port }` dict from live `ExtensionAgent` objects.

---

## 7. Monday Demo Workflow — START/STOP Buttons <a name="7-demo-workflow"></a>

### The Problem

Today's GUI flow assumes the Python processes are already running when the user navigates from Config to Launch. There is no explicit trigger from the GUI that says "I'm ready, start polling." The user saves config, clicks "Save & Continue", and arrives at `/launch` which either:
- **Mock mode:** Auto-simulates pre-phase checklist.
- **Live mode:** Does nothing — sits with all items in `pending` state forever.

For Monday's demo, we need a clear workflow where the operator:
1. Configures UAC + UAS on the Config screen
2. Manually starts UAS and UAC Python processes in terminals
3. Clicks a **Start** button on the GUI to begin polling the backends
4. Watches pre-phase progress (REGISTER → SUBSCRIBE → READY)
5. Sees live traffic metrics during the TRAFFIC phase
6. Has a **Stop** button to gracefully shut down both processes
7. Views post-run summary after completion

### Proposed Button Placement and Behavior

#### Launch Screen (`/launch`)

**"Start Monitoring" button** — appears at top of PrePhasePanel, between the amber banner and the two-column checklist:

- Label: `▶ Start Monitoring` (or `▶ Connect to Backends`)
- Before click: checklist shows all items as `pending`, both panels greyed out
- On click:
  1. Calls `GET /api/ping` on both UAC (`vm_ip:metrics_port`) and UAS (`vm_ip:metrics_port`) — uses the values from the Zustand pair config
  2. If both reachable: starts polling `GET /api/test/status` every 3s on both backends
  3. Maps backend phase strings to checklist items:
     - `PRE_REGISTER` → register item → `checking` (spinner)
     - Backend reports `registered_count: N/N` → register item → `ok`
     - Similarly for SUBSCRIBE, EXTENSIONS_READY, AUTO_ANSWER
  4. When UAS reports all ready → countdown → activate UAC panel
  5. When UAC reports all ready → auto-navigate to `/run`
  6. If either backend is unreachable: show red error below button, do not start polling

- If one backend is unreachable, show which one failed and allow retry.

#### Run Screen (`/run`) — TRAFFIC phase

**"Stop Traffic" button** — in the hero row, right side, next to RunTimer:

- Label: `⏹ Stop Traffic`
- On click:
  1. `POST /api/test/stop` to UAC backend (UAC's shutdown handler will also POST to UAS's peer_stop_url)
  2. Button changes to `Stopping…` (disabled, spinner)
  3. Continue polling — when phase transitions to DONE/STOPPING on both backends, proceed to post-run
  4. If the user started UAC+UAS manually, `POST /api/test/stop` to UAC triggers the full graceful shutdown chain (UAC stops firing INVITEs → drains calls → unregisters → POST to UAS peer_stop_url → UAS shuts down)

**Alternative (simpler for demo):** If the user kills the Python processes manually with `Ctrl+C`, the WS connection drops, phase eventually reads as DONE when reconnect succeeds or status poll returns it. The GUI handles this via the existing reconnect banner.

#### Post-Run Screen (`/run`, phase=COMPLETE)

**"New Run" button** — in DownloadReport area:

- Resets Zustand, navigates back to `/config`
- Existing `reset()` in the store handles this

### What This Does NOT Require

- No `PUT /api/config` endpoint — operator writes YAML manually
- No subprocess spawning from GUI — operator runs Python in terminals
- No SSH connectivity — single machine, all localhost

### Implementation Notes

- All new buttons are frontend-only — they call existing backend endpoints (`/api/ping`, `/api/test/status`, `/api/test/stop`)
- Mock mode must still work exactly as before — gate all live polling behind `!IS_MOCK`
- The "Start Monitoring" button is the **key new UX element** — it bridges the gap between "I configured everything" and "show me what the backends are doing"

---

## 8. Recommended Fixes — Ordered Implementation Plan <a name="8-fixes"></a>

### FIX A — Dual WebSocket Connection

**What:** Connect to both UAC and UAS WebSocket endpoints simultaneously.

**Why:** Currently `ws.ts` hardcodes `WS_URL` from `NEXT_PUBLIC_COORDINATOR_URL` (port 8082 = UAC only). UAS metrics never arrive. The UAS VMMetricsCard shows duplicated UAC data.

**How:**
- Modify `ws.ts` to accept a URL parameter (instead of module-level constant)
- In `run/page.tsx`, instantiate two `MetricsStream` objects:
  - UAC: `ws://localhost:8082/metrics/stream` (derived from `pair.uac.vm_ip:pair.uac.metrics_port`)
  - UAS: `ws://localhost:8081/metrics/stream` (derived from `pair.uas.vm_ip:pair.uas.metrics_port`)
- UAC stream → `onMetrics` → `updateMetrics(uac, ...)` 
- UAS stream → `onMetrics` → `updateMetrics(..., uas)`
- Navbar WS dot: green only when BOTH are connected; amber if either is reconnecting

**Mock mode impact:** None — `useMetricsStream` is already gated by `!IS_MOCK`.

**Files changed:** `gui/lib/ws.ts`, `gui/app/run/page.tsx`

---

### FIX B — Phase Detection via `GET /api/test/status` Polling

**What:** On `/run` page mount (live mode), poll both backends' status to detect and track phase transitions.

**Why:** In live mode, Zustand `phase` stays `IDLE` forever. The page shows "Waiting for traffic phase to start…" even when both backends are actively in TRAFFIC phase with calls flying.

**How:**
- In `run/page.tsx`, add a `useEffect` (gated by `!IS_MOCK`):
  1. On mount, call `GET /api/test/status` on both UAC and UAS using their `vm_ip:metrics_port`
  2. If either returns `phase: "TRAFFIC"` and `running: true`, call `setPhase('TRAFFIC')`
  3. Repeat every 5 seconds
  4. When status returns `phase: "DONE"` or `phase: "STOPPING"`:
     - Fetch call events (once `GET /api/calls` exists in Tier 2)
     - Compute aggregate metrics
     - `setPhase('COMPLETE')`
  5. Clean up interval on unmount

**Mock mode impact:** None — polling only runs when `!IS_MOCK`.

**Files changed:** `gui/app/run/page.tsx`, `gui/lib/api.ts` (add `getTestStatusFor(ip, port)` variant)

---

### FIX C — "Start Monitoring" Button on Launch Screen

**What:** Add a trigger button on `/launch` that starts polling backends for pre-phase progress.

**Why:** In live mode, the PrePhasePanel sits with all items in `pending` state. There's no trigger to start reading backend status. The operator needs a clear "go" button after they've started the Python processes.

**How:**
- Add a state `monitoringStarted: boolean` to PrePhasePanel
- Show a `▶ Start Monitoring` button when `!isMock && !monitoringStarted`
- On click: verify both backends are reachable (`GET /api/ping`), then start polling `GET /api/test/status` every 3s
- Map backend phase/counts to checklist items
- Once both sides report ready → proceed with countdown → navigate to `/run`

**Mock mode impact:** None — mock mode auto-starts simulation on mount as before.

**Files changed:** `gui/components/launch/PrePhasePanel.tsx`, `gui/lib/api.ts`

---

### FIX D — "Stop Traffic" Button on Run Screen

**What:** Add a button on the live dashboard to trigger graceful shutdown.

**Why:** The operator needs a way to stop traffic from the GUI. Currently the only way is `Ctrl+C` in the terminal or `curl -X POST http://localhost:8082/api/test/stop`.

**How:**
- Add `⏹ Stop Traffic` button in the hero row of `LiveDashboard` (next to RunTimer)
- On click: `POST /api/test/stop` to UAC backend (which cascades to UAS via `peer_stop_url`)
- Button state: idle → "Stopping…" (disabled) → hidden when phase is COMPLETE

**Mock mode impact:** None — button only shown in live mode, or triggers `setPhase('COMPLETE')` in mock.

**Files changed:** `gui/app/run/page.tsx`

---

### FIX E — `GET /api/calls` Backend Endpoint (Tier 2)

**What:** New endpoint on FastAPI to return call event data.

**Why:** `CallTable`, `FailureAnalysis`, and `DownloadReport` all read `callEvents` from Zustand. In live mode, this array is never populated because no endpoint provides it.

**How (backend):**
- In `callflow_tool/traffic/metrics.py`, add `GET /api/calls`:
  ```python
  @app.get("/api/calls")
  async def get_calls():
      results = collector._call_results
      return [
          {
              "call_id": f"call-{i:04d}",
              "uac_ext": str(getattr(r, "caller", "")),
              "uas_ext": str(getattr(r, "callee", "")),
              "result": "COMPLETED" if r.success else "FAILED",
              "failure_reason": getattr(r, "failure_reason", None),
              "pdd_ms": r.pdd_ms or 0,
              "hold_ms": r.hold_ms or 0,
              "media_status": "MEDIA_VERIFIED" if getattr(r, "media_verified", False) else "NO_MEDIA",
              "rtp_tx_pkts": getattr(r, "rtp_tx_pkts", None),
              "rtp_rx_pkts": getattr(r, "rtp_rx_pkts", None),
              "timestamp": ...,
          }
          for i, r in enumerate(results)
      ]
  ```

**How (frontend):**
- Add `getCallsFor(ip, port)` to `gui/lib/api.ts`
- When phase transitions to COMPLETE (in Fix B's polling), call `/api/calls` on both UAC and UAS, merge, store in Zustand

**Files changed:** `callflow_tool/traffic/metrics.py`, `gui/lib/api.ts`, `gui/app/run/page.tsx`

---

### Implementation Order

```
Priority  Fix   Description                        Backend?  Mock Safe?
──────────────────────────────────────────────────────────────────────
   1      A     Dual WebSocket                     No        ✅
   2      B     Phase detection (status polling)    No        ✅
   3      C     "Start Monitoring" button (Launch)  No        ✅
   4      D     "Stop Traffic" button (Run)         No        ✅
   5      E     GET /api/calls endpoint             Yes       ✅
```

Fixes A–D are pure frontend changes using endpoints that already exist. They can be shipped together for Monday. Fix E requires a backend addition and is needed for post-run to render real data.

---

## Appendix: Environment for Monday Demo

```
# .env.local (set to false for live demo)
NEXT_PUBLIC_COORDINATOR_URL=http://localhost:8082
NEXT_PUBLIC_MOCK_MODE=false

# Terminal 1 — GUI
cd gui && bun dev

# Terminal 2 — UAS backend (start first)
python -m callflow_tool.traffic.main --config uas.yaml

# Terminal 3 — UAC backend (start after UAS ready)
python -m callflow_tool.traffic.main --config uac.yaml
```

The GUI's Config screen prefills from Zustand defaults matching `uac.yaml` / `uas.yaml`. Save & Continue → Launch → click "Start Monitoring" → watch pre-phase → auto-navigate to Run → see live metrics → click "Stop Traffic" or wait for smoke mode to complete → post-run summary.
