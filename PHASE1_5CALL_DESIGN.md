# Phase 1 — 5-Call Traffic Run & Next Phase Design

## 1. Traffic Run Summary (5 Calls)

### Configuration
- **UAC**: ext 4001000–4001004 (5 extensions)
- **UAS**: ext 4001005–4001009 (5 extensions)
- **Pool wrap**: LCM(5,5) = 5 calls per wrap
- **Command**: `--pool-wraps 1` → max_calls = 5

### Results
| Metric | UAC | UAS |
|--------|-----|-----|
| Attempted | 5 | 4 (answered) |
| Completed | 4 | 4 |
| Failed | 1 (404 for ext 4001008) | 0 |
| ASR | 80% | 100% |
| Unregister | ✅ All 5 | ✅ All 5 |
| Process exit | ✅ PID exited 0 | ✅ PID exited 0 |

### Key Behavior
- **UAC** reached max_calls=5, POSTed to `peer_stop_url` (UAS /api/test/stop)
- **UAS** received POST, triggered graceful shutdown, unregistered, exited
- **Rainy-day**: Call #4 (4001003→4001008) got 404; UAC still completed and signaled UAS

---

## 2. Implemented Mechanisms

### 2.1 Pool-Wrap max_calls Derivation
```
max_calls = pool_wraps × LCM(uac_ext_count, uas_ext_count)
```
- `--pool-wraps 1` → 1 full cycle of extension pairing
- `--max-calls N` still overridable when `--pool-wraps` not set

### 2.2 UAC → UAS Signaling
- **peer_stop_url** in uac.yaml: `http://localhost:8081/api/test/stop`
- When UAC finishes (engine completes), POST to peer_stop_url
- UAS metrics server exposes POST /api/test/stop → triggers stop_event → shutdown

### 2.3 Graceful Shutdown (Both UAC & UAS)
1. Stop call engine / UAS loops
2. Drain active calls (BYE)
3. Unregister all extensions (REGISTER Contact:* Expires:0)
4. Close transports
5. Exit via `os._exit(0)` — no orphan Python processes

---

## 3. Call Attempts & Completion Capture

### Current State
- **Per-VM metrics**: GET /metrics, WS /metrics/stream on each VM's metrics_port
- **Structured logs**: `logs/traffic_<vm_id>_<timestamp>.log` with CALL_EVENT JSON lines

### Recommended Enhancements
| Mechanism | Purpose |
|-----------|---------|
| **Coordinator aggregator** | Poll UAC + UAS /metrics, merge into collective view |
| **Run ID** | Single ID per traffic run; UAC and UAS log same run_id |
| **Metrics snapshot file** | On shutdown, write `metrics_<run_id>_<vm_id>.json` for retrieval |
| **Call-level events** | Optional: stream CALL_EVENT to coordinator for real-time dashboard |

---

## 4. Unregister & Process Kill

### Current (Same Machine)
- Both UAC and UAS unregister on shutdown
- Both exit via `os._exit(0)` — no orphan processes

### Multi-VM / Remote
- **Coordinator** must: POST /api/test/stop to each UAS VM when UAC(s) complete
- **Process kill**: On Windows, coordinator can `taskkill /PID <pid> /F` if needed
- **Best practice**: Rely on POST /api/test/stop; kill only if VM unreachable

### Recommended Design
- Coordinator stores `{ vm_id, metrics_url, stop_url }` per VM
- On "traffic complete" → POST stop to all UAS VMs
- Optional: Coordinator tracks PIDs (if started by coordinator) for cleanup

---

## 5. Collective Metrics Display

### Data Model
```json
{
  "run_id": "run-20260310-160352",
  "started_at": "2026-03-10T16:03:38Z",
  "ended_at": "2026-03-10T16:04:45Z",
  "vms": [
    {
      "vm_id": "uac-local",
      "role": "UAC",
      "ext_range": "4001000-4001004",
      "calls_attempted": 5,
      "calls_completed": 4,
      "calls_failed": 1,
      "asr": 80.0,
      "avg_pdd_ms": 150.84,
      "avg_hold_ms": 10004.45
    },
    {
      "vm_id": "uas-local",
      "role": "UAS",
      "ext_range": "4001005-4001009",
      "calls_attempted": 4,
      "calls_completed": 4,
      "calls_failed": 0,
      "asr": 100.0
    }
  ],
  "aggregate": {
    "total_attempted": 5,
    "total_completed": 4,
    "total_failed": 1,
    "aggregate_asr": 80.0
  }
}
```

