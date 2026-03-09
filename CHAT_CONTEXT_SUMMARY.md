# SBC Automation Tool - Context Summary

## Project Overview

SIP traffic engine (UAC/UAS) for automated call testing through: **SBC (10.133.63.117)** → **Kamailio LB/Backend (10.133.63.109, k3s cluster)** → **Avaya CM (135.27.152.140)**.

- **Workspace**: `c:\AXP_Infinity\cci\automation-tool\SBCAutomationTool`
- **Branch**: `automation-poc-phase1`
- **Python**: 3.14 (Windows)
- **k3s VM**: `10.133.63.109`, user `root`, SSH alias `ubuntu-axp-localab` (key at `~/.ssh/vm_key_cursor`, configured in `~/.ssh/config`)

---

## 1. Flask GUI Setup (Windows)

### Files Modified

| File | Fix |
|------|-----|
| `callflow_tool/callflow/js-sequence-diagrams-master/app.py` | `re.split("\[",...)` → `re.split(r"\[",...)` (SyntaxWarning); fallback to `127.0.0.1` if `config.CONTROLLERIP` binding fails |
| `callflow_tool/callflow/js-sequence-diagrams-master/ServiceExecutor.py` | Removed `import imp` (removed in Python 3.12+) |
| `callflow_tool/useragent/json/linoxiderepo/transport.py` | Removed `from asynchat import simple_producer`; moved `return ret_code` out of `finally` block |

### Run Command
```bash
cd callflow_tool/callflow/js-sequence-diagrams-master
python app.py config.py
# Serves on http://127.0.0.1:5000
```

---

## 2. Traffic Engine Fixes (UAC/UAS SIP Call Flow)

### Architecture
```
UAC (4001000) ──TCP──► SBC (10.133.63.117:5060)
                         ├──► Kamailio LB (10.133.63.109) ──► Kamailio Backend (pods) ──► CM (135.27.152.140)
UAS (4001001) ──TCP──► SBC (same)
                         └──► Kamailio ──► CM
```

### Config Files
- **UAC**: `uac.yaml` — role=UAC, ext 4001000, SBC 10.133.63.117:5060, TCP
- **UAS**: `uas.yaml` — role=UAS, ext 4001001, SBC 10.133.63.117:5060, TCP

### Run Commands
```bash
# UAS (start first - auto-answer mode, stays running)
python -m callflow_tool.traffic.main --config uas.yaml --log-level INFO

# UAC (1 call, exits after completion)
python -m callflow_tool.traffic.main --config uac.yaml --log-level INFO --max-calls 1

# Pre-phase only (REGISTER + SUBSCRIBE, no calls)
python -m callflow_tool.traffic.main --config uac.yaml --log-level INFO --pre-phase-only

# Kill all instances
taskkill //F //IM python.exe
```

### Key Files Modified

| File | Changes |
|------|---------|
| `callflow_tool/traffic/extension_agent.py` | TCP-based local IP detection; REGISTER 401 auth handling; SUBSCRIBE 407 Proxy-Auth handling; 202 Accepted for SUBSCRIBE; auto 200 OK for NOTIFY; INVITE From header fix; ACK for 4xx/5xx/6xx failures; `flush_register()` for startup unregistration |
| `callflow_tool/traffic/call_engine.py` | Expanded `_FINAL_FAIL` list (all 4xx/5xx/6xx codes); `max_calls` drain logic; `UasAutoAnswer` class for UAS mode |
| `callflow_tool/traffic/main.py` | Logging setup (console + file with RotatingFileHandler); CLI args: `--log-file`, `--log-dir`, `--max-calls`, `--pre-phase-only`, `--no-unregister`; `os._exit()` for clean port release |
| `callflow_tool/traffic/metrics.py` | Auto-port selection if metrics port in use; non-fatal server startup |
| `callflow_tool/traffic/sip_engine.py` | Raw SIP message DEBUG logging in send/receive |
| `callflow_tool/traffic/pre_phase.py` | `_flush_stale_registrations()` at start of every run |
| `callflow_tool/useragent/json/linoxiderepo/register.py` | Added `avaya-sc-enabled` to Contact header URI |
| `callflow_tool/useragent/json/linoxiderepo/authenticate.py` | Improved WWW-Authenticate/Proxy-Authenticate parsing; fixed nonce quoting; MD5 priority |
| `callflow_tool/useragent/json/linoxiderepo/registration.py` | Added `setRealm()`, `setURI()` setters |
| `callflow_tool/useragent/json/linoxiderepo/uasession.py` | Added `setRealm()`, `setURI()` setters; fixed From/To header get/set |

