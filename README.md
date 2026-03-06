# SBCAutomationTool

SBC (Session Border Controller) automation and traffic testing framework.

- **Callflow tool** — orchestrated SIP test execution via a web UI
- **Traffic engine** — asyncio-native, CPS-controlled SIP load generator

---

## Project Structure

```
SBCAutomationTool/
├── callflow_tool/
│   ├── useragent/json/linoxiderepo/   # Python SIP User Agent (existing)
│   │   ├── useragent.py               # Legacy entry point (JSON-driven)
│   │   ├── sipmessage.py, sipconstants.py, sdp.py
│   │   ├── parserandbuilder.py, authenticate.py, util.py
│   │   ├── invite.py, bye.py, prack.py, refer.py, update.py
│   │   ├── register.py, subscribe.py, notify.py, response.py
│   │   ├── transport.py, listenthread.py, messagebuffer.py
│   │   └── media.py, uasession.py, testreport.py
│   │
│   ├── traffic/                       # NEW: Async traffic engine (Phase 1)
│   │   ├── __init__.py
│   │   ├── config.py                  # VMConfig dataclass + ENV/YAML loader
│   │   ├── sip_engine.py              # Async UDP/TCP/TLS transport
│   │   ├── extension_agent.py         # One agent per extension
│   │   ├── pre_phase.py               # Bulk REGISTER + SUBSCRIBE
│   │   ├── call_engine.py             # CPS token bucket + call FSM
│   │   ├── metrics.py                 # TrafficMetrics + FastAPI server
│   │   └── main.py                    # Entrypoint
│   │
│   ├── callflow/
│   │   ├── js-sequence-diagrams-master/   # Flask orchestrator (port 7000)
│   │   └── homepage/                      # Landing page (port 6509)
│   └── autoDeploy/                    # VM provisioning (govc OVF)
│
├── sipp_scripts/                      # 100+ SIPp XML scenarios (manual/adhoc)
├── template/                          # Flask HTML templates (callflow UI)
├── Scripts/                           # DB utilities
├── requirements.txt                   # All Python dependencies
└── README.md
```

---

## Quick Start — Traffic Engine

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Create a Config File (optional)

```yaml
# config.yaml
vm_role: UAC
vm_id: uac-vm-1
uac_ext_start: 1001
uac_ext_end: 1250
uas_ext_start: 2001
uas_ext_end: 2250
sbc_host: 10.133.39.157
sbc_port: 5060
sip_transport: TCP
domain: sbc.company.com
sip_password: password
cps: 6
hold_time_seconds: 180
ramp_up_seconds: 30
metrics_interval: 10
metrics_port: 8080
coordinator_url: http://coordinator:8080
```

### 3. Run UAC VM

```bash
# Via YAML
python -m callflow_tool.traffic.main --config config_uac.yaml

# Via environment variables (no YAML needed)
VM_ROLE=UAC VM_ID=uac-vm-1 SBC_HOST=10.133.39.157 SIP_DOMAIN=sbc.company.com \
UAC_EXT_START=1001 UAC_EXT_END=1250 UAS_EXT_START=2001 UAS_EXT_END=2250 \
CPS=6 HOLD_TIME_SECONDS=180 \
python -m callflow_tool.traffic.main
```

### 4. Run UAS VM

```bash
VM_ROLE=UAS VM_ID=uas-vm-1 SBC_HOST=10.133.39.157 SIP_DOMAIN=sbc.company.com \
UAS_EXT_START=2001 UAS_EXT_END=2250 \
python -m callflow_tool.traffic.main
```

### 5. Validate Config (dry run)

```bash
python -m callflow_tool.traffic.main --config config.yaml --dry-run
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VM_ROLE` | `UAC` | `UAC` or `UAS` |
| `VM_ID` | `vm-1` | Unique VM identifier |
| `UAC_EXT_START` | `1001` | First UAC extension number |
| `UAC_EXT_END` | `1250` | Last UAC extension number |
| `UAS_EXT_START` | `2001` | First UAS extension number |
| `UAS_EXT_END` | `2250` | Last UAS extension number |
| `SBC_HOST` | `127.0.0.1` | SBC / SIP proxy IP |
| `SBC_PORT` | `5060` | SBC SIP port |
| `SIP_TRANSPORT` | `TCP` | `TCP`, `TLS`, or `UDP` |
| `SIP_DOMAIN` | `sbc.local` | SIP domain |
| `SIP_PASSWORD` | `password` | SIP auth password (all extensions) |
| `CPS` | `6` | Calls per second (UAC only) |
| `HOLD_TIME_SECONDS` | `180` | Call hold duration before BYE |
| `RAMP_UP_SECONDS` | `30` | Linear ramp-up before full CPS |
| `METRICS_INTERVAL` | `10` | Metrics snapshot interval (seconds) |
| `METRICS_PORT` | `8080` | FastAPI metrics server port |
| `COORDINATOR_URL` | `http://localhost:8080` | GUI coordinator URL |
| `REGISTER_RATE` | `50` | Max REGISTER/sec during pre-phase |
| `REGISTER_EXPIRES` | `3600` | Registration expiry (seconds) |
| `REGISTER_RETRY` | `3` | Max REGISTER retry attempts |
| `REGISTER_TIMEOUT` | `5` | Per-attempt timeout (seconds) |
| `LOCAL_HOST` | *(auto)* | Local IP to bind (empty = auto-detect) |
| `LOG_LEVEL` | `INFO` | `DEBUG`, `INFO`, `WARNING`, `ERROR` |
| `SKIP_SUBSCRIBE` | `false` | Skip SUBSCRIBE pre-phase |

