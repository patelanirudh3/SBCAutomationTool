# Phase 0 — Codebase Analysis Report: CCI Traffic Engine

> **Status:** Post-Phase-1 implementation. This document reflects the current working codebase after code restructuring, GUI integration, and traffic engine rewrites.
> **Purpose:** Reference for Phase 2 (Python → GoLang migration of critical paths).

---

## 1. Architecture Map (Current)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    NEXT.JS GUI  (gui/)                                  │
│  app/config/page.tsx   ←→  VMPairBook / VMConfigPanel / AdvancedSettings│
│  app/launch/page.tsx   ←→  PrePhasePanel / LaunchCountdown             │
│  app/run/page.tsx      ←→  Dashboard (CPSGauge, ASRGauge, LiveChart)   │
│  Zustand store         ←→  store/traffic.ts                            │
│  lib/ws.ts             ←→  WebSocket to FastAPI /metrics/stream        │
│  lib/api.ts            ←→  REST to FastAPI /api/*                      │
│                             (port 3000 — bun dev)                      │
└────────────┬──────────────────────────────────────────────────────────┘
             │  REST + WebSocket
             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│         PYTHON TRAFFIC ENGINE  (callflow_tool/traffic/)                 │
│                                                                         │
│  main.py          ─ CLI entrypoint, lifecycle orchestrator              │
│  config.py        ─ VMConfig dataclass (env → yaml → defaults)         │
│  extension_agent  ─ One per SIP extension, owns persistent socket      │
│  sip_engine.py    ─ AsyncSipTransport (TCP/TLS/UDP via asyncio)        │
│  call_engine.py   ─ CallEngine (UAC) + UasAutoAnswer (UAS)             │
│  pre_phase.py     ─ Bulk REGISTER + SUBSCRIBE barriers                 │
│  rtp_stream.py    ─ RtpEndpoint (UDP, G.711 PCMU, 3-phase)            │
│  metrics.py       ─ MetricsCollector + FastAPI server (uvicorn)        │
│                     (port from config: 8081 UAS / 8082 UAC)            │
└────────────┬──────────────────────────────────────────────────────────┘
             │  SIP over TCP/TLS  +  RTP over UDP
             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                          SBC (Ribbon / Kamailio)                        │
└─────────────────────────────────────────────────────────────────────────┘
```

### Runtime Layout (Local Mode)

```
Machine (Windows/Ubuntu)
├── Terminal 1:  bun dev                               → GUI on :3000
├── Terminal 2:  python -m callflow_tool.traffic.main --api-only --port 8081
│                  └─ FastAPI :8081 + UAS auto-answer
└── Terminal 3:  python -m callflow_tool.traffic.main --api-only --port 8082
                   └─ FastAPI :8082 + UAC call engine
```

GUI-driven mode: processes start with `--api-only`, GUI sends config via `PUT /api/config`, triggers run via `POST /api/test/start`. CLI mode: processes load `--config uac.yaml` and run autonomously.

---

## 2. Code Flow: Startup → Registration → Traffic → Teardown

```
STARTUP  (main.py → run())
═══════
  1. Load VMConfig (env → yaml → defaults)
  2. Resolve local IP
  3. _create_agents() — one ExtensionAgent per extension
  4. Start all AsyncSipTransport connections (TCP/TLS persistent per ext)
  5. Start FastAPI metrics server (uvicorn, in-process, shared event loop)

PRE-PHASE  (pre_phase.py → run_pre_phase())
═════════
  6. Bulk REGISTER — rate-limited (config.register_rate/sec), retry on timeout
     REGISTER → 401 → REGISTER(Digest auth) → 200 OK
  7. Bulk SUBSCRIBE (optional, --skip-subscribe)
  8. asyncio.gather() barrier: ALL extensions must register before continuing
  9. Log "ALL EXTENSIONS READY"

TRAFFIC PHASE  (call_engine.py)
═════════════
  UAC (CallEngine.run()):
    Token-bucket CPS controller → fire INVITEs
    Linear ramp-up over ramp_up_seconds
    Pool wrap delay at every LCM boundary (see WRAP_HOLD_POOL_LOGIC.md)
    Per call (_execute_call):
      INVITE → 100 → 180 → PRACK → 200 PRACK
            → 200 OK → ACK → RTP 3-phase (hold_time) → BYE → 200 BYE
      Handles: 407 Proxy-Auth, final failures (4xx/5xx/6xx), timeouts
      If media_enabled=False: skip RTP, log MEDIA_DISABLED

  UAS (UasAutoAnswer):
    Each agent runs infinite loop listening for INVITE events
    On INVITE: 100 → 180(reliable) → wait PRACK → 200 PRACK
             → 200 OK(SDP answer) → wait ACK → RTP → wait BYE → 200 BYE

TEARDOWN  (main.py → _shutdown())
════════
  a. Stop call engine (no new INVITEs)
  b. Drain active calls (BYE + 200 OK, timeout)
  c. Unregister all extensions (REGISTER Expires=0)
  d. Close all transports
  e. Flush final metrics + write traffic summary
  f. GUI drain delay (keep server alive for final fetch)
  g. Exit 0
```

---

## 3. Directory Layout (Current)

```
cci-studio/
│
├── callflow_tool/
│   ├── traffic/                     ◄── CORE: Async traffic engine (Phase 1 rewrite)
│   │   ├── __init__.py
│   │   ├── main.py                  # CLI + lifecycle orchestrator (937 lines)
│   │   ├── config.py                # VMConfig dataclass + load/validate (412 lines)
│   │   ├── extension_agent.py       # Per-extension SIP agent + DialogState (1125 lines)
│   │   ├── sip_engine.py            # AsyncSipTransport: TCP/TLS/UDP (461 lines)
│   │   ├── call_engine.py           # CallEngine (UAC) + UasAutoAnswer (UAS) (905 lines)
│   │   ├── pre_phase.py             # Bulk REGISTER + SUBSCRIBE (346 lines)
│   │   ├── rtp_stream.py            # RtpEndpoint: UDP, G.711, 3-phase (396 lines)
│   │   └── metrics.py               # MetricsCollector + FastAPI server (981 lines)
│   │
│   ├── useragent/json/linoxiderepo/ ◄── LEGACY: Original SIP UA modules (still imported)
│   │   ├── sipmessage.py            # SipMessage data model (KEEP — imported by extension_agent)
│   │   ├── sipconstants.py          # Enums: methods, headers, states, codecs (KEEP)
│   │   ├── parserandbuilder.py      # SIP/SDP parse + build (KEEP — imported by extension_agent)
│   │   ├── authenticate.py          # Digest auth MD5 (KEEP — imported by extension_agent)
│   │   ├── sdp.py                   # SDP data model (KEEP)
│   │   ├── invite.py, bye.py        # SIP method helpers (KEEP — imported by extension_agent)
│   │   ├── prack.py, register.py    # SIP method helpers (KEEP)
│   │   ├── subscribe.py             # SUBSCRIBE helper (KEEP)
│   │   └── util.py                  # Tag/branch/Call-ID generators (KEEP)
│   │
│   ├── callflow/                    ◄── LEGACY: Flask orchestrator (not used in traffic path)
│   │   ├── js-sequence-diagrams-master/
│   │   │   ├── app.py               # Old Flask orchestrator
│   │   │   ├── config.py            # Old VM IPs/extensions
│   │   │   └── ServiceExecutor.py   # SBC REST API config (still useful)
│   │   └── homepage/
│   │
│   └── autoDeploy/                  ◄── VM deployment scripts
│
├── gui/                             ◄── NEXT.JS FRONTEND (Phase 1 new)
│   ├── app/
│   │   ├── page.tsx                 # Landing → redirects to /config
│   │   ├── config/page.tsx          # Config screen (VMPairBook)
│   │   ├── launch/page.tsx          # Pre-phase launch screen
│   │   ├── run/page.tsx             # Live traffic dashboard
│   │   └── layout.tsx               # Root layout + Navbar
│   ├── components/
│   │   ├── config/
│   │   │   ├── VMPairBook.tsx       # UAC+UAS card pair + sticky sidebar (30KB)
│   │   │   ├── VMConfigPanel.tsx    # Per-VM form: extensions, SIP, traffic (23KB)
│   │   │   ├── AdvancedSettings.tsx # Registration, RTP, wrap tuning (18KB)
│   │   │   ├── TrafficModeSelector  # smoke / timed / unlimited
│   │   │   └── ConfigValidator.tsx
│   │   ├── launch/                  # PrePhasePanel, LaunchCountdown, ChecklistItem
│   │   ├── dashboard/               # CPSGauge, ASRGauge, LiveChart, RunTimer, etc.
│   │   ├── postrun/                 # SummaryCard, CallTable, FailureAnalysis, DownloadReport
│   │   ├── layout/                  # Navbar, StepIndicator, SessionMenu
│   │   ├── mode/                    # ModeSelector (local / multi-vm)
│   │   └── ui/                      # Radix primitives: button, card, input, dialog, switch, etc.
│   ├── lib/
│   │   ├── api.ts                   # REST client: /api/config, /api/test/start|stop, /metrics
│   │   ├── ws.ts                    # WebSocket: /metrics/stream → live TrafficMetrics
│   │   ├── config-schema.ts         # Zod validation schema for VMConfig
│   │   ├── mock-data.ts             # Mock data for development
│   │   └── utils.ts
│   ├── store/traffic.ts             # Zustand: pairs, advancedSettings, runState
│   └── types/index.ts              # VMConfig, VMPair, AdvancedSettings, TrafficMetrics, etc.
│
├── sipp_scripts/                    ◄── EXTERNAL SIPp XML scenarios (100+, standalone)
├── SBCAutomation/                   ◄── SBC automation scripts
├── Scripts/                         ◄── DB wrapper, utilities
├── logs/                            ◄── Traffic run logs
├── samples/                         ◄── Sample YAML configs
├── template/                        ◄── Legacy Flask HTML templates
│
├── requirements.txt                 # Python deps
└── docs/                            # Project markdown documentation
    ├── WRAP_HOLD_POOL_LOGIC.md      # Wrap delay formula architecture
    ├── GUI_BACKEND_INTEGRATION.md     # GUI ↔ backend integration analysis
    ├── RTP_FLOW_REFERENCE.md          # RTP 3-phase design reference
    ├── PHASE1_5CALL_DESIGN.md         # Phase 1 design doc
    └── README.md                      # Overview + quick start
```

---

## 4. Traffic Engine — Module Responsibilities

### `config.py` — VMConfig

Dataclass with 30+ fields. Loading priority: ENV VAR → YAML → defaults. Bool coercion for YAML string values.

Key derived properties:
- `uac_ext_count` / `uas_ext_count` — from range
- `pool_wrap_count` — `LCM(uac, uas)` for wrap boundary
- `effective_max_concurrent` — `max_concurrent_calls` or `CPS × hold_time`

Key fields for Go migration:
```
vm_role, sbc_host, sbc_port, sip_transport, domain, sip_password,
uac_ext_start/end, uas_ext_start/end, cps, hold_time_seconds,
ramp_up_seconds, media_enabled, pool_wrap_delay_seconds,
traffic_mode (smoke/timed/unlimited), call_count, duration_hours
```

### `sip_engine.py` — AsyncSipTransport

Async replacements for the original blocking `transport.py` + `listenthread.py` + `messagebuffer.py`:

| Class | Transport | Key |
|-------|-----------|-----|
| `UdpSipTransport` | `asyncio.DatagramProtocol` | One UDP socket per extension |
| `TcpSipTransport` | `asyncio.StreamReader/Writer` | Persistent TCP/TLS per extension |

Message framing for TCP: CRLFCRLF + Content-Length, ported from `messagebuffer.py` to async StreamReader. TLS via `ssl.SSLContext`. `classify_message()` parses first line to determine SIP method or response code.

### `extension_agent.py` — ExtensionAgent + DialogState

One instance per extension number. Owns one persistent `AsyncSipTransport`. All SIP dialogs share the same socket.

`DialogState` — lightweight dataclass replacing `UASession` (60+ getter/setter Java-style methods → flat `@dataclass` with ~30 fields). Tracks: call_id, tags, CSeq, RSeq, route_set, SDP, RTP remote IP/port, timing milestones.

SIP message building delegates to legacy modules: `sipmessage.py`, `parserandbuilder.py`, `authenticate.py`, `invite.py`, `bye.py`, `prack.py`, `register.py`, `subscribe.py`, `util.py`.

Event routing: `_wait_for_event()` registers `asyncio.Queue` per expected SIP event. Incoming messages dispatched by `classify_message()` → matching queues. Wildcard listener for UAS INVITE handling.

### `call_engine.py` — CallEngine + UasAutoAnswer

**CallEngine (UAC):** CPS-controlled run loop with token-bucket timing, linear ramp-up, pool wrap delay (see `WRAP_HOLD_POOL_LOGIC.md`), extension pairing via `_next_pair()`. Per-call: `_execute_call()` — full INVITE→BYE sequence with 407 handling, timeouts, RTP gating, talk-path verification, structured JSON logging.

**UasAutoAnswer:** Each agent runs `_uas_loop()` listening on wildcard queue for INVITEs. On INVITE: `_handle_call()` — full UAS sequence (100→180→PRACK→200→ACK→RTP→BYE→200 BYE).

Media gating: `if config.media_enabled` gates `RtpEndpoint.create()` at exactly two points (UAC `_execute_call` + UAS `_handle_call`). When disabled, port 9 in SDP, `MEDIA_DISABLED` event logged.

### `rtp_stream.py` — RtpEndpoint

RFC 3550 RTP + G.711 PCMU (PT=0, 8000Hz, 20ms ptime, 160 bytes payload).

3-phase send pattern per call:
```
BURST_START  → rtp_burst_pps for rtp_burst_seconds  (establish path)
KEEPALIVE    → 1 pkt / rtp_keepalive_interval       (prevent SBC timeout)
BURST_END    → rtp_burst_pps for rtp_burst_seconds  (verify path pre-BYE)
```

UAC: `rtp_ep.run(duration=hold_time)` — blocks until complete, then BYE.
UAS: `rtp_ep.run_until_cancelled()` — runs until BYE cancels the task.

Receive counting via `_CountingProtocol` (asyncio DatagramProtocol). Stats: `tx_pkts`, `rx_pkts`, `first_rx_ms`, `last_rx_ms`.

### `pre_phase.py` — Bulk Registration

Rate-limited REGISTER (config.register_rate/sec). Retry on timeout (config.register_retry). `asyncio.gather()` barrier — all extensions must register. SUBSCRIBE follows same pattern. `PrePhaseResult` tracks success/fail per extension.

### `metrics.py` — MetricsCollector + FastAPI

In-process FastAPI server (uvicorn on asyncio event loop). Shares `MetricsCollector` object with traffic engine — no IPC.

Endpoints:
```
GET  /metrics           → TrafficMetrics snapshot
WS   /metrics/stream    → push every metrics_interval seconds
GET  /api/test/status   → { phase, running, elapsed_seconds }
POST /api/test/start    → start traffic (GUI-driven mode)
POST /api/test/stop     → graceful shutdown
PUT  /api/config        → receive VMConfig from GUI
GET  /api/ping          → reachability check
GET  /api/calls         → call event history
GET  /api/vms           → VM status list
```

### `main.py` — Lifecycle Orchestrator

CLI with `argparse`. Key flags: `--config`, `--api-only`, `--pre-phase-only`, `--max-calls`, `--skip-subscribe`, `--no-unregister`, `--gui-drain-seconds`.

Modes:
- **CLI mode:** `--config uac.yaml` → loads config, runs full lifecycle autonomously
- **API-only mode:** `--api-only --port 8082` → starts FastAPI, waits for GUI to push config and trigger start
- **Pre-phase-only:** `--pre-phase-only` → REGISTER + SUBSCRIBE, then idle (for testing registration)

Signal handling: SIGTERM/SIGINT → graceful shutdown (drain calls → unregister → close transports → write summary → GUI drain → exit).

---

## 5. GUI Architecture

| Screen | Route | Key Components | Backend Integration |
|--------|-------|---------------|-------------------|
| Config | `/config` | VMPairBook, VMConfigPanel, AdvancedSettings | Zustand only (no REST on save) |
| Launch | `/launch` | PrePhasePanel, LaunchCountdown | REST: `PUT /api/config` + `POST /api/test/start` |
| Run | `/run` | Dashboard (CPSGauge, ASRGauge, LiveChart) | WebSocket `/metrics/stream` for live push |
| PostRun | `/run` (phase=COMPLETE) | SummaryCard, CallTable, FailureAnalysis | REST: `GET /api/calls`, `GET /metrics` |

**State management:** Zustand (`store/traffic.ts`) — holds pairs, advancedSettings, runState, callEvents.

**Config validation:** Zod schema (`lib/config-schema.ts`) validates before save. Extension ranges auto-derive (UAC Start + Count → UAS auto-synced).

**Wrap analysis:** Live sidebar in VMPairBook computes pool_count, wrap_time, natural spacing from draft form values (not saved state). Color-coded: emerald (natural) / amber (delay required).

---

## 6. What Was Replaced from the Original Codebase

| Original Component | Status | Replacement |
|-------------------|--------|-------------|
| **`transport.py`** (blocking `socket.connect`, `socket.recv(4096)`) | **REPLACED** | `sip_engine.py` — `AsyncSipTransport` with `asyncio` TCP/TLS/UDP |
| **`listenthread.py`** (blocking `recv` in threads) | **REPLACED** | `sip_engine.py` — `asyncio.StreamReader` for TCP, `DatagramProtocol` for UDP |
| **`messagebuffer.py`** (thread queues, `time.sleep(0.0001)` spin loops) | **REPLACED** | `sip_engine.py` — async StreamReader framing, `asyncio.Queue` event dispatch |
| **`useragent.py` main loop** (giant procedural if/elif, hardcoded `/root/` paths) | **REPLACED** | `call_engine.py` — `CallEngine` (UAC) + `UasAutoAnswer` (UAS), structured coroutines |
| **`uasession.py`** (60+ Java-style getters/setters) | **REPLACED** | `extension_agent.py → DialogState` — flat `@dataclass` with ~30 fields |
| **`registration.py`** (Java-style getters/setters, duplicate session concept) | **REPLACED** | Merged into `extension_agent.py` registration flow |
| **Flask orchestrator** (`callflow/app.py` — parse callflow text, SSH deploy, SSH exec) | **NOT USED** in traffic path | GUI (`gui/`) + FastAPI (`metrics.py`) + direct CLI |
| **`provresponse.py`** (empty file) | **DELETED** | N/A |
| **`messageparser.py`** (entirely commented out) | **DELETED** | N/A |
| **`transport.py.py`** (duplicate with different API) | **DELETED** | N/A |
| **LoadRunner `uac/` + `uas/`** (forked copy of entire UA) | **NOT USED** | Traffic modes (smoke/timed/unlimited) in `call_engine.py` + `config.py` |

### Modules Still Imported from Legacy (`useragent/json/linoxiderepo/`)

These modules are **imported by `extension_agent.py`** for SIP message construction:

| Module | Why Kept | Go Migration Note |
|--------|---------|-------------------|
| `sipmessage.py` | Clean SIP message data model — header add/remove/replace, request/response lines | Port to Go struct |
| `sipconstants.py` | Comprehensive enums (methods, headers, states, codecs, response codes) | Port as Go constants |
| `parserandbuilder.py` | Battle-tested SIP/SDP parser + builder (`parseHeaders`, `buildMessage`) | Port parse + build logic |
| `authenticate.py` | Correct Digest auth (RFC 2617, MD5) — `calcDigestResp` | Port to Go `crypto/md5` |
| `sdp.py` | SDP data model (`SDP` + `SDPMLine`) | Port to Go struct |
| `invite.py, bye.py, prack.py, register.py, subscribe.py` | SIP method helpers (message construction patterns) | Inline into Go agent |
| `util.py` | Tag, branch, Call-ID generators (RFC 3261 format) | Port as Go helper funcs |

---

## 7. Key Design Decisions (Phase 1)

| Decision | Rationale |
|----------|-----------|
| **asyncio everywhere** (no threads for SIP) | Replaces blocking `recv` + `time.sleep` spin loops. Single event loop handles 1000+ concurrent calls. |
| **One ExtensionAgent per extension** (persistent socket) | Mirrors original pattern where `SignalingSocket` lives for entire run. Prevents socket churn. |
| **DialogState replaces UASession** | Flat dataclass vs 60+ getters/setters. Purpose-built for traffic path (not full UA). |
| **Legacy modules imported, not rewritten** | `sipmessage.py`, `parserandbuilder.py`, `authenticate.py` are battle-tested. Rewriting risks SIP compliance bugs. Saves time. |
| **In-process FastAPI** (no subprocess for metrics) | Shares asyncio event loop with traffic engine. Zero IPC overhead. |
| **Wrap delay: always-compute formula** | Single `max(0, hold + 2 - elapsed)` handles natural, boundary, and computed cases without branching. See `WRAP_HOLD_POOL_LOGIC.md`. |
| **media_enabled umbrella flag** | Two insertion points (UAC + UAS RTP alloc), zero patches elsewhere. Existing `if rtp_ep:` guards handle None. |
| **Extension range auto-derive** | UAC Start + Count → UAS auto-synced. Eliminates most common misconfiguration. |

---

## 8. Go Migration Priorities (Phase 2)

### Tier 1 — Critical Path (Port First)

| Module | Lines | Why |
|--------|-------|-----|
| `sip_engine.py` | 461 | Transport layer — Go `net.Conn` + `bufio.Scanner` replaces asyncio. Highest performance impact. |
| `call_engine.py` | 905 | CPS controller + call sequences. Go goroutines + channels replace `asyncio.create_task` + `Queue`. |
| `extension_agent.py` | 1125 | Agent + DialogState. Go struct + method receivers. Imports from legacy modules need porting. |
| `rtp_stream.py` | 396 | UDP RTP. Go `net.UDPConn` + goroutines. Straightforward port. |
| `config.py` | 412 | VMConfig. Go struct + `yaml.v3` + env vars. |

### Tier 2 — Supporting (Port Second)

| Module | Lines | Why |
|--------|-------|-----|
| `pre_phase.py` | 346 | Bulk registration. Go `sync.WaitGroup` + rate limiter. |
| `metrics.py` | 981 | FastAPI → Go `net/http` + `gorilla/websocket`. |
| `main.py` | 937 | CLI + lifecycle. Go `flag` + `os/signal`. |

### Tier 3 — Legacy SIP Modules (Port or Wrap)

| Module | Strategy |
|--------|----------|
| `sipmessage.py` + `sipconstants.py` | Port to Go structs + constants. Core SIP data model. |
| `parserandbuilder.py` | Port parse/build logic. Most complex — handle CRLF framing, Content-Length, SDP. |
| `authenticate.py` | Port `calcDigestResp`. Go `crypto/md5`. |
| `sdp.py` | Port SDP struct + build. |
| `invite.py, bye.py, prack.py, register.py, subscribe.py` | Inline into Go agent methods. Not standalone modules in Go. |

### Not Ported (Stay Python or Drop)

| Component | Reason |
|-----------|--------|
| Flask orchestrator (`callflow/app.py`) | Replaced by GUI + FastAPI. Not needed. |
| LoadRunner (`LoadRunner/`) | Traffic modes in `call_engine.py` replace this. |
| SIPp scripts | External tool. Keep as-is for regression. |
| GUI (`gui/`) | Next.js/TypeScript. Not a Go target. |
| `autoDeploy/` | Infra scripts. Not performance-critical. |

---

## 9. Key Metrics & Interfaces (Preserve in Go)

### Structured Call Event (JSON log line)

```json
{
  "call_id": "abc-123",
  "ext": "4001000",
  "event": "INVITE_SENT | 100_TRYING | RINGING | ACK_SENT | BYE_SENT | CALL_COMPLETE | CALL_FAILED | MEDIA_VERIFIED | MEDIA_DISABLED | ...",
  "sip_code": "180",
  "timestamp_ms": 1234567890123,
  "pdd_ms": 42.5,
  "hold_ms": 5023.1,
  "rtp_tx_pkts": 300,
  "rtp_rx_pkts": 295,
  "direction": "uac"
}
```

### TrafficMetrics Snapshot (WebSocket push)

```json
{
  "vm_id": "uac-local",
  "phase": "TRAFFIC",
  "running": true,
  "cps_actual": 5.8,
  "concurrent_calls": 1080,
  "calls_attempted": 5400,
  "calls_completed": 5390,
  "calls_failed": 10,
  "asr": 99.8,
  "avg_pdd_ms": 35.2,
  "avg_hold_ms": 180012,
  "socket_count": 250,
  "registered_count": 250,
  "run_elapsed_seconds": 900
}
```

### CallResult (internal, fed into MetricsCollector)

```python
@dataclass
class CallResult:
    call_id: str
    caller: str
    callee: str
    success: bool
    failure_reason: str = ""
    pdd_ms: float = 0.0
    hold_ms: float = 0.0
    total_ms: float = 0.0
    rtp_tx_pkts: int = 0
    rtp_rx_pkts: int = 0
    media_verified: bool = False
    rtp_local_port: int = 0
    pool_wrap_index: int = 0
```

---

## 10. Takeaways

1. **The traffic engine is fully async.** No threads for SIP. One `asyncio` event loop handles all extensions, all calls, all transports, metrics server, and signal handling. This is the model to replicate in Go with goroutines.

2. **Legacy SIP modules are a dependency, not dead code.** `extension_agent.py` imports `sipmessage`, `parserandbuilder`, `authenticate`, `invite`, `bye`, `prack`, `register`, `subscribe`, `util` from the original `linoxiderepo/`. These must be ported to Go or wrapped via CGo (not recommended).

3. **The wrap delay formula is the key scheduling innovation.** `max(0, hold + 2 - elapsed)` — always computed, no branching. Handles natural spacing, boundary conditions, ramp-up interaction. See `WRAP_HOLD_POOL_LOGIC.md` for full derivation.

4. **Media is an umbrella flag.** `media_enabled` gates RTP at exactly two points. Everything downstream handles `rtp_ep = None` gracefully. Porting to Go: check flag at goroutine spawn, not scattered through call logic.

5. **GUI and backend are decoupled.** REST + WebSocket only. Config is a flat JSON payload. This means the Go backend can serve the same API contract without GUI changes.