### SIP Call Flow (Current State)
```
PRE-PHASE:
  1. flush_register() — REGISTER(Expires:0) to clear stale bindings
  2. REGISTER → 401 → REGISTER(Auth) → 200 OK ✅
  3. SUBSCRIBE → 407 → SUBSCRIBE(Proxy-Auth) → 202 Accepted ✅
  4. NOTIFY → 200 OK (auto-response) ✅

TRAFFIC PHASE:
  5. INVITE sip:4001001@avaya.com → SBC → Kamailio LB → Backend → CM
  6. CM returns 100 Trying
  7. CM returns 404 Not Found ❌ (CM cannot route to 4001001)
  8. UAC sends ACK for 404 ✅
  9. Clean shutdown, unregister, os._exit() ✅
```

---

## 3. 404 Root Cause Analysis (DEFINITIVE — UPDATED 2026-03-09)

### True Root Cause: `Allow: UPDATE` in REGISTER → Kamailio `methods` bitmask

The **404 originates from Kamailio backend**, NOT from CM. The full call flow:

```
FIRST LEG (UAC → CM):
  UAC(4001000) → SBC → Kamailio LB → Backend → CM
  CM resolves: "term station 4001001" — CM KNOWS 4001001
  CM routes:   "dial 4001 route:AAR" — sends via trunk-group 6

SECOND LEG (CM → Kamailio → should reach UAS):
  CM sends NEW INVITE(4001001) → SBC → Kamailio LB → Backend
  Backend does lookup("location") for 4001001@avaya.com
  Backend finds contact but: "contact cannot handle the SIP method"
  Backend sends 404 Not Found ← THIS WAS THE BUG

CM receives 404 from Kamailio, sends its own 404 back to original caller
```

### Backend log proof (kamailio-backend-1, Call-ID 6ea65ba1bb841f1904d050569b2422):
```
registrar [lookup.c:360]: contact for [4001001@avaya.com] cannot handle the SIP method
registrar [lookup.c:369]: '4001001@avaya.com' has no valid contact in usrloc
INVITE_SEQ: Location lookup failed (shortcut) for 4001001, rc=-2
PUSH_CHECK: No contacts and no push (0) - sending 404
```

### Why the contact was filtered out

Our REGISTER message had `Allow: UPDATE` (only). Kamailio stored `methods=2048` (UPDATE bitmask only) in the `location` table. When the second-leg INVITE arrives and Kamailio does `lookup("location")`, it checks if the contact supports INVITE (method bit 1). Since `methods=2048` excludes INVITE, the contact is filtered → 404.

### Fix Applied

`callflow_tool/useragent/json/linoxiderepo/register.py` line 42:
```
# BEFORE (caused 404):
hdr_allow = 'UPDATE'

# AFTER (matches real Avaya phones):
hdr_allow = 'INVITE,ACK,OPTIONS,BYE,CANCEL,SUBSCRIBE,NOTIFY,REFER,INFO,PRACK,PUBLISH,UPDATE'
```