---

## Concurrent Call Math

```
Per VM:      6 CPS × 180s hold  =  1,080 concurrent calls
2 UAC VMs:  12 CPS × 180s hold  =  2,160 concurrent calls on SBC
BHCC:       12 CPS × 3,600s     = 43,200 calls/hour  ✓  (target: 40,000)

SBC must support ≥ 2,200 simultaneous sessions (2,160 + 10% headroom).
```

---

## VM Layout

```
┌──────────────────────┐      TCP/TLS      ┌──────────────┐
│   UAC VM 1           │ ──────────────►   │              │
│   ext: 1001–1250     │                   │  SBC / Proxy │
│   6 CPS, 180s hold   │ ◄──────────────   │              │
└──────────────────────┘                   │              │
                                           │              │
┌──────────────────────┐      TCP/TLS      │              │
│   UAS VM 1           │ ──────────────►   │              │
│   ext: 2001–2250     │                   └──────────────┘
│   auto-answer        │ ◄──────────────
└──────────────────────┘

Each ext owns exactly ONE persistent socket.
CallEngine.next_pair():
  Call #1   → 1001 → 2001
  Call #2   → 1002 → 2002
  …
  Call #251 → 1001 → 2001  (pools wrap independently)
```

---

## Metrics API

Once the traffic engine is running, each VM exposes:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/metrics` | GET | Latest TrafficMetrics snapshot (JSON) |
| `/metrics/stream` | WebSocket | Push every `metrics_interval` seconds |
| `/api/test/status` | GET | `{ phase, running, elapsed_seconds }` |
| `/api/test/start` | POST | GUI coordinator hook (Phase 2) |
| `/api/test/stop` | POST | Trigger graceful shutdown |
| `/api/vms` | GET | VM info: role, ext range, CPS, ASR |

### Sample metrics response

```json
{
  "vm_id": "uac-vm-1",
  "phase": "TRAFFIC",
  "running": true,
  "cps_actual": 5.98,
  "concurrent_calls": 1074,
  "calls_attempted": 3240,
  "calls_completed": 3198,
  "calls_failed": 42,
  "asr": 98.7,
  "avg_pdd_ms": 143.2,
  "min_pdd_ms": 87.0,
  "max_pdd_ms": 412.5,
  "avg_hold_ms": 180021.4,
  "socket_count": 250,
  "registered_count": 250,
  "run_elapsed_seconds": 540.0
}
```

---

## SIP Call Flow (Phase 1)

```
UAC ExtensionAgent                    UAS ExtensionAgent (via SBC)
│
│── INVITE (Require: 100rel, SDP) ──────────────────►
│◄─ 100 Trying ──────────────────────────────────────
│◄─ 180 Ringing (RSeq: N) ─────────────────────────── ← reliable provisional
│── PRACK (RAck: N INVITE) ──────────────────────────►
│◄─ 200 OK (PRACK) ──────────────────────────────────
│◄─ 200 OK (INVITE) ─────────────────────────────────
│── ACK ─────────────────────────────────────────────►
│
│         [hold_time_seconds — asyncio.sleep, no RTP]
│
│── BYE ─────────────────────────────────────────────►
│◄─ 200 OK (BYE) ────────────────────────────────────
```

No RTP is sent during hold time. The traffic engine tests SBC signaling
capacity. RTP load testing can be added in a subsequent phase.

---

## Graceful Shutdown

Send `SIGTERM` or `SIGINT` (Ctrl+C) to the process:

1. Call engine stops firing new INVITEs
2. All active calls receive BYE (5s timeout per call)
3. All extensions send REGISTER expires=0
4. All transports are closed
5. Final metrics snapshot logged and pushed
6. Process exits 0

---

## Existing Callflow Tool (unchanged)

The Flask-based callflow orchestrator continues to work as before:

```bash
cd callflow_tool/callflow/js-sequence-diagrams-master
python app.py config.py
# Web UI on http://localhost:7000
```

The traffic engine is fully independent — it does not modify or interfere
with the existing orchestrator, user agent, or SIPp scripts.

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| One socket per extension | Mirrors existing useragent.py pattern. Stable Contact URI port. No reconnect per call. |
| asyncio throughout | Eliminates blocking recv/sleep spin loops. Scales to thousands of concurrent dialogs in a single process. |
| Reuse existing build/parse functions | `parserandbuilder.py`, `authenticate.py`, `util.py`, `invite.py`, etc. are battle-tested. Only the transport layer changed. |
| No RTP in Phase 1 | Isolates signaling capacity from media capacity. RTP can be added per-call in Phase 2. |
| ENV > YAML > defaults | Zero hardcoded values. Deployable via container env vars without any config file. |
| FastAPI in-process | No separate monitoring process. Shares the asyncio event loop. |