### Aggregation Rules
- **total_attempted**: UAC only (UAC drives attempts)
- **total_completed**: Sum across UAC (or UAS)
- **aggregate_asr**: total_completed / total_attempted × 100

---

## 6. Next.js GUI Design

### 6.1 Pages
| Page | Purpose |
|------|---------|
| **Dashboard** | Run list, recent runs, aggregate metrics |
| **Run Detail** | Per-VM metrics, call events, logs |
| **Config** | UAC/UAS config editor, VM pairing |
| **Launch** | Start traffic (UAS first, then UAC), monitor progress |

### 6.2 UI Components
- **Metrics cards**: attempted, completed, failed, ASR, PDD, hold time
- **VM pair cards**: UAC ↔ UAS with IP/port, status
- **Real-time**: WebSocket to coordinator or direct to VM metrics
- **Config form**: YAML-like fields with validation

### 6.3 Config Fields (Customizable)

#### UAC / UAS
| Field | Type | Default | Required |
|-------|------|---------|----------|
| vm_role | UAC \| UAS | — | ✅ |
| vm_id | string | — | ✅ |
| uac_ext_start | int | 1001 | ✅ |
| uac_ext_end | int | 1250 | ✅ |
| uas_ext_start | int | 2001 | ✅ |
| uas_ext_end | int | 2250 | ✅ |
| sbc_host | string | 127.0.0.1 | ✅ |
| sbc_port | int | 5060 | ✅ |
| sip_transport | TCP \| TLS \| UDP | TCP | ✅ |
| domain | string | — | ✅ |
| sip_password | string | — | ✅ |
| cps | int | 6 | — |
| hold_time_seconds | int | 180 | — |
| metrics_port | int | 8080 | — |
| peer_stop_url | string | — | UAC only |
| register_rate | int | 50 | — |
| register_timeout | int | 5 | — |
| register_retry | int | 3 | — |

#### VM Pairing
| Field | Type | Purpose |
|-------|------|---------|
| vm_ip | string | VM host/IP |
| ssh_user | string | For future SSH deploy |
| ssh_key_path | string | Optional |
| metrics_port | int | 8081, 8082, … |

### 6.4 Flow
1. User configures UAC + UAS (ext ranges, SBC, etc.)
2. User configures VM pairing (IPs, ports) for each
3. Click "Launch" → Coordinator starts UAS on VM(s), waits for ready
4. Coordinator starts UAC on VM(s)
5. Poll /metrics, aggregate, display
6. On UAC complete → POST stop to UAS → both shut down
7. Show final metrics, logs, optional download

---

## 7. VM Pairing (IPs & Login)

### Same-Machine (Current)
- UAC: localhost, metrics 8082
- UAS: localhost, metrics 8081
- peer_stop_url: http://localhost:8081/api/test/stop

### Multi-VM
- **UAC VM**: 192.168.1.10, metrics 8082
- **UAS VM**: 192.168.1.11, metrics 8081
- peer_stop_url: http://192.168.1.11:8081/api/test/stop

### Coordinator
- **Option A**: Coordinator runs on user's laptop; starts UAC/UAS via SSH on remote VMs
- **Option B**: User runs UAC/UAS manually; coordinator only polls metrics and aggregates

---

## 8. Rainy-Day Behavior

| Scenario | Behavior |
|----------|----------|
| UAC call fails (404, timeout) | UAC counts attempt; continues; signals UAS when max_calls reached |
| UAS never answers a call | Same; UAC completes and POSTs stop |
| Network partition | UAC may fail POST; UAS may need manual stop (Ctrl+C) |
| Coordinator down | UAC can still POST directly to UAS via peer_stop_url |
| SBC unreachable | Pre-phase fails; exit 1 |

---

## 9. Quick Reference

### Run 5 Calls (Same Machine)
```bash
# Terminal 1
python -m callflow_tool.traffic.main --config uas.yaml --log-level INFO

# Terminal 2 (after UAS ready)
python -m callflow_tool.traffic.main --config uac.yaml --log-level INFO --pool-wraps 1
```

### Config Files
- `uac.yaml`: UAC config, peer_stop_url: http://localhost:8081/api/test/stop
- `uas.yaml`: UAS config, metrics_port: 8081
