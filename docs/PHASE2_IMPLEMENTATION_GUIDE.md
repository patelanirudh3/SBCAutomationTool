# Phase 2 — Implementation Guide: CCI Traffic Engine

> **Status:** Design-complete. Ready for implementation.
> **Scope:** Log correlation, call spine, RTP fix, SIP ladder, feature scenarios, MCP server, optional database, GUI overhaul.
> **Target stack:** Python (current) → Go (Phase 3 migration, separate guide).
> **Prerequisite:** Phase 1 complete. All traffic engine modules working as described in PHASE0_CODEBASE_ANALYSIS.md.

---

## Table of Contents

1. [Architecture Primer: MCP + Agent Explained](#1-architecture-primer-mcp--agent-explained)
2. [Clock Strategy — Mandatory UTC Sync](#2-clock-strategy--mandatory-utc-sync)
3. [GUI — Navigation & Feature Scenario UX](#3-gui--navigation--feature-scenario-ux)
4. [The Call Spine — Correlation Fix](#4-the-call-spine--correlation-fix)
5. [SIP Ladder — Design & Topology](#5-sip-ladder--design--topology)
6. [RTP Fix — _CountingProtocol Source Filter](#6-rtp-fix--_countingprotocol-source-filter)
7. [CallResult & CallEvent Enrichment](#7-callresult--callevent-enrichment)
8. [Aggregator Improvements](#8-aggregator-improvements)
9. [Kamailio Siptrace Parser](#9-kamailio-siptrace-parser)
10. [Feature Scenario Engine — Hold/Unhold](#10-feature-scenario-engine--holdunhold)
11. [MCP Server Implementation](#11-mcp-server-implementation)
12. [Database — Optional, Non-Blocking](#12-database--optional-non-blocking)
13. [Implementation Order & Timeline](#13-implementation-order--timeline)

---

## 1. Architecture Primer: MCP + Agent Explained

Before any code, here is exactly how the MCP server, Agent, and GUI chat panel fit together. This is the full picture in one diagram.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         CCI STUDIO — RUNTIME MAP                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                     NEXT.JS GUI   (port 3000)                        │  │
│  │                                                                      │  │
│  │   ┌─────────────┐  ┌──────────────┐  ┌──────────────────────────┐   │  │
│  │   │ Load Test   │  │  Scenarios   │  │  Chat Panel (Agent UI)   │   │  │
│  │   │ /config     │  │  /scenarios  │  │  "Why did call fail?"    │   │  │
│  │   │ /launch     │  │  /scenario-  │  │   → streams response     │   │  │
│  │   │ /run        │  │     run      │  └──────────┬───────────────┘   │  │
│  │   └─────────────┘  └──────────────┘             │                   │  │
│  └──────────────────────────────────────────────────┼───────────────────┘  │
│                                                      │ POST /agent/chat      │
│                 REST/WebSocket                        │                       │
│  ┌──────────────────┐        ┌───────────────────────▼──────────────────┐  │
│  │ Traffic Engine   │        │        MCP SERVER  (port 8090)           │  │
│  │ UAC  port 8082   │        │   (separate Python FastAPI process)      │  │
│  │ UAS  port 8081   │        │                                          │  │
│  │                  │        │  ┌────────────────────────────────────┐  │  │
│  │  GET /api/calls  │◄───────┤  │  Tool Registry (what Agent knows)  │  │  │
│  │  GET /metrics    │        │  │  • get_run_summary(run_id)         │  │  │
│  └──────────────────┘        │  │  • get_call_detail(call_id)        │  │  │
│                               │  │  • list_anomalies(run_id)          │  │  │
│  ┌──────────────────┐        │  │  • compare_runs(id1, id2)          │  │  │
│  │  logs/           │◄───────┤  │  • fetch_kamailio_trace(call_id)   │  │  │
│  │  run-*.json      │        │  │  • explain_failure(call_id)        │  │  │
│  │  traffic_run-*.  │        │  └────────────────────────────────────┘  │  │
│  │  siptrace-*.data │        │                    │                      │  │
│  └──────────────────┘        │                    │ calls Anthropic API  │  │
│                               │  ┌─────────────────▼──────────────────┐  │  │
│  ┌──────────────────┐        │  │          AGENT LOOP                 │  │  │
│  │  PostgreSQL      │        │  │                                      │  │  │
│  │  (optional)      │◄───────┤  │  1. User asks question              │  │  │
│  │                  │        │  │  2. Claude reasons → picks tools    │  │  │
│  └──────────────────┘        │  │  3. MCP server executes tools       │  │  │
│                               │  │  4. Claude synthesizes answer       │  │  │
│                               │  │  5. Streams back to chat panel      │  │  │
│                               │  └────────────────────────────────────┘  │  │
│                               └──────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────────┘
```

**In plain language:**

- The **MCP Server** is a small Python FastAPI process that runs alongside the traffic engine. It knows how to read your log files, query the database, and call kubectl. It does NOT talk to Claude directly.
- The **Agent** is a Claude API call (`/v1/messages`) made BY the MCP server when the chat panel sends a question. Claude is given the list of tools and it decides which ones to call, in what order, to answer the question.
- The **Chat Panel** in the GUI is just a React component that sends `POST /agent/chat` to the MCP server with the user's question, then streams the response back.
- **Nothing in the existing traffic engine changes** to support this. The MCP server reads the same log files and JSON files the traffic engine already writes.

The MCP server is a new, separate process: `python -m callflow_tool.mcp_server.main --port 8090`

---

## 2. Clock Strategy — Mandatory UTC Sync

### Why This Matters

UAC and UAS run on different VMs. Their clocks must agree within ±50ms to make a meaningful SIP ladder that shows cross-VM event order. Without clock sync, a 319ms PDD calculated from comparing UAC timestamps to UAS timestamps is meaningless — the apparent delay could be entirely clock drift.

### Decision: UTC + NTP on All VMs, Monotonic for Deltas

| Use | Clock | Reason |
|-----|-------|--------|
| Absolute log timestamps | `datetime.now(timezone.utc)` → ISO8601 | Comparable across VMs after NTP sync |
| PDD, hold_ms, all deltas | `time.monotonic()` | Never jumps, not affected by NTP slew |
| Siptrace file timestamps | `epoch_us` float from file | Already absolute; convert to UTC on read |
| Database storage | TIMESTAMPTZ (UTC) | Unambiguous, timezone-safe |

**Rule:** Never compute a cross-VM delta from `time.monotonic()`. Always use UTC wall clock for anything that crosses a VM boundary.

### Mandatory VM Setup (Ubuntu 22.04+)

Run these commands on EVERY VM (UAC, UAS) before any test run:

```bash
# 1. Ensure chrony is installed and running
sudo apt-get install -y chrony
sudo systemctl enable --now chronyd

# 2. Force immediate sync
sudo chronyc makestep

# 3. Set timezone to UTC (mandatory, no local time)
sudo timedatectl set-timezone UTC
sudo timedatectl set-ntp true

# 4. Verify — look for "System clock synchronized: yes" and offset < 10ms
timedatectl status
chronyc tracking | grep -E "System time|Stratum"

# 5. Persist (survives reboot)
echo "NTP=pool.ntp.org" | sudo tee -a /etc/systemd/timesyncd.conf
```

**Verification command to run before each test session:**

```bash
# Acceptable: offset < ±50ms. Warning: ±50-200ms. Fail: >200ms
chronyc tracking | grep "System time"
# Output: System time     : 0.000012345 seconds fast of NTP time
```

### Code Change: `metrics.py` and `call_engine.py`

Every `CallEvent` and metric snapshot must use `datetime.now(timezone.utc).isoformat()` for the `timestamp` field, not `time.time()` as a bare float. The monotonic timestamp is kept separately as `ts_mono_ms` for internal delta computation.

```python
# In call_engine.py — add to CallEvent logging
import time
from datetime import datetime, timezone

def _log_call_event(self, call_id, ext, event, **kwargs):
    ts_utc = datetime.now(timezone.utc).isoformat()
    ts_mono = time.monotonic() * 1000  # ms, for delta computation only
    event_obj = {
        "call_id": call_id,
        "ext": ext,
        "event": event,
        "ts_utc": ts_utc,       # NEW — absolute, cross-VM comparable
        "ts_mono_ms": ts_mono,   # kept for intra-process delta computation
        **kwargs
    }
    logger.info(f"CALL_EVENT {json.dumps(event_obj)}")
```

---

## 3. GUI — Navigation & Feature Scenario UX

### UX Decision: Two Top-Level Modes, Not Two Separate Apps

The existing `/config → /launch → /run` flow is well-built. Do not discard it. Instead, add a **Mode Gate** at the top-level navigation so the user consciously chooses what they are doing:

```
┌───────────────────────────────────────────────────────────────┐
│  CCI Studio   ● Load Testing   ◯ Feature Scenarios            │
│  ─────────────────────────────────────────────────────────── │
│  [current content of selected mode renders below]            │
└───────────────────────────────────────────────────────────────┘
```

### Route Structure (New)

```
/                       → redirect to /load-test/config
/load-test/config       → VMPairBook (existing config, unchanged)
/load-test/launch       → PrePhasePanel (existing, unchanged)
/load-test/run          → Dashboard (existing, unchanged)

/scenarios              → ScenarioHome: list of available scenarios
/scenarios/[id]/config  → ScenarioConfigPanel (simplified — no CPS, no traffic mode)
/scenarios/[id]/run     → ScenarioRunPanel (SIP ladder live view + assertions)
/scenarios/[id]/result  → ScenarioResultPanel (full call spine + SIP ladder + AI analysis)
```

### What Changes in Existing Code

The existing routes (`/config`, `/launch`, `/run`) just get renamed to `/load-test/*`. The Navbar component gets a mode toggle. The Zustand store gets a `mode: 'load-test' | 'feature-scenario'` field. This is surgical — the load test flow is not rewritten.

### Scenario Config Panel Layout

The scenario config page is deliberately simpler than the traffic config. It does not expose CPS, hold time, traffic mode, or ramp-up. It only needs:

```
┌─────────────────────────────────────────────────────────────────┐
│  Feature Scenario: Hold / Unhold                                │
│                                                                 │
│  ┌───────────────────────┐   ┌───────────────────────────────┐  │
│  │  Endpoint Config      │   │  Scenario Parameters          │  │
│  │                       │   │                               │  │
│  │  UAC Extension: ____  │   │  Hold Duration:  [5] sec      │  │
│  │  UAS Extension: ____  │   │  Pre-hold RTP:   [3] sec      │  │
│  │  SBC Host:      ____  │   │  Post-hold RTP:  [3] sec      │  │
│  │  SBC Port:      ____  │   │                               │  │
│  │  Domain:        ____  │   │  Assertions:                  │  │
│  │  Password:      ____  │   │  ✅ re-INVITE count = 2       │  │
│  │                       │   │  ✅ Media: ACTIVE→HELD→ACTIVE │  │
│  └───────────────────────┘   │  ✅ ASR = 100%                │  │
│                               └───────────────────────────────┘  │
│                                                                 │
│  [ Cancel ]                              [ Run Scenario → ]    │
└─────────────────────────────────────────────────────────────────┘
```

### Scenario Run Panel — Live SIP Ladder

This is the VP demo showstopper. During a feature scenario run, the GUI shows a **live SIP ladder** that builds in real time as events stream in over WebSocket. Each event received from the backend causes a new row to appear in the ladder:

```
┌──────────────────────────────────────────────────────────────────────┐
│  Hold/Unhold Scenario — RUNNING                         ⏱ 00:08     │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   UAC              SBC + Kamailio           CM            UAS        │
│    │                      │                  │              │        │
│  ──┤ INVITE [A] ─────────►│──────────────────►│              │        │
│    │◄── 100 Trying ───────│                  │              │        │
│    │                      │                  │──INVITE [B]──►│        │
│    │                      │                  │              │        │
│    │◄── 180 Ringing ──────│◄─────────────────│◄─── 180 ────│        │
│    │ PRACK ──────────────►│                  │              │        │
│    │◄── 200 PRACK ────────│                  │              │        │
│    │◄── 200 OK ───────────│   pdd=319ms      │              │        │
│    │ ACK ────────────────►│                  │              │        │
│    │                      │                  │              │        │
│    │◄══ RTP (ACTIVE) ════►│◄═════════════════►│◄═══ RTP ════│        │
│    │                      │                  │              │        │
│    │ re-INVITE (HOLD) ───►│                  │              │        │  ← animates in
│    │◄── 200 OK ───────────│   (a=inactive)   │              │        │
│    │ ACK ────────────────►│                  │              │        │
│    │                      │    [HELD 5s]      │              │        │
│    │ re-INVITE (UNHOLD) ─►│                  │              │        │
│    │◄── 200 OK ───────────│   (a=sendrecv)   │              │        │
│    │◄══ RTP (ACTIVE) ════►│                  │              │        │
│    │                      │                  │              │        │
│    │ BYE ────────────────►│                  │              │        │
│    │◄── 200 BYE ──────────│                  │              │        │
│                                                                      │
│  Assertions:  ✅ re-INVITE=2   ✅ ACTIVE→HELD→ACTIVE   ✅ ASR=100%  │
└──────────────────────────────────────────────────────────────────────┘
```

The ladder renders in a React component with Tailwind. Each swim lane is a `<div>` column. Arrows are SVG lines. Events stream over the existing `/metrics/stream` WebSocket — the backend adds `sip_ladder_event` messages to the stream during feature scenario runs.

### New Components to Create

| Component | Path | Description |
|-----------|------|-------------|
| `ModeGate` | `components/layout/ModeGate.tsx` | Top nav toggle: Load Test / Feature Scenarios |
| `ScenarioHome` | `app/scenarios/page.tsx` | Scenario browser: cards per scenario |
| `ScenarioConfigPanel` | `components/scenarios/ScenarioConfigPanel.tsx` | Simplified endpoint + scenario params form |
| `SipLadderLive` | `components/scenarios/SipLadderLive.tsx` | Real-time SVG ladder, WebSocket-driven |
| `ScenarioResultPanel` | `components/scenarios/ScenarioResultPanel.tsx` | Post-run: full ladder, assertions, AI analysis |
| `AssertionBadge` | `components/scenarios/AssertionBadge.tsx` | ✅/❌ badge per assertion with detail |
| `ChatPanel` | `components/agent/ChatPanel.tsx` | Collapsible right drawer, MCP agent interface |
| `CallSpineCard` | `components/postrun/CallSpineCard.tsx` | Replaces/extends CallTable for correlated view |

---

## 4. The Call Spine — Correlation Fix

### The Problem in Detail

Your current `run-*.json` has this under `call_events`:

```json
[{
  "call_id": "6290370",       ← UAC leg only
  "uac_ext": "4001000",
  "uas_ext": "4001005",
  "result": "COMPLETED",
  ...
}]
```

The UAS process has its own call event with `call_id: "d792c1cc22d841f195ce050569b2422"` (Avaya CM's B2BUA-generated Call-ID for Leg B), but this is **never collected by the orchestrator** and never appears in the JSON. The two legs are completely disconnected.

### The Correlation Key

Since ASBC passes the UAC Call-ID through to Kamailio (confirmed), and CM generates a new Call-ID for Leg B, the only reliable correlation key available from UAC+UAS data alone is:

```
(uac_ext, uas_ext, time_window=±3s)
```

A call from 4001000 → 4001005 at T+0s on UAC, and a call received by 4001005 from 4001000 at T+Xs on UAS (where X < 3) — these are the same call. This pairing is deterministic during a test run because call order is controlled by the engine.

When Kamailio siptrace is available, use Call-ID for exact matching. Until then, the extension+time pairing is robust and sufficient.

### Changes to `main.py` — Run Orchestrator

The orchestrator must collect UAS call events **and correlate them at export time**.

**Step 1: Add UAS event collection to run orchestration.**

After `POST /api/test/stop` completes and the UAC finishes, the orchestrator calls `GET /api/calls` on the UAS process (it already knows the UAS URL from config). This must happen **before** UAS process exits.

```python
# In main.py — after traffic run completes, before writing JSON

async def _collect_correlated_events(uac_calls: list, uas_url: str) -> list:
    """Fetch UAS call events and correlate them with UAC events by ext+time."""
    uas_calls = []
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{uas_url}/api/calls", timeout=10) as r:
                if r.status == 200:
                    uas_calls = await r.json()
    except Exception as e:
        logger.warning(f"Could not fetch UAS events for correlation: {e}")
        # Non-fatal: continue with UAC-only data
    
    return _build_call_spines(uac_calls, uas_calls)


def _build_call_spines(uac_calls: list, uas_calls: list) -> list:
    """
    Join UAC and UAS call events by (uac_ext, uas_ext, time_window=3s).
    Returns a list of CallSpine dicts.
    """
    spines = []
    uas_index = {}  # (uas_ext, uac_ext) -> list of uas call events sorted by time
    
    for uc in uas_calls:
        key = (uc.get("ext"), uc.get("peer_ext"))  # UAS ext, peer (UAC ext)
        uas_index.setdefault(key, []).append(uc)
    
    for uac_call in uac_calls:
        uac_ext = uac_call.get("uac_ext") or uac_call.get("ext")
        uas_ext = uac_call.get("uas_ext") or uac_call.get("peer_ext")
        uac_ts  = uac_call.get("ts_utc")
        
        # Find matching UAS event within ±3s
        uas_match = None
        candidates = uas_index.get((uas_ext, uac_ext), [])
        for uc in candidates:
            uc_ts = uc.get("ts_utc")
            if uc_ts and abs(_ts_diff_seconds(uac_ts, uc_ts)) < 3.0:
                uas_match = uc
                break
        
        # Cross-check RTP counts (UAC tx should ≈ UAS rx, and vice versa)
        rtp_cross = _compute_rtp_cross_check(uac_call, uas_match)
        
        spine = {
            "spine_id": f"{uac_ext}->{uas_ext}@{uac_ts}",
            "uac_leg": uac_call,
            "uas_leg": uas_match,          # None if UAS collection failed
            "correlation_method": "ext_time_window" if uas_match else "uac_only",
            "kam_trace": None,             # filled in by siptrace parser if available
            "media_cross_check": rtp_cross,
            "call_ids": {
                "leg_a": uac_call.get("call_id"),               # UAC→SBC→Kamailio→CM
                "leg_b": uas_match.get("call_id") if uas_match else None,  # CM→Kamailio→SBC→UAS
                "b2bua_boundary": "avaya_cm"
            }
        }
        spines.append(spine)
    
    return spines


def _compute_rtp_cross_check(uac_call: dict, uas_call: dict | None) -> dict:
    if not uas_call:
        return {"status": "UNCORRELATED"}
    
    uac_tx = uac_call.get("rtp_tx_pkts", 0)
    uac_rx = uac_call.get("rtp_rx_pkts", 0)
    uas_tx = uas_call.get("rtp_tx_pkts", 0)
    uas_rx = uas_call.get("rtp_rx_pkts", 0)
    
    def pct_delta(a, b):
        if a == 0 and b == 0: return 0.0
        if a == 0: return 100.0
        return abs(a - b) / a * 100
    
    a_to_b_delta = pct_delta(uac_tx, uas_rx)  # UAC sent → UAS received
    b_to_a_delta = pct_delta(uas_tx, uac_rx)  # UAS sent → UAC received
    
    def flag(pct):
        if pct <= 5: return "OK"
        if pct <= 15: return "WARNING"
        return "CRITICAL"
    
    return {
        "uac_tx_vs_uas_rx": {"uac_tx": uac_tx, "uas_rx": uas_rx, "delta_pct": round(a_to_b_delta, 1), "flag": flag(a_to_b_delta)},
        "uas_tx_vs_uac_rx": {"uas_tx": uas_tx, "uac_rx": uac_rx, "delta_pct": round(b_to_a_delta, 1), "flag": flag(b_to_a_delta)},
        "overall_status": "OK" if flag(a_to_b_delta) == "OK" and flag(b_to_a_delta) == "OK" else "DEGRADED"
    }
```

**Step 2: Add `peer_ext` to UAS `CallResult`.**

The UAS `_handle_call()` already knows the calling extension from the INVITE From header. Add `peer_ext` to `CallResult` and log it. This is the matching key.

**Step 3: Updated `run-*.json` structure.**

```json
{
  "run_id": "run-20260318_201306",
  "aggregate": { ... },
  "config": { ... },
  "call_spines": [
    {
      "spine_id": "4001000->4001005@2026-03-18T20:13:39.984Z",
      "correlation_method": "ext_time_window",
      "call_ids": {
        "leg_a": "6290370",
        "leg_b": "d792c1cc22d841f195ce050569b2422",
        "b2bua_boundary": "avaya_cm"
      },
      "uac_leg": {
        "call_id": "6290370",
        "ext": "4001000",
        "peer_ext": "4001005",
        "result": "COMPLETED",
        "ts_utc": "2026-03-18T20:13:39.984Z",
        "pdd_ms": 319.94,
        "hold_ms": 5018.25,
        "total_ms": 5975.51,
        "rtp_tx_pkts": 201,
        "rtp_rx_pkts": 204,
        "sbc_rtp_relay_ip": "10.133.63.117",
        "sbc_rtp_relay_port": 39238,
        "sip_milestones": {
          "invite_sent_ms":    0,
          "trying_100_ms":     12.3,
          "ringing_180_ms":    290.1,
          "prack_sent_ms":     294.5,
          "prack_200_ms":      299.8,
          "ok_200_ms":         319.94,
          "ack_sent_ms":       323.1,
          "rtp_start_ms":      324.0,
          "rtp_end_ms":        5322.0,
          "bye_sent_ms":       5324.3,
          "bye_200_ms":        5330.5,
          "media_verified_ms": 5335.0
        }
      },
      "uas_leg": {
        "call_id": "d792c1cc22d841f195ce050569b2422",
        "ext": "4001005",
        "peer_ext": "4001000",
        "result": "COMPLETED",
        "ts_utc": "2026-03-18T20:13:40.101Z",
        "total_ms": 5692.10,
        "rtp_tx_pkts": 101,
        "rtp_rx_pkts": 102,
        "sbc_rtp_relay_ip": "10.133.63.117",
        "sbc_rtp_relay_port": 39236,
        "sip_milestones": {
          "invite_received_ms": 0,
          "trying_100_sent_ms": 1.2,
          "ringing_180_sent_ms": 2.5,
          "prack_received_ms":  8.1,
          "prack_200_sent_ms":  8.9,
          "ok_200_sent_ms":     10.2,
          "ack_received_ms":    15.7,
          "bye_received_ms":    5020.1,
          "bye_200_sent_ms":    5021.3
        }
      },
      "media_cross_check": {
        "uac_tx_vs_uas_rx": {"uac_tx": 201, "uas_rx": 102, "delta_pct": 49.3, "flag": "CRITICAL"},
        "uas_tx_vs_uac_rx": {"uas_tx": 101, "uac_rx": 102, "delta_pct": 1.0, "flag": "OK"},
        "overall_status": "DEGRADED"
      },
      "kam_trace": null
    }
  ]
}
```

---

## 5. SIP Ladder — Design & Topology

### Correct Network Topology (from confirmed facts)

```
UAC VM                                 K3s Cluster (10.133.63.109)
                                   ┌────────────────────────────────┐
UAC ──►  SBC  ──►  kam-lb  ──►   │  kam-backend (via dispatcher)  │
              ◄──  kam-lb  ◄──   │  → processes, routes to CM     │
                                   └────────────────────────────────┘
                        │
                        ▼
                        CM (B2BUA)
                        │
                        ▼ (new Call-ID for Leg B)
                   kam-lb  ──►  SBC  ──►  UAS VM
```

**Rule for SIP Ladder display:** `kamailio-backend` is an internal implementation detail. The ladder shows **4 logical columns only**:

```
UAC  |  SBC + Kamailio  |  CM  |  UAS
```

The "SBC + Kamailio" column represents the entire infrastructure path (SBC → kam-lb → kam-backend → kam-lb → SBC) as a single relay block. This is accurate for the test tool's purpose — you care about UAC↔CM and CM↔UAS delays, not internal Kamailio routing.

### The Call-ID Annotation

The B2BUA boundary is the most important thing to show. The ladder annotates the change:

```
UAC              [SBC + Kamailio]         CM              UAS
 │                      │                  │                │
 │── INVITE ────────────►│                  │                │
 │   Call-ID: 6290370   │── INVITE ────────►│                │
 │◄── 100 Trying ───────│  Call-ID: 6290370 │                │
 │                       │                 │── INVITE ──────►│
 │                       │ ← B2BUA ──────  │  Call-ID: d792c │
 │◄── 180 Ringing ───────│◄── 180 ─────────│◄── 180 ─────────│
 │── PRACK ─────────────►│                  │                │
 │◄── 200 PRACK ─────────│                  │                │
 │◄── 200 OK ────────────│   PDD: 319ms     │                │
 │── ACK ───────────────►│                  │                │
 │                       │                  │                │
 │◄══ RTP (ACTIVE) ══════════════════════════════════════════│
 │                       │                  │                │
 │── BYE ───────────────►│                  │                │
 │◄── 200 BYE ───────────│                  │                │
```

### SIP Ladder Data Model

The ladder is stored in `sip_milestones` on each leg (already shown in §4 spine structure). The GUI constructs the visual from this — it does not need raw SIP messages. The ladder events per leg are:

**UAC Leg milestones (logged by `_execute_call`):**

| Milestone Key | When to Record | Clock |
|---|---|---|
| `invite_sent_ms` | Immediately after `send_invite()` | monotonic, offset from call start |
| `trying_100_ms` | On receiving 100 Trying | monotonic delta |
| `ringing_180_ms` | On receiving 180 Ringing | monotonic delta (this IS pdd_ms) |
| `prack_sent_ms` | After sending PRACK | monotonic delta |
| `prack_200_ms` | On receiving 200 PRACK | monotonic delta |
| `ok_200_ms` | On receiving 200 OK | monotonic delta |
| `ack_sent_ms` | After sending ACK | monotonic delta |
| `rtp_start_ms` | When RtpEndpoint.run() begins | monotonic delta |
| `rtp_end_ms` | When RtpEndpoint completes | monotonic delta |
| `bye_sent_ms` | After sending BYE | monotonic delta |
| `bye_200_ms` | On receiving 200 BYE | monotonic delta |
| `media_verified_ms` | After MEDIA_VERIFIED event | monotonic delta |
| `invite_ts_utc` | UTC ISO8601 of INVITE_SENT | wall clock for cross-VM align |

**UAS Leg milestones (logged by `_handle_call`):**

| Milestone Key | When to Record | Clock |
|---|---|---|
| `invite_received_ms` | On INVITE arriving in `_uas_loop` | monotonic, offset from call start |
| `trying_100_sent_ms` | After sending 100 | monotonic delta |
| `ringing_180_sent_ms` | After sending 180 | monotonic delta |
| `prack_received_ms` | On PRACK arriving | monotonic delta |
| `prack_200_sent_ms` | After sending 200 PRACK | monotonic delta |
| `ok_200_sent_ms` | After sending 200 OK | monotonic delta |
| `ack_received_ms` | On ACK arriving | monotonic delta |
| `bye_received_ms` | On BYE arriving | monotonic delta |
| `bye_200_sent_ms` | After sending 200 BYE | monotonic delta |
| `invite_ts_utc` | UTC ISO8601 when INVITE received | wall clock for cross-VM align |

**Cross-VM alignment:** To render a merged ladder, align using `invite_ts_utc` from both legs. `uac.invite_sent_ms = 0`. `uas.invite_received_ms = 0`. The offset between the two zero-points is `uas.invite_ts_utc - uac.invite_ts_utc` (in ms). This gives the one-way signaling delay to the UAS, placing UAS events correctly on the timeline.

### Additions to `CallResult` for Milestones

```python
@dataclass
class SipMilestones:
    # UAC-side (offsets from call start in ms, monotonic)
    invite_sent_ms:    float = 0.0
    trying_100_ms:     float = 0.0
    ringing_180_ms:    float = 0.0
    prack_sent_ms:     float = 0.0
    prack_200_ms:      float = 0.0
    ok_200_ms:         float = 0.0
    ack_sent_ms:       float = 0.0
    rtp_start_ms:      float = 0.0
    rtp_end_ms:        float = 0.0
    bye_sent_ms:       float = 0.0
    bye_200_ms:        float = 0.0
    media_verified_ms: float = 0.0
    # Wall clock anchor (UTC ISO8601) for cross-VM alignment
    invite_ts_utc:     str   = ""

    # UAS-side (added by UasAutoAnswer, same structure)
    invite_received_ms: float = 0.0
    trying_100_sent_ms: float = 0.0
    ringing_180_sent_ms: float = 0.0
    prack_received_ms:  float = 0.0
    prack_200_sent_ms:  float = 0.0
    ok_200_sent_ms:     float = 0.0
    ack_received_ms:    float = 0.0
    bye_received_ms:    float = 0.0
    bye_200_sent_ms:    float = 0.0


@dataclass
class CallResult:
    # --- Existing fields (unchanged) ---
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

    # --- NEW fields ---
    peer_ext: str = ""                    # the other side's extension
    ts_utc: str = ""                      # UTC ISO8601 call start
    direction: str = "uac"               # "uac" or "uas"
    sbc_rtp_relay_ip: str = ""           # extracted from SDP 200 OK
    sbc_rtp_relay_port: int = 0          # extracted from SDP 200 OK
    sip_milestones: SipMilestones = field(default_factory=SipMilestones)
    rtp_asymmetry_flag: str = ""         # OK / WARNING / CRITICAL
    scenario: str = "basic_call"         # "basic_call" | "hold_unhold" | etc.
    scenario_assertions: dict = field(default_factory=dict)
```

---

## 6. RTP Fix — `_CountingProtocol` Source Filter

### Root Cause

`_CountingProtocol.datagram_received(data, addr)` counts every UDP datagram arriving on the bound RTP port. The SBC actively probes and sends RTCP on the media relay ports. This inflates `rtp_rx_pkts` significantly beyond what the far-end actually transmitted.

Your numbers demonstrate this:
- UAS sent 101 packets. UAC received 251. Delta = 149% — the excess 150 are SBC artifacts.
- UAC sent 201 packets. UAS received 277. Delta = 38% — again, SBC artifacts.

### The Fix — Two Layers of Defense

**Layer 1: Source IP filter (primary, surgical).**
After SDP negotiation (200 OK), the SBC relay IP:port is known. Store it. Only count datagrams from that source.

**Layer 2: RTP validity check (secondary, defense-in-depth).**
A valid RTP packet: first 2 bits must be `10` (version=2), and packet length must be ≥ 12 bytes. This filters random probes that don't look like RTP at all.

```python
# rtp_stream.py

class _CountingProtocol(asyncio.DatagramProtocol):
    def __init__(self):
        self.packets_received: int = 0
        self.first_recv_ts: float | None = None
        self.last_recv_ts: float | None = None
        self._expected_src: tuple[str, int] | None = None   # NEW

    def set_expected_src(self, ip: str, port: int) -> None:
        """
        Call this after SDP negotiation to lock in the SBC relay address.
        Until called, ALL valid RTP packets are counted (pre-answer phase).
        """
        self._expected_src = (ip, port)

    def datagram_received(self, data: bytes, addr: tuple[str, int]) -> None:
        # Layer 1: source filter (once we know who to expect)
        if self._expected_src is not None and addr != self._expected_src:
            return

        # Layer 2: RTP validity — version must be 2, min length 12 bytes
        if len(data) < 12:
            return
        if (data[0] >> 6) != 2:   # top 2 bits must be 0b10
            return

        # Valid RTP from expected source
        now = time.monotonic() * 1000
        if self.first_recv_ts is None:
            self.first_recv_ts = now
        self.last_recv_ts = now
        self.packets_received += 1
```

**Wiring the fix into `RtpEndpoint`:**

```python
class RtpEndpoint:
    # ... existing __init__, create(), etc. ...

    def set_remote_rtp_addr(self, ip: str, port: int) -> None:
        """
        Called by CallEngine after parsing the 200 OK SDP answer.
        Locks the counting protocol to only count from this source.
        """
        self._remote_ip = ip
        self._remote_port = port
        if self._protocol:   # transport already started
            self._protocol.set_expected_src(ip, port)

    async def run(self, duration: float) -> None:
        # EXISTING: 3-phase burst. Remote addr already set before this is called.
        # Ensure protocol filter is active.
        if self._protocol and self._remote_ip:
            self._protocol.set_expected_src(self._remote_ip, self._remote_port)
        # ... rest of existing run() logic unchanged ...
```

**Call site in `call_engine.py` (`_execute_call`):**

```python
# After parsing 200 OK and extracting SBC relay addr:
sbc_rtp_ip, sbc_rtp_port = agent.parse_200_invite(response)  # already returns these

# NEW: tell RtpEndpoint to filter on SBC relay address
if rtp_ep:
    rtp_ep.set_remote_rtp_addr(sbc_rtp_ip, sbc_rtp_port)

# Also store on CallResult for correlation
result.sbc_rtp_relay_ip = sbc_rtp_ip
result.sbc_rtp_relay_port = sbc_rtp_port
```

**For UAS (`_handle_call`):** The UAS RtpEndpoint is told the remote address from the INVITE SDP (UAC's offered address, which is the SBC relay for the B-leg). Same `set_remote_rtp_addr()` call after parsing the INVITE SDP.

**Expected result after fix:**
- UAC tx=201, UAS rx ≈ 199-203 (within 5%) — **OK**
- UAS tx=101, UAC rx ≈ 98-104 (within 5%) — **OK**
- `media_cross_check.overall_status` = **OK**

---

## 7. CallEvent Enrichment

### Missing Events — Add to UAC `_execute_call()`

The following events exist in code logic but are not explicitly logged as structured `CALL_EVENT` entries:

| Missing Event | Where in Code | Add After |
|---|---|---|
| `INVITE_SENT` | Already exists | (keep) |
| `TRYING_100` | Check if logged | `_wait_for_event(100)` returns |
| `RINGING_180` | Check if logged | `_wait_for_event(180)` returns |
| `PRACK_SENT` | Likely missing | After PRACK send |
| `PRACK_200` | Likely missing | After 200-PRACK received |
| `OK_200_INVITE` | Check if logged | After 200 OK parsed |
| `ACK_SENT` | Likely missing | After ACK sent |
| `RTP_BURST_START` | Likely missing | When RtpEndpoint.run() starts |
| `RTP_BURST_END` | Likely missing | When burst end phase completes |
| `BYE_SENT` | Check if logged | After BYE sent |
| `BYE_200` | Likely missing | After 200 BYE received |

### Missing Events — Add to UAS `_handle_call()`

| Missing Event | Add After |
|---|---|
| `UAS_INVITE_RECEIVED` | On INVITE arriving |
| `UAS_TRYING_100_SENT` | After sending 100 |
| `UAS_RINGING_180_SENT` | After sending 180 |
| `UAS_PRACK_RECEIVED` | After PRACK arrives |
| `UAS_200_PRACK_SENT` | After sending 200 PRACK |
| `UAS_200_OK_SENT` | After sending 200 OK |
| `UAS_ACK_RECEIVED` | After ACK arrives |
| `UAS_BYE_RECEIVED` | After BYE arrives |
| `UAS_200_BYE_SENT` | After sending 200 BYE |

### Standardized Event Format (all events)

```python
def _emit_call_event(
    self,
    call_id: str,
    ext: str,
    event: str,
    direction: str,        # "uac" or "uas"
    sip_code: int = 0,
    peer_ext: str = "",
    milestone_ms: float = 0.0,   # offset from call start (monotonic)
    **extra
):
    ts_utc = datetime.now(timezone.utc).isoformat()
    ts_mono = time.monotonic() * 1000
    
    payload = {
        "call_id": call_id,
        "ext": ext,
        "peer_ext": peer_ext,
        "event": event,
        "direction": direction,
        "ts_utc": ts_utc,
        "ts_mono_ms": ts_mono,
        "milestone_ms": milestone_ms,
        **({} if not sip_code else {"sip_code": sip_code}),
        **extra
    }
    logger.info(f"CALL_EVENT {json.dumps(payload)}")
    self._metrics_collector.record_call_event(payload)
```

---

## 8. Aggregator Improvements

### Current Problems

1. `avg_hold_ms: 0` on UAS side — UAS does not track hold time because `run_until_cancelled()` does not measure duration.
2. `avg_pdd_ms: 0` on UAS side — correct (UAS doesn't originate), but should be explicitly labeled "N/A" not 0.
3. RTP `tx`/`rx` are inflated by SBC probes (fixed in §6).
4. Cross-VM RTP cross-check is never computed.
5. `peak_concurrent` is computed only on UAC side and not in aggregate.
6. No PDD breakdown (where in the signaling chain is time being spent).

### Additions to `MetricsCollector`

```python
class MetricsCollector:
    # ... existing fields ...

    # NEW accumulators
    _pdd_breakdown: list[dict]   # list of {invite_to_100, 100_to_180, 180_to_200}
    _rtp_asymmetry_flags: Counter # OK/WARNING/CRITICAL counts
    _call_spines: list            # completed correlated spines

    def record_call_result(self, result: CallResult):
        # ... existing logic ...

        # NEW: PDD breakdown accumulation
        m = result.sip_milestones
        if m.ringing_180_ms > 0:
            self._pdd_breakdown.append({
                "invite_to_100_ms":  m.trying_100_ms - m.invite_sent_ms,
                "100_to_180_ms":     m.ringing_180_ms - m.trying_100_ms,
                "180_to_200_ms":     m.ok_200_ms - m.ringing_180_ms,
            })

        # NEW: UAS-side total (from milestones, not hold_time)
        if result.direction == "uas":
            uas_total = m.bye_200_sent_ms - m.invite_received_ms
            # Store for UAS avg_total_ms

    def get_aggregate_metrics(self) -> dict:
        # Existing fields...
        base = { ... }

        # NEW additions
        if self._pdd_breakdown:
            base["avg_pdd_breakdown"] = {
                "invite_to_100_ms":  mean(d["invite_to_100_ms"] for d in self._pdd_breakdown),
                "100_to_180_ms":     mean(d["100_to_180_ms"] for d in self._pdd_breakdown),
                "180_to_200_ms":     mean(d["180_to_200_ms"] for d in self._pdd_breakdown),
            }

        base["rtp_health"] = {
            "ok": self._rtp_asymmetry_flags["OK"],
            "warning": self._rtp_asymmetry_flags["WARNING"],
            "critical": self._rtp_asymmetry_flags["CRITICAL"],
        }

        return base
```

### New Derived Fields in Run JSON `aggregate`

```json
"aggregate": {
  "run_id": "run-20260318_201306",
  "total_attempted": 1,
  "total_completed": 1,
  "total_failed": 0,
  "aggregate_asr": 100,
  "avg_pdd_ms": 319.94,
  "avg_pdd_breakdown": {
    "invite_to_100_ms": 12.3,
    "100_to_180_ms":    277.8,
    "180_to_200_ms":    29.8
  },
  "avg_hold_ms": 5018.25,
  "rtp_health": {
    "ok": 1,
    "warning": 0,
    "critical": 0
  },
  "media_verified_count": 1,
  "media_failed_count": 0,
  "scenario": "basic_call"
}
```

The `avg_pdd_breakdown` is the single most useful diagnostic number in the aggregate — it tells you whether latency is in network transit (invite_to_100), CM alerting/processing (100_to_180), or codec negotiation (180_to_200).

---

## 9. Kamailio Siptrace Parser

### Format (confirmed from your .data file)

```
||||||||||||||||||||
====================
tag: snd
pid: 51
time: 1774180429.815566
date: Sun Mar 22 11:53:49 2026
proto: tcp ipv4
srcip: 0.0.0.0
srcport: 5060
dstip: 10.42.0.74
dstport: 5060
~~~~~~~~~~~~~~~~~~~~
<raw SIP message here — may be multi-line>
||||||||||||||||||||   ← record separator
```

This is plain text. No binary library needed.

### Parser Module: `callflow_tool/mcp_server/kamailio_parser.py`

```python
"""
Parses Kamailio siptrace .data files.
Format: records delimited by '||||||||||||||||||||' lines.
Each record: header lines (key: value) followed by '~~~~~~~~~~~~~~~~~~~~', then raw SIP.
"""
from dataclasses import dataclass, field
from typing import Iterator
import re

RECORD_SEP  = "||||||||||||||||||||"
BODY_SEP    = "~~~~~~~~~~~~~~~~~~~~"


@dataclass
class SipTraceRecord:
    tag: str       = ""   # "snd" or "rcv"
    pid: int       = 0
    ts_epoch_us: float = 0.0
    date_str: str  = ""
    proto: str     = ""
    srcip: str     = ""
    srcport: int   = 0
    dstip: str     = ""
    dstport: int   = 0
    raw_sip: str   = ""

    # Parsed from raw_sip
    call_id: str   = ""
    method: str    = ""    # "INVITE", "BYE", "OPTIONS", etc.
    sip_code: int  = 0     # 0 if request, 100-699 if response
    from_tag: str  = ""
    to_tag: str    = ""
    cseq: str      = ""


def parse_siptrace_file(path: str) -> Iterator[SipTraceRecord]:
    """Yield SipTraceRecord for each complete record in the file."""
    with open(path, "r", errors="replace") as f:
        content = f.read()

    blocks = content.split(RECORD_SEP)
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        rec = _parse_block(block)
        if rec:
            yield rec


def _parse_block(block: str) -> SipTraceRecord | None:
    if BODY_SEP not in block:
        return None

    header_part, _, sip_part = block.partition(BODY_SEP)
    rec = SipTraceRecord(raw_sip=sip_part.strip())

    for line in header_part.strip().splitlines():
        line = line.strip()
        if not line or line.startswith("="):
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            key = key.strip().lower().replace(" ", "_")
            val = val.strip()
            if key == "tag":       rec.tag = val
            elif key == "pid":     rec.pid = int(val) if val.isdigit() else 0
            elif key == "time":    rec.ts_epoch_us = float(val)
            elif key == "date":    rec.date_str = val
            elif key == "proto":   rec.proto = val
            elif key == "srcip":   rec.srcip = val
            elif key == "srcport": rec.srcport = int(val) if val.isdigit() else 0
            elif key == "dstip":   rec.dstip = val
            elif key == "dstport": rec.dstport = int(val) if val.isdigit() else 0

    _enrich_from_sip(rec)
    return rec if rec.call_id else None


_CALL_ID_RE = re.compile(r"^Call-ID:\s*(.+)$", re.MULTILINE | re.IGNORECASE)
_FROM_TAG_RE = re.compile(r"^From:.*?tag=([^\s;>]+)", re.MULTILINE | re.IGNORECASE)
_TO_TAG_RE   = re.compile(r"^To:.*?tag=([^\s;>]+)", re.MULTILINE | re.IGNORECASE)
_CSEQ_RE     = re.compile(r"^CSeq:\s*(\d+\s+\S+)", re.MULTILINE | re.IGNORECASE)
_STATUS_RE   = re.compile(r"^SIP/2\.0\s+(\d{3})", re.MULTILINE)
_METHOD_RE   = re.compile(r"^([A-Z]+)\s+sip:", re.MULTILINE)


def _enrich_from_sip(rec: SipTraceRecord) -> None:
    sip = rec.raw_sip
    m = _CALL_ID_RE.search(sip)
    if m: rec.call_id = m.group(1).strip()

    m = _FROM_TAG_RE.search(sip)
    if m: rec.from_tag = m.group(1)

    m = _TO_TAG_RE.search(sip)
    if m: rec.to_tag = m.group(1)

    m = _CSEQ_RE.search(sip)
    if m: rec.cseq = m.group(1).strip()

    m = _STATUS_RE.search(sip)
    if m:
        rec.sip_code = int(m.group(1))
    else:
        m = _METHOD_RE.search(sip)
        if m: rec.method = m.group(1)


def find_records_for_call(path: str, call_id: str) -> list[SipTraceRecord]:
    """Return all records matching a given Call-ID, sorted by timestamp."""
    return sorted(
        (r for r in parse_siptrace_file(path) if r.call_id == call_id),
        key=lambda r: r.ts_epoch_us
    )
```

### kubectl Pull Integration

```python
# callflow_tool/mcp_server/k8s_collector.py

import asyncio
import subprocess
from pathlib import Path
from datetime import datetime, timezone


async def pull_kamailio_siptrace(
    namespace: str,
    pod_name: str,         # e.g. "kamailio-lb-0" or "kamailio-backend-0"
    remote_path: str,      # e.g. "/var/log/kamailio/siptrace-2026-03-21--10-52-18.data"
    local_dir: Path,
    run_id: str,
) -> Path | None:
    """
    kubectl cp a siptrace file from a pod to a local directory.
    Returns the local path if successful, None if kubectl is unavailable or fails.
    Non-blocking: failure does not raise, just returns None.
    """
    local_path = local_dir / f"{run_id}_{pod_name}_{Path(remote_path).name}"
    if local_path.exists():
        return local_path  # already pulled

    cmd = ["kubectl", "cp",
           f"{namespace}/{pod_name}:{remote_path}",
           str(local_path)]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
        if proc.returncode != 0:
            raise RuntimeError(stderr.decode())
        return local_path
    except Exception as e:
        # Non-fatal — siptrace enrichment is optional
        import logging
        logging.getLogger(__name__).warning(f"kubectl cp failed for {pod_name}: {e}")
        return None
```

### Siptrace Files to Pull

Based on your pod layout:

| Pod | Log Path | Notes |
|-----|----------|-------|
| `kamailio-lb-0` | `/var/log/kamailio/siptrace-YYYY-MM-DD--HH-MM-SS.data` | Leg A and Leg B both visible here |
| `kamailio-backend-0` | `/var/log/kamailio/siptrace-YYYY-MM-DD--HH-MM-SS.data` | Internal dispatch only |

Pull `kamailio-lb-0` first. Its siptrace file has both the SBC-facing messages (Call-ID from UAC) and the CM-facing messages (Call-ID from B2BUA). This is the most valuable file.

The file to pull is the one whose timestamp range overlaps with the run window. Derive from `run.started_at`.

---

## 10. Feature Scenario Engine — Hold/Unhold

### Architecture: Scenario as a First-Class Parameter

Scenarios extend the existing `_execute_call()` pattern. A scenario is selected by a `scenario: str` field in `VMConfig`. The call engine delegates to a scenario-specific method after the initial dialog is established.

```python
# config.py — add to VMConfig
scenario: str = "basic_call"   # "basic_call" | "hold_unhold" | "attended_transfer"

# Scenario parameters (only relevant for non-basic scenarios)
scenario_hold_duration_seconds: float = 5.0
scenario_pre_hold_rtp_seconds: float = 3.0
scenario_post_hold_rtp_seconds: float = 3.0
```

### Hold/Unhold Implementation in `call_engine.py`

```python
# call_engine.py

async def _execute_hold_unhold(
    self,
    agent: ExtensionAgent,
    result: CallResult,
    rtp_ep: RtpEndpoint | None
) -> None:
    """
    Called from _execute_call() after ACK is sent (dialog established).
    Executes: RTP active → re-INVITE(hold) → wait → re-INVITE(unhold) → RTP active → BYE.
    """
    cfg = self._config
    pre_hold_s  = cfg.scenario_pre_hold_rtp_seconds
    hold_dur_s  = cfg.scenario_hold_duration_seconds
    post_hold_s = cfg.scenario_post_hold_rtp_seconds

    assertions = {
        "re_invite_count":      {"expected": 2, "actual": 0, "pass": False},
        "media_state_sequence": {"expected": ["ACTIVE", "HELD", "ACTIVE"], "actual": [], "pass": False},
        "asr":                  {"expected": 100, "actual": 0, "pass": False},
    }

    media_states = []

    # Phase 1: RTP active for pre_hold_s
    if rtp_ep:
        media_states.append("ACTIVE")
        self._emit_call_event(result.call_id, result.caller, "SCENARIO_PHASE",
                              direction="uac", phase="PRE_HOLD_RTP")
        await rtp_ep.run_burst(duration=pre_hold_s)

    # Phase 2: Hold — re-INVITE with a=inactive
    self._emit_call_event(result.call_id, result.caller, "HOLD_REINVITE_SENT",
                          direction="uac", milestone_ms=self._elapsed_ms(result))
    ok_200 = await agent.send_reinvite_hold(result.call_id)
    if not ok_200:
        result.failure_reason = "HOLD_REINVITE_FAILED"
        return
    assertions["re_invite_count"]["actual"] += 1
    media_states.append("HELD")
    result.sip_milestones.hold_reinvite_ok_ms = self._elapsed_ms(result)

    self._emit_call_event(result.call_id, result.caller, "HOLD_CONFIRMED",
                          direction="uac", milestone_ms=self._elapsed_ms(result))

    # Phase 3: Hold silence
    await asyncio.sleep(hold_dur_s)

    # Phase 4: Unhold — re-INVITE with a=sendrecv
    self._emit_call_event(result.call_id, result.caller, "UNHOLD_REINVITE_SENT",
                          direction="uac", milestone_ms=self._elapsed_ms(result))
    ok_200 = await agent.send_reinvite_unhold(result.call_id)
    if not ok_200:
        result.failure_reason = "UNHOLD_REINVITE_FAILED"
        return
    assertions["re_invite_count"]["actual"] += 1
    media_states.append("ACTIVE")
    result.sip_milestones.unhold_reinvite_ok_ms = self._elapsed_ms(result)

    self._emit_call_event(result.call_id, result.caller, "UNHOLD_CONFIRMED",
                          direction="uac", milestone_ms=self._elapsed_ms(result))

    # Phase 5: RTP active for post_hold_s
    if rtp_ep:
        await rtp_ep.run_burst(duration=post_hold_s)

    # Evaluate assertions
    assertions["re_invite_count"]["pass"] = (
        assertions["re_invite_count"]["actual"] == assertions["re_invite_count"]["expected"]
    )
    assertions["media_state_sequence"]["actual"] = media_states
    assertions["media_state_sequence"]["pass"] = (media_states == ["ACTIVE", "HELD", "ACTIVE"])
    assertions["asr"]["actual"] = 100 if result.success else 0
    assertions["asr"]["pass"] = result.success

    result.scenario_assertions = assertions
    self._emit_call_event(result.call_id, result.caller, "SCENARIO_COMPLETE",
                          direction="uac", assertions=assertions)
```

### re-INVITE Methods in `extension_agent.py`

Two new methods on `ExtensionAgent`:

```python
async def send_reinvite_hold(self, call_id: str) -> bool:
    """
    Send re-INVITE with a=inactive (hold).
    Returns True if 200 OK received.
    """
    dlg = self._dialogs.get(call_id)
    if not dlg:
        return False

    # Build re-INVITE: increment CSeq, SDP with a=inactive
    dlg.cseq += 1
    sdp = self._build_sdp(port=dlg.rtp_local_port, direction="inactive")
    reinvite = self._build_reinvite(dlg, sdp)

    await self._transport.send(reinvite)

    try:
        response = await asyncio.wait_for(
            self._wait_for_event(call_id, "200_REINVITE"), timeout=5.0
        )
        return True
    except asyncio.TimeoutError:
        return False


async def send_reinvite_unhold(self, call_id: str) -> bool:
    """
    Send re-INVITE with a=sendrecv (unhold).
    Returns True if 200 OK received.
    """
    # Identical to above except direction="sendrecv"
    dlg = self._dialogs.get(call_id)
    if not dlg:
        return False

    dlg.cseq += 1
    sdp = self._build_sdp(port=dlg.rtp_local_port, direction="sendrecv")
    reinvite = self._build_reinvite(dlg, sdp)

    await self._transport.send(reinvite)

    try:
        await asyncio.wait_for(
            self._wait_for_event(call_id, "200_REINVITE"), timeout=5.0
        )
        return True
    except asyncio.TimeoutError:
        return False
```

**SDP direction field:** Add `direction: str = "sendrecv"` parameter to `_build_sdp()`. When `direction="inactive"`, the SDP `a=` line is `a=inactive`. When `direction="sendrecv"`, it is `a=sendrecv`. This is the only SDP change.

### UAS Side: Handle re-INVITE

`UasAutoAnswer._handle_call()` must handle incoming re-INVITEs (hold/unhold). Currently it only handles the initial INVITE. Add:

```python
# In _handle_call(), after ACK is received, enter a loop:
while not bye_received:
    event = await self._wait_for_any_event(
        call_id, ["BYE", "REINVITE"], timeout=120
    )
    if event.type == "BYE":
        bye_received = True
    elif event.type == "REINVITE":
        # Answer re-INVITE with 200 OK, mirror the direction
        # If incoming SDP has a=inactive → respond with a=inactive (held)
        # If incoming SDP has a=sendrecv → respond with a=sendrecv (resumed)
        direction = _extract_sdp_direction(event.sip_message)
        sdp_answer = self._build_sdp(port=dlg.rtp_local_port, direction=direction)
        await self._send_200_reinvite(call_id, sdp_answer)
        self._emit_call_event(call_id, ext, "UAS_REINVITE_ANSWERED",
                              direction="uas", sdp_direction=direction)
```

### New Endpoint in `metrics.py`

```python
GET /api/scenarios          → list available scenarios with metadata
GET /api/scenario/{id}      → scenario definition (steps, assertions)
GET /api/calls/scenario     → call events filtered to scenario events only
```

---

## 11. MCP Server Implementation

### Module: `callflow_tool/mcp_server/`

```
callflow_tool/mcp_server/
├── __init__.py
├── main.py           ← FastAPI app, startup, tool registration
├── tools.py          ← Tool implementations (read logs, query DB, kubectl)
├── agent.py          ← Agent loop (Claude API calls with tools)
├── kamailio_parser.py  ← (from §9)
└── k8s_collector.py    ← (from §9)
```

### `main.py` — Server Startup

```python
# callflow_tool/mcp_server/main.py
"""
MCP Server — runs as a separate process alongside the traffic engine.
Start: python -m callflow_tool.mcp_server.main --port 8090
"""
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
import uvicorn, argparse

app = FastAPI(title="CCI MCP Server")

@app.post("/agent/chat")
async def agent_chat(body: dict):
    """
    Entry point from GUI Chat Panel.
    body: { "message": "Why did call 6290370 fail?", "run_id": "run-..." }
    Returns: streaming text response.
    """
    from .agent import run_agent
    return StreamingResponse(
        run_agent(body["message"], context=body),
        media_type="text/plain"
    )

@app.get("/tools")
async def list_tools():
    from .tools import TOOL_REGISTRY
    return {"tools": list(TOOL_REGISTRY.keys())}

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8090)
    p.add_argument("--logs-dir", default="./logs")
    args = p.parse_args()
    uvicorn.run(app, host="0.0.0.0", port=args.port)
```

### `tools.py` — Tool Implementations

```python
# callflow_tool/mcp_server/tools.py
"""
Each tool is a Python async function.
The agent calls these when Claude decides to use them.
"""
import json, glob
from pathlib import Path
from .kamailio_parser import find_records_for_call
from .k8s_collector import pull_kamailio_siptrace

LOGS_DIR = Path("./logs")   # configurable at startup


async def get_run_summary(run_id: str) -> dict:
    """Return the run JSON summary for a given run_id."""
    pattern = str(LOGS_DIR / f"{run_id}.json")
    files = glob.glob(pattern)
    if not files:
        return {"error": f"Run {run_id} not found"}
    return json.loads(Path(files[0]).read_text())


async def get_call_detail(call_id: str, run_id: str = "") -> dict:
    """Return enriched call spine for a given Call-ID (searches all runs if run_id omitted)."""
    for f in sorted(LOGS_DIR.glob("*.json"), reverse=True):
        data = json.loads(f.read_text())
        for spine in data.get("call_spines", []):
            if (spine.get("uac_leg", {}).get("call_id") == call_id or
                spine.get("uas_leg", {}).get("call_id") == call_id):
                return spine
    return {"error": f"Call-ID {call_id} not found"}


async def list_anomalies(run_id: str) -> dict:
    """Return all calls in a run with any anomaly flag set."""
    run = await get_run_summary(run_id)
    if "error" in run:
        return run
    anomalies = []
    for spine in run.get("call_spines", []):
        flags = []
        mc = spine.get("media_cross_check", {})
        if mc.get("overall_status") == "DEGRADED":
            flags.append(f"RTP_ASYMMETRY: {mc}")
        uac = spine.get("uac_leg", {})
        if uac.get("pdd_ms", 0) > 500:
            flags.append(f"HIGH_PDD: {uac['pdd_ms']}ms")
        if spine.get("uac_leg", {}).get("result") != "COMPLETED":
            flags.append(f"CALL_FAILED: {uac.get('failure_reason')}")
        if flags:
            anomalies.append({"spine_id": spine["spine_id"], "flags": flags})
    return {"run_id": run_id, "anomaly_count": len(anomalies), "anomalies": anomalies}


async def compare_runs(run_id_1: str, run_id_2: str) -> dict:
    """Diff key metrics between two runs."""
    r1 = await get_run_summary(run_id_1)
    r2 = await get_run_summary(run_id_2)
    if "error" in r1 or "error" in r2:
        return {"error": "One or both runs not found"}

    def diff(a, b, key, label):
        v1, v2 = a.get(key, 0), b.get(key, 0)
        delta = v2 - v1
        return {"metric": label, "run_1": v1, "run_2": v2, "delta": round(delta, 2),
                "direction": "↑ better" if delta < 0 and "pdd" in key.lower() else
                             "↑ better" if delta > 0 and "asr" in key.lower() else "changed"}

    agg1, agg2 = r1.get("aggregate", {}), r2.get("aggregate", {})
    return {
        "comparison": [
            diff(agg1, agg2, "aggregate_asr", "ASR %"),
            diff(agg1, agg2, "avg_pdd_ms", "Avg PDD (ms)"),
            diff(agg1, agg2, "avg_hold_ms", "Avg Hold (ms)"),
            diff(agg1, agg2, "total_failed", "Failed Calls"),
        ]
    }


async def fetch_kamailio_trace(call_id: str, run_id: str = "") -> dict:
    """
    Pull siptrace from kamailio-lb-0 pod and search for call_id.
    Returns ordered SIP events for that call.
    """
    local_dir = LOGS_DIR / "siptrace_cache"
    local_dir.mkdir(exist_ok=True)

    # Try to pull latest siptrace file from kamailio-lb-0
    pulled = await pull_kamailio_siptrace(
        namespace="cci",
        pod_name="kamailio-lb-0",
        remote_path="/var/log/kamailio/",   # collector resolves latest file
        local_dir=local_dir,
        run_id=run_id or "latest"
    )

    if not pulled:
        return {"status": "unavailable", "reason": "kubectl cp failed or pod unreachable"}

    records = find_records_for_call(str(pulled), call_id)
    if not records:
        return {"status": "not_found", "call_id": call_id}

    return {
        "status": "ok",
        "call_id": call_id,
        "event_count": len(records),
        "events": [
            {
                "ts_epoch_us": r.ts_epoch_us,
                "tag": r.tag,
                "src": f"{r.srcip}:{r.srcport}",
                "dst": f"{r.dstip}:{r.dstport}",
                "method": r.method or f"{r.sip_code}",
                "cseq": r.cseq,
            }
            for r in records
        ]
    }


# Tool registry: name → (function, description, parameter schema)
TOOL_REGISTRY = {
    "get_run_summary":      (get_run_summary,     "Get aggregate metrics for a run",      {"run_id": "str"}),
    "get_call_detail":      (get_call_detail,      "Get full call spine for a Call-ID",    {"call_id": "str", "run_id": "str?"}),
    "list_anomalies":       (list_anomalies,       "List anomalous calls in a run",        {"run_id": "str"}),
    "compare_runs":         (compare_runs,         "Diff two runs' key metrics",           {"run_id_1": "str", "run_id_2": "str"}),
    "fetch_kamailio_trace": (fetch_kamailio_trace, "Pull Kamailio SIP trace for a call",   {"call_id": "str", "run_id": "str?"}),
}
```

### `agent.py` — The Agent Loop

```python
# callflow_tool/mcp_server/agent.py
"""
Agent loop: sends user question to Claude with tool definitions.
Claude decides which tools to call. We execute them and feed results back.
Streams the final response.
"""
import json
from typing import AsyncIterator
import anthropic
from .tools import TOOL_REGISTRY

client = anthropic.Anthropic()   # reads ANTHROPIC_API_KEY from env

SYSTEM_PROMPT = """
You are a SIP/VoIP call analysis agent for the CCI Traffic Tool.
You help engineers debug call flows on Avaya SBC, Kamailio, and Avaya CM infrastructure.

When analyzing a call:
1. Start with the run summary to understand overall health.
2. For specific calls, use get_call_detail to see the full call spine with both UAC and UAS legs.
3. Note that Avaya CM is a B2BUA — Leg A and Leg B have different Call-IDs (leg_a and leg_b in the spine).
4. Use fetch_kamailio_trace to get actual SIP message flow from infrastructure logs.
5. Cross-check RTP: UAC tx should ≈ UAS rx. Large deltas indicate SBC probe inflation or media path issues.
6. PDD breakdown: invite_to_100 = network latency; 100_to_180 = CM processing/alerting; 180_to_200 = codec negotiation.

Be concise. Cite specific values from the data. Do not speculate without data.
"""


def _build_tool_spec() -> list[dict]:
    tools = []
    for name, (fn, desc, params) in TOOL_REGISTRY.items():
        properties = {
            k.rstrip("?"): {"type": "string", "description": k}
            for k in params.keys()
        }
        required = [k for k in params.keys() if not k.endswith("?")]
        tools.append({
            "name": name,
            "description": desc,
            "input_schema": {
                "type": "object",
                "properties": properties,
                "required": required
            }
        })
    return tools


async def run_agent(user_message: str, context: dict) -> AsyncIterator[str]:
    """
    Run the agent loop for a user question.
    Yields text chunks for streaming to the chat panel.
    """
    messages = [{"role": "user", "content": user_message}]
    tools = _build_tool_spec()

    while True:
        response = client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=2048,
            system=SYSTEM_PROMPT,
            tools=tools,
            messages=messages,
        )

        # Collect any text to stream
        for block in response.content:
            if block.type == "text":
                yield block.text

        # If Claude wants to use tools
        if response.stop_reason == "tool_use":
            tool_results = []
            for block in response.content:
                if block.type == "tool_use":
                    fn, _, _ = TOOL_REGISTRY[block.name]
                    result = await fn(**block.input)
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result)
                    })

            # Add assistant response + tool results to history, continue loop
            messages.append({"role": "assistant", "content": response.content})
            messages.append({"role": "user", "content": tool_results})

        else:
            # end_turn or max_tokens — done
            break
```

---

## 12. Database — Optional, Non-Blocking

### Principle: Graceful Degradation

The database is **never in the critical path**. The traffic engine writes JSON files regardless. The database is an optional enrichment layer that the MCP server and GUI can use for historical queries if available.

**The engine and MCP server start and run fully even if PostgreSQL is unreachable.**

### Database Module: `callflow_tool/mcp_server/database.py`

```python
# callflow_tool/mcp_server/database.py
"""
Optional PostgreSQL integration. If DB_URL env var is not set or DB is
unreachable, all operations are no-ops that log a warning and return None.
"""
import os
import logging
from typing import Any

logger = logging.getLogger(__name__)

_pool = None
DB_URL = os.environ.get("CCI_DB_URL", "")    # e.g. "postgresql://user:pw@localhost/cci"


async def init_db_pool() -> None:
    """
    Called once at MCP server startup. Silently skips if DB_URL not set.
    """
    global _pool
    if not DB_URL:
        logger.info("CCI_DB_URL not set — database features disabled")
        return
    try:
        import asyncpg
        _pool = await asyncpg.create_pool(DB_URL, min_size=1, max_size=5, command_timeout=5)
        await _ensure_schema()
        logger.info("Database connected and schema verified")
    except Exception as e:
        logger.warning(f"Database unavailable (non-fatal): {e}. Running without DB.")
        _pool = None


async def db_exec(query: str, *args) -> Any:
    """Execute a write query. No-op if pool is None."""
    if _pool is None:
        return None
    try:
        async with _pool.acquire() as conn:
            return await conn.execute(query, *args)
    except Exception as e:
        logger.warning(f"DB write failed (non-fatal): {e}")
        return None


async def db_fetch(query: str, *args) -> list:
    """Execute a read query. Returns empty list if pool is None."""
    if _pool is None:
        return []
    try:
        async with _pool.acquire() as conn:
            return await conn.fetch(query, *args)
    except Exception as e:
        logger.warning(f"DB read failed (non-fatal): {e}")
        return []


async def _ensure_schema() -> None:
    """Create tables if they don't exist. Idempotent."""
    schema_sql = """
    CREATE TABLE IF NOT EXISTS runs (
        run_id       TEXT PRIMARY KEY,
        started_at   TIMESTAMPTZ,
        ended_at     TIMESTAMPTZ,
        traffic_mode TEXT,
        scenario     TEXT DEFAULT 'basic_call',
        pair_id      TEXT,
        config       JSONB,
        aggregate    JSONB
    );

    CREATE TABLE IF NOT EXISTS call_spines (
        spine_id          TEXT PRIMARY KEY,
        run_id            TEXT REFERENCES runs(run_id),
        uac_ext           TEXT,
        uas_ext           TEXT,
        scenario          TEXT DEFAULT 'basic_call',
        result            TEXT,
        started_at        TIMESTAMPTZ,
        uac_call_id       TEXT,
        uas_call_id       TEXT,
        pdd_ms            FLOAT,
        hold_ms           FLOAT,
        total_ms          FLOAT,
        uac_rtp_tx        INT,
        uac_rtp_rx        INT,
        uas_rtp_tx        INT,
        uas_rtp_rx        INT,
        sbc_uac_relay     TEXT,
        sbc_uas_relay     TEXT,
        rtp_asymmetry_flag TEXT,
        media_status      TEXT,
        failure_reason    TEXT,
        sip_milestones    JSONB,
        scenario_assertions JSONB,
        pdd_breakdown     JSONB
    );

    CREATE TABLE IF NOT EXISTS sip_events (
        id            BIGSERIAL PRIMARY KEY,
        spine_id      TEXT REFERENCES call_spines(spine_id),
        source        TEXT,
        direction     TEXT,
        method        TEXT,
        sip_code      INT,
        call_id_raw   TEXT,
        ts_epoch_us   BIGINT,
        offset_ms     FLOAT,
        raw_snippet   TEXT
    );

    CREATE TABLE IF NOT EXISTS metric_snapshots (
        id        BIGSERIAL PRIMARY KEY,
        run_id    TEXT REFERENCES runs(run_id),
        vm_id     TEXT,
        ts        TIMESTAMPTZ,
        snapshot  JSONB
    );

    CREATE TABLE IF NOT EXISTS scenarios (
        scenario_id  TEXT PRIMARY KEY,
        name         TEXT,
        description  TEXT,
        definition   JSONB
    );
    """
    if _pool:
        async with _pool.acquire() as conn:
            await conn.execute(schema_sql)
```

### Database Health in MCP Server Startup Output

```
[INFO] CCI MCP Server starting on port 8090
[INFO] Logs directory: ./logs
[INFO] Database: CONNECTED (postgresql://...@localhost/cci)    ← or:
[INFO] Database: DISABLED (CCI_DB_URL not set)
[INFO] kubectl: AVAILABLE (context: rancher-desktop)           ← or:
[INFO] kubectl: UNAVAILABLE (Kamailio siptrace enrichment disabled)
[INFO] Claude API: AVAILABLE (ANTHROPIC_API_KEY set)
[INFO] Ready.
```

---

## 13. Implementation Order & Timeline

### Recommended Order (each step is independently deployable and testable)

**Week 1 — Foundation (No UI changes, all backend)**

| Day | Task | Module |
|-----|------|--------|
| 1 | Clock setup on all VMs, add `ts_utc` + `ts_mono_ms` to all events | `call_engine.py`, `metrics.py` |
| 1 | Add `peer_ext` to `CallResult` and UAS `_handle_call` | `call_engine.py` |
| 2 | `_CountingProtocol` source filter + RTP validity check | `rtp_stream.py` |
| 2 | `set_remote_rtp_addr()` wiring in `_execute_call` | `call_engine.py` |
| 3 | `SipMilestones` dataclass + all UAC milestone logging | `call_engine.py` |
| 3 | All UAS milestone logging | `call_engine.py` |
| 4 | `_build_call_spines()` + UAS event collection in orchestrator | `main.py` |
| 4 | Updated `run-*.json` structure with `call_spines` array | `main.py` |
| 5 | `MetricsCollector` PDD breakdown + RTP health aggregation | `metrics.py` |
| 5 | `GET /api/calls/{call_id}` endpoint, updated `GET /api/calls` | `metrics.py` |

**Week 2 — Feature Scenarios Backend**

| Day | Task | Module |
|-----|------|--------|
| 6-7 | `send_reinvite_hold()` + `send_reinvite_unhold()` on ExtensionAgent | `extension_agent.py` |
| 6-7 | UAS re-INVITE handler loop in `_handle_call` | `call_engine.py` |
| 8 | `_execute_hold_unhold()` scenario engine + assertions | `call_engine.py` |
| 8 | `scenario` field in VMConfig + scenario routing in `_execute_call` | `config.py`, `call_engine.py` |
| 9 | `/api/scenarios` endpoint + scenario WebSocket events | `metrics.py` |
| 9 | Siptrace parser module | `mcp_server/kamailio_parser.py` |
| 10 | kubectl pull module | `mcp_server/k8s_collector.py` |

**Week 3 — MCP Server + GUI Mode Gate**

| Day | Task | Module |
|-----|------|--------|
| 11-12 | MCP server skeleton + tools implementation | `mcp_server/` |
| 11-12 | Agent loop (Claude API integration) | `mcp_server/agent.py` |
| 13 | Database module (optional, non-blocking) | `mcp_server/database.py` |
| 13 | GUI: ModeGate nav toggle, route rename `/load-test/*` | `gui/` |
| 14 | GUI: ScenarioHome + ScenarioConfigPanel | `gui/app/scenarios/` |
| 14 | GUI: ChatPanel component (streaming text from MCP server) | `gui/components/agent/` |

**Week 4 — SIP Ladder GUI + CallSpineCard + Polish**

| Day | Task | Module |
|-----|------|--------|
| 15-16 | `SipLadderLive` — real-time SVG ladder component | `gui/components/scenarios/` |
| 15-16 | `ScenarioResultPanel` — assertions + full ladder + AI analysis | `gui/components/scenarios/` |
| 17 | `CallSpineCard` — replaces CallTable with correlated spine view | `gui/components/postrun/` |
| 17 | PDD breakdown donut chart in Summary | `gui/components/dashboard/` |
| 18-19 | VP demo rehearsal run — smoke test full flow end-to-end | All |
| 20 | Buffer / bug fix day | — |

**Total: 4 weeks to VP demo ready.**

### Go Migration Addendum (Phase 3)

After Python implementation is complete and verified, a separate `PHASE3_GO_MIGRATION_GUIDE.md` will cover:
- Port order follows `PHASE0_CODEBASE_ANALYSIS.md` Tier 1 → 2 → 3.
- MCP server stays Python (Python has the best LLM SDK ecosystem; no performance need to port).
- Database module stays Python.
- GUI (Next.js/TypeScript) — unchanged.
- Go rewrite targets: `sip_engine`, `call_engine`, `extension_agent`, `rtp_stream`, `pre_phase`, `metrics`, `config`, `main`. Same JSON API contract — GUI never changes.

---

---

## AMENDMENTS — Supersede sections where noted

### AMD-1: RTP Section 6 — Replace strict filter with dual counting
Section 6 is SUPERSEDED. Use three counters:
- `rtp_rx_pkts`: all valid RTP (version=2, len>=12), any source — primary, unchanged semantics
- `rtp_rx_from_sbc_pkts`: valid RTP from expected SBC relay addr only — NEW
- `rtp_rx_other_pkts`: valid RTP from any other source — NEW diagnostic
MEDIA_VERIFIED logic unchanged (still uses `rtp_rx_pkts > 0`).
Asymmetry cross-check uses `rtp_rx_from_sbc_pkts`.
set_expected_src() populates after 200 OK SDP parse (UAC) or INVITE SDP parse (UAS).

### AMD-2: Section 9 (Kamailio Parser) — Placeholder only
Create file `callflow_tool/mcp_server/kamailio_parser.py` with module docstring and
`parse_siptrace_file()` stub that raises NotImplementedError("Phase 3"). Do not implement.

### AMD-3: Section 10 (Hold/Unhold backend) — Placeholder only
Add `scenario: str = "basic_call"` field to VMConfig. In `_execute_call()`, after ACK,
add: `if config.scenario != "basic_call": raise NotImplementedError(f"Scenario {config.scenario} not yet implemented")`.
Add `GET /api/scenarios` endpoint returning the registry with `hold_unhold` marked `status: "coming_soon"`.

### AMD-4: Section 11 (MCP Server) — Placeholder only
Create `callflow_tool/mcp_server/` directory with `__init__.py` and `main.py` that prints
"MCP Server — Phase 3" and exits 0. No tool implementations yet.

### AMD-5: Section 12 (Database) — Placeholder only
Create `callflow_tool/mcp_server/database.py` with `init_db_pool()` stub that logs
"Database: Phase 3 — not yet implemented" and returns None. Non-blocking.

### AMD-6: Timeline — Compress to 5 days
Day 1: Clock + CallResult/CallEvent enrichment + peer_ext (Section 2, 7)
Day 2: RTP dual-count fix + SBC relay addr extraction (Section 6 AMD-1) — **DONE**
Day 3: Call Spine correlation + UAS collection + run JSON restructure (Section 4) — **DONE** (AMD-7)
Day 4: Aggregator improvements + all new API endpoints (Section 8) — **DONE** (AMD-8)
Day 5: GUI SIP Ladder + CallSpineCard + Feature Scenario scaffolding (Sections 3, 5)

### AMD-7: Section 4 (Call Spine) — IMPLEMENTED with strategy pattern
Section 4 code samples are **superseded** by the implementation below. The design intent
(UAS collection, ext+time correlation, call_spines in run JSON) is preserved. Changes:

**Backend — `callflow_tool/traffic/main.py`:**
- `_build_call_spines()` replaced with a `CorrelationStrategy` chain pattern.
- `CorrelationStrategy` dataclass: `name`, `priority`, `matcher: Callable[[dict, dict], bool]`.
- Two built-in strategies in `CORRELATION_STRATEGIES` list (sorted by priority):
  1. `_strategy_gsid` (priority 1) — exact match on `gsid` / `x_gsid` field. Ready for future use
     when Avaya GSID header becomes available. Currently no-ops (field not populated).
  2. `_strategy_ext_time` (priority 2) — match by `(uac_ext → uas_ext)` pairing within ±3s window.
     Active now. This is the same logic as Section 4 but wrapped in the strategy interface.
- `_find_uas_match(uac_event, uas_candidates)` tries each strategy in priority order.
  Returns `(matched_event, strategy_name)` or `(None, "unmatched")`.
- `used_uas_indices: set[int]` prevents double-matching (one UAS event per spine).
- `correlation_method` values: `"gsid"` | `"ext_time"` | `"unmatched"`
  (supersedes Section 4's `"ext_time_window"` | `"uac_only"`).
- `call_ids` now includes a `note` field:
  `"CM generates a new Call-ID for Leg B. Legs correlated by: ext_time"`.
- New strategies are added by appending to `CORRELATION_STRATEGIES` list — no changes
  to `_build_call_spines()` or `_find_uas_match()` needed.

**GUI — event merge fix (supersedes Section 4 Step 3 JSON example):**
- `gui/app/run/page.tsx` — `fetchAndStoreCallEvents()`:
  `const allEvents = [...uacCalls, ...uasCalls]` (was: `uacCalls.length > 0 ? uacCalls : uasCalls`).
  Sorted by `ts_utc` ascending. Both sides always included.
- `gui/lib/api.ts` — new `getCallSpinesFor(ip, port)` fetches `GET /api/call-spines` from UAC backend.
  `buildAggregate()` uses `uacEvents` directly (UAC is source of truth for call attempts).
- `gui/store/traffic.ts` — new `callSpines: Record<string, unknown>[]` + `setCallSpines()`.
  Populated on `isFinal` alongside call events.
- `gui/components/postrun/DownloadReport.tsx` — report JSON includes `call_spines` as top-level field.
- `gui/types/index.ts` — `CallEvent` extended with: `ext`, `peer_ext`, `direction`, `ts_utc`,
  `rtp_rx_from_sbc_pkts`, `rtp_rx_other_pkts`, `rtp_asymmetry_flag`,
  `sbc_rtp_relay_ip`, `sbc_rtp_relay_port` (all optional).

**Updated run JSON structure (exported by GUI DownloadReport):**
```json
{
  "generated_at": "...",
  "run_id": "...",
  "aggregate": { ... },
  "final_uac_metrics": { ... },
  "final_uas_metrics": { ... },
  "config": { ... },
  "call_events": [ "...merged UAC+UAS, each with direction field, sorted by ts_utc..." ],
  "call_spines": [
    {
      "spine_id": "4001000->4001005@2026-03-23T12:12:40.587419+00:00",
      "correlation_method": "ext_time",
      "call_ids": {
        "leg_a": "3413966",
        "leg_b": "96ed22226b141f1b745050569b2422",
        "b2bua_boundary": "avaya_cm",
        "note": "CM generates a new Call-ID for Leg B. Legs correlated by: ext_time"
      },
      "uac_leg": { "...full UAC CallResult with direction: uac..." },
      "uas_leg": { "...full UAS CallResult with direction: uas..." },
      "media_cross_check": { "...uac_tx_vs_uas_rx, uas_tx_vs_uac_rx, overall_status..." },
      "kam_trace": null
    }
  ]
}
```

### AMD-8: Section 8 (Aggregator Improvements) — IMPLEMENTED
Section 8 aggregator additions are **implemented**. Do not re-implement. Actual code
uses slightly different method names than the Section 8 pseudocode — defer to source.

**`MetricsCollector` (callflow_tool/traffic/metrics.py) new fields in `__init__`:**
- `_pdd_breakdown_samples: list` — list of `{invite_to_100_ms, 100_to_180_ms, 180_to_200_ms}`
- `_rtp_health_counts: dict` — `{"OK": 0, "WARNING": 0, "CRITICAL": 0}`
- `_scenario_assertion_results: list` — per-call scenario assertion records

**Accumulation in `record_call()`:**
- PDD breakdown: computes deltas from `sip_milestones` when 180 + 100 are populated.
- RTP health: increments `_rtp_health_counts[flag]` from `rtp_asymmetry_flag`.
- Scenario assertions: appends `{call_id, scenario, assertions}` when present.
- `reset()` clears all three new fields.

**New methods:**
- `get_final_summary()` → returns `{avg_pdd_breakdown, rtp_health, scenario_result}`.
- `get_rtp_health_snapshot()` → returns `dict(self._rtp_health_counts)`.

**Wiring:**
- `GET /metrics` response includes `"rtp_health"` key.
- WebSocket push payload in `run_push_loop` includes `"rtp_health"` key.
- `GET /api/scenarios` returns `basic_call` (available) and `hold_unhold` (coming_soon).

**VMConfig additions (callflow_tool/traffic/config.py):**
- `scenario: str = "basic_call"`
- `scenario_hold_duration_seconds: float = 5.0`
- `scenario_pre_hold_rtp_seconds: float = 3.0`
- `scenario_post_hold_rtp_seconds: float = 3.0`

### AMD-9: AMD-1 addendum — per-endpoint asymmetry flag false positives
The dual-counting approach in AMD-1 is correct. However, testing revealed that the
**per-endpoint** asymmetry formula (`abs(tx - rx_from_sbc) / tx`) still produces
false positives (CRITICAL) in the confirmed B2BUA topology. Root causes:

1. **CM is an independent media source.** CM's media server (10.133.87.152) sends its own
   RTP through the SBC. Both UAC and UAS receive packets originating from CM, not just
   from each other. This inflates `rtp_rx_from_sbc_pkts` beyond `rtp_tx_pkts` on each side.
2. **Early media from 180 Ringing.** The 180 contains SDP with CM's media address.
   CM starts sending RTP before ACK, inflating UAC rx count by ~40 pkts at 50 pps.
3. **UAS sends fewer packets by design.** `run_until_cancelled()` produces ~101 pkts
   vs UAC's `run()` producing ~201 pkts. This alone creates a 50% delta.

Observed values (single basic call): UAC tx=201 rx=241 (CRITICAL 19.9%),
UAS tx=101 rx=301 (CRITICAL 198%). Both are false positives.

**The spine-level `media_cross_check`** (UAC-tx vs UAS-rx and vice versa) is the
more meaningful metric, but is also affected by CM injection. A correct formula
for per-endpoint health should check `rx >= expected_minimum` rather than `tx ≈ rx`.

**TODO (not yet implemented):**
- Replace per-endpoint asymmetry formula with threshold-based check:
  `flag = "OK" if rx >= (hold_time * pps * 0.3) else "WARNING" if rx > 0 else "CRITICAL"`.
- Add `rtp_health_note` string to aggregate explaining B2BUA topology effects.
- Consider adding `rtp_rx_from_cm_pkts` counter if CM's media server IP is known.

---

*PHASE2_IMPLEMENTATION_GUIDE.md — last updated: 2026-03-23*
*Status: Days 2-4 complete. Day 1 (clock + event enrichment) and Day 5 (GUI ladder + scenarios) remain.*