### CM Station Trace confirms correct CM behavior
```
Extension: 4001000, Type: 9641SIP, Name: J129, 4001000
Extension: 4001001, Type: 9641SIP, Name: 9620SIP, 4001001

Station trace shows:
  term station 4001001  → CM found it
  dial 4001 route:AAR   → CM routes via trunk-group 6
  seize trunk-group 6   → CM sends second-leg INVITE back to Kamailio
  CM receives 404 from Kamailio → denial event 1166: Unassigned number
```

### Kamailio & MySQL Verified OK

- **subscriber table**: `4001001@avaya.com` ✅
- **location table**: `4001001@avaya.com`, contact: `sip:4001001@10.133.63.117:5060;transport=tcp;avaya-sc-enabled` ✅ (but methods=2048 was the bug)
- **dispatcher table**: Both backends active (backend-0: `10.42.0.74`, backend-1: `10.42.0.75`) ✅
- **Kamailio LB** correctly dispatches INVITEs to backends ✅
- **Kamailio Backend** correctly forwards first-leg to CM ✅
- **Kamailio Backend** INVITE_SEQUENCING origdone/termdone phases work correctly ✅

---

## 4. Kubernetes / Infrastructure

### k3s Cluster (10.133.63.109)
```bash
# SSH access
ssh ubuntu-axp-localab   # alias in ~/.ssh/config, key-based auth

# CCI namespace pods
kamailio-lb-0        (2 containers: kamailio, dispatcher-sync)
kamailio-backend-0   (1 container)
kamailio-backend-1   (1 container)

# MySQL (infra namespace)
mysql-698cbc796-sjjb9  (port 3306)
# Port-forward: kubectl port-forward svc/mysql 3307:3306 -n infra --address 0.0.0.0
# Connect: mysql -h 127.0.0.1 -P 3307 -u cci -pAvaya123$ ccidb
```

### Key MySQL Tables (ccidb)
- `location` — usrloc registrations (username, domain, contact, expires)
- `subscriber` — user credentials (username, domain, password, ha1)
- `dispatcher` — backend destinations (setid=1, FQDN-based)

### Kamailio Config Locations (inside pods)
- LB: `/opt/avaya/kamailio/etc/kamailio.cfg` (1490 lines)
- Backend: `/opt/avaya/kamailio/etc/kamailio.cfg` (large, with INVITE sequencing, usrloc, subscriber checks)
- Logs: `/var/log/kamailio/kamailio.log` (backends only; LB logs to `kamailio.log.1`)
- SIP traces: `/var/log/kamailio/siptrace-*.data` (LB only, sipdump module)

### Kamailio LB Routing Summary
1. All SIP traffic enters via TCP:5060 (advertise 10.133.63.109:5060)
2. REQINIT: TCP-only enforcement, scanner blocking, OPTIONS health check response
3. Initial requests: `ds_select_dst("1","0")` dispatches to backends via dispatcher (hash on Call-ID)
4. In-dialog: `dlg_backend` / `dlg_backend_sub` htables for backend stickiness
5. Record-Route with `lb_cluster_fqdn` from database
6. If `ds_select_dst` fails: returns `404 "No destination"` (but this is NOT our issue — backends are active)

---

## 5. Working J179 Emulator Reference

When testing with the J179 SIP emulator (instead of our custom UAS), calls succeed:
- Emulator registers with `avaya-sc-enabled` in Contact ✅
- Emulator sends full `Allow: INVITE,ACK,BYE,...` → Kamailio stores correct methods bitmask ✅
- UAC INVITE to emulator-registered extension gets `180 Ringing` + `200 OK` from CM
- CM sends second-leg INVITE → Kamailio lookup succeeds → routes to emulator

---

## 6. Pending / Next Steps

1. **Re-run UAS/UAC test** with fixed Allow header to verify end-to-end call flow
2. Expected flow after fix: INVITE → CM → second-leg INVITE → Kamailio lookup succeeds → UAS → 180/200
3. UAS auto-answer logic is implemented but needs end-to-end validation
