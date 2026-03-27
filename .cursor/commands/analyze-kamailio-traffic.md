# /analyze-kamailio-traffic — BHCC Traffic Run Failure Analysis

## Purpose
Deep-dive post-run analysis by correlating Kamailio K3s pod siptrace logs with optional
traffic-tool artifacts. The goal is to determine — with SIP-level evidence — what failed,
which entity caused it, and whether CM kept stations stuck.

---

## Fixed Topology (always keep in context)

```
UAC → SBC → kamailio-lb → kamailio-backend → CM (B2BUA)
                                              ↓
                    UAS ← SBC ← kamailio-lb ← kamailio-backend
```

| Entity | IP | Role |
|--------|-----|------|
| K3s cluster (Kamailio pods) | `10.133.63.109` | Relay / dispatcher |
| SBC | `10.133.63.117` | Session border, media relay |
| Avaya CM | `135.27.152.140` | B2BUA — generates new Call-ID for UAS leg |
| UAC / UAS | traffic tool VMs | Call originator / auto-answer |

> **CM is a B2BUA.** Leg A (UAC→CM) and Leg B (CM→UAS) have different Call-IDs.
> Do not blame Kamailio unless it directly generates an error. It is a relay.

---

## Optional User Inputs

Accept any combination of these files. Never block analysis if some are missing.

| File | If Present, Extract |
|------|---------------------|
| `uac.yaml` / `uas.yaml` | CPS, hold_time, extension range, transport, timeouts |
| `traffic_run-*.log` (UAC/UAS) | Per-call events, timeout events, BYE send/receive |
| `traffic_summary_run-*.log` (UAC/UAS) | Extension pairing details, wrap summary, RTP ports |
| Exported run JSON (`run-*.json`) | ASR, attempted/completed/failed, call spines, failure reasons |

If none are provided → proceed with Kamailio siptrace alone.

---

## Step 1 — Pod Discovery

```bash
kubectl get pods -A -o wide | rg "kamailio-lb|kamailio-backend"
```

Identify:
- namespace
- all active `kamailio-lb-*` pods
- all active `kamailio-backend-*` pods

Inspect at minimum: one `kamailio-lb` + one `kamailio-backend`.
If multiple replicas exist and failure patterns differ, inspect all.

---

## Step 2 — Siptrace File Discovery

On each pod:
```bash
kubectl exec -n <ns> <pod> -- sh -lc \
  'ls -lth /var/log/kamailio /var/run/kamilio 2>/dev/null | head -20 || true'
```

Look for:
- `siptrace-YYYY-MM-DD--HH-MM-SS.data` — primary siptrace (text-delimited, `||||` separator)
- `kamailio.log` — runtime errors and TCP connection events

> The siptrace `.data` file in **kamailio-lb** contains both Leg A (UAC→CM) and Leg B
> (CM→UAS) messages and is the most valuable file.

---

## Step 3 — Derive the Analysis Time Window

**If run JSON / logs provided:** use `started_at` / `ended_at` from run JSON, or first/last
timestamps from UAC log.

**If not provided:** inspect siptrace file timestamps, ask user for the window if ambiguous.

Always output:

```
Analysis Window
  User-facing:  <local time or "unknown">
  Pod (UTC):    <UTC window>
  Duration:     <Xs / Xm>
  Source:       <how derived>
```

---

## Step 4 — Run Context Table

Populate from yaml/logs/JSON. Mark `unknown` where not available.

| Field | Value |
|-------|-------|
| CPS | |
| Hold Time (s) | |
| UAC Extensions | |
| UAS Extensions | |
| Pool Count (LCM) | |
| Pool Wrap Time (s) | |
| Traffic Mode | |
| Approx Concurrent Calls (CPS × hold) | |
| Run Duration | |
| Total Attempted | |
| Total Completed | |
| Total Failed | |
| Final ASR | |

---

## Step 5 — Siptrace Signal Counts

From `kamailio-lb` siptrace, count or approximate occurrences within the run window.

Build this table:

| SIP Signal | Count | Primary Source IP | Entity |
|------------|-------|-------------------|--------|
| INVITE | | | |
| 100 Trying | | | |
| 180 Ringing | | | |
| PRACK | | | |
| 200 OK (INVITE) | | | |
| ACK | | | |
| CANCEL | | | |
| 487 Request Terminated | | | |
| BYE | | | |
| 200 OK (BYE) | | | |
| 486 Busy Here | | | |
| 408 Request Timeout | | | |
| 503 Service Unavailable | | | |
| **503 in response to BYE** | | | |
| **503 in response to CANCEL** | | | |

> Use `rg` or grep patterns scoped to the time window. Approximate counts (÷ by hop count
> if needed) are acceptable. Always state confidence level.

---

## Step 6 — Healthy Call Baseline

Find at least **one clearly successful call** in siptrace. Trace it end-to-end.

Output as a timeline table:

| Timestamp | Entity | Direction | SIP Event | Notes |
|-----------|--------|-----------|-----------|-------|
| | UAC | → SBC | INVITE | Call-ID, from/to ext |
| | CM | → UAS | INVITE | New Call-ID (B2BUA) |
| | UAS | → CM | 180 / 200 OK | Answer time |
| | UAC | ← | 200 OK | End-to-end connect time |
| | UAC | → | ACK | |
| | UAC | → | BYE | After hold |
| | SBC | → | 200 OK (BYE) | Clean teardown ✅ |

Highlight:
- total setup time (INVITE → 200 OK)
- total call duration
- BYE completion status

---

## Step 7 — Failed Call Autopsy (at least 2 examples)

For each failed call, trace through siptrace correlating Leg A and Leg B.

Output a timeline table per call:

| Timestamp | Entity | SIP Event | What It Means |
|-----------|--------|-----------|---------------|
| | | | |

After the timeline, answer explicitly:

1. Did UAS answer (200 OK sent)?
2. Did the ACK arrive at UAS in time?
3. Did the UAC receive 200 OK, or did it time out?
4. Was a CANCEL sent? If so, did it succeed or get 503?
5. Was a BYE sent for the UAS leg? Did it get 503?
6. Is this extension likely stuck on CM after this call?

---

## Step 8 — Failure Pattern Classification

Classify each dominant failure type into one of these patterns:

### Pattern A — CM slow signaling → UAC timeout
- UAS answers quickly
- CM takes >10–30s to relay 200 OK to UAC
- UAC times out and abandons INVITE (no CANCEL sent by tool)
- Orphaned UAS leg; CM cannot release station

### Pattern B — SBC 503 on BYE / CANCEL
- 503 sourced from `10.133.63.117` (SBC)
- SBC cannot route teardown to UAS endpoint (dialog gone, TCP expired)
- CM cannot release station → 486 Busy on next INVITE
- Kamailio only relays the 503

### Pattern C — CM 486 Busy Here (consequence)
- Always a downstream effect of Pattern A or B
- Distributed evenly across all UAS extensions = systemic
- Concentrated on a few extensions = specific TCP/dialog issue

### Pattern D — Tool timeout without CANCEL
- UAC/UAS log shows timeout event
- No CANCEL or BYE follows in siptrace
- Dialog silently abandoned; SBC/CM wait for their own timers
- Amplifies Pattern A and B

State which patterns are active, their approximate share of total failures, and their
cause-and-effect relationship.

---

## Step 9 — Entity Responsibility Matrix

Always produce this table:

| Entity | Status | Primary Evidence | Responsibility |
|--------|--------|-----------------|----------------|
| UAC (tool) | | | |
| UAS (tool) | | | |
| SBC | | | |
| Kamailio LB | | | |
| Kamailio Backend | | | |
| CM | | | |

Possible statuses: `Healthy` / `Root Cause` / `Contributing` / `Downstream Symptom` / `Relay Only`

---

## Step 10 — CM Station Release Assessment

Answer all of the following explicitly:

- Are CM stations getting stuck? (Yes / No / Likely)
- What SIP evidence proves or strongly suggests this?
- Did BYE fail to reach UAS for any calls? (503 count, source)
- Did CANCEL fail? (503 count, source)
- Did the tool send CANCEL at all, or silently abandon?
- Approximately how many extensions were stuck at peak failure?

---

## Step 11 — Failure Cascade Timeline

If the run degraded over time (healthy start → critical end), describe the cascade:

| Time into Run | ASR | Dominant Event | Interpretation |
|---------------|-----|----------------|----------------|
| 0–2 min | | | |
| 2–5 min | | | |
| 5–10 min | | | |
| 10+ min | | | |

---

## Final Output — Required Sections

### Executive Summary
- 5–7 bullets only
- State dominant root cause in plain language
- Explicitly state whether Kamailio is primary culprit or relay-only
- Explicitly state whether CM station sticking is confirmed / likely / unlikely
- Explicitly state whether SBC teardown failures (503 on BYE) are a factor

### What Went Well
- Stable registrations?
- Early ASR healthy?
- Kamailio transport path stable?
- Some BYEs completed cleanly?
- Cite evidence for each point

### Root Cause
One concise paragraph:
- primary cause
- contributing factors
- cascade mechanism if applicable

### Recommendations
3–6 items ordered by impact. For each:
- what to change
- which entity it affects
- expected outcome

Example areas to consider:
- Tool INVITE timeout (Timer B alignment)
- Tool sending CANCEL on timeout instead of silent abandon
- Tool UAS sending BYE when ACK timer expires
- UAS zombie-dialog handler for late BYE/CANCEL from CM
- SBC dialog timer configuration
- CM signaling processor review
- Extension pool size relative to CPS × hold_time
- pool_wrap_delay_seconds if relevant

---

## Behavioral Rules

- Do not stop analysis after finding the first error
- Do not assume Kamailio generated a failure without direct siptrace evidence
- Always distinguish: root cause vs downstream symptom vs cascade effect
- If siptrace shows 503 sourced from `10.133.63.117` → SBC generated it
- If 486 follows a failed BYE sequence → it is a consequence, not a root cause
- When exact correlation is not possible, say so and state confidence level
- Never present raw log dumps — always summarize and table-format the evidence

---

## Useful Siptrace Search Patterns

```bash
# Count specific SIP events in the LB siptrace within time window
kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg "486 Busy" /var/log/kamailio/siptrace-*.data | wc -l'

kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg "503 Service" /var/log/kamailio/siptrace-*.data | wc -l'

# Find 503 responses that follow BYE
kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg -A 30 "CSeq.*BYE" /var/log/kamailio/siptrace-*.data | rg "503"'

# Find 503 responses that follow CANCEL
kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg -A 30 "CSeq.*CANCEL" /var/log/kamailio/siptrace-*.data | rg "503"'

# Trace all messages for a specific extension
kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg "4001068" /var/log/kamailio/siptrace-*.data | head -60'

# Trace a specific Call-ID (Leg A or Leg B)
kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg "Call-ID: <call_id_here>" /var/log/kamailio/siptrace-*.data'

# Count 180 Ringing messages (inflated count = prolonged ringing issue)
kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg "180 Ringing" /var/log/kamailio/siptrace-*.data | wc -l'

# TCP connection events in Kamailio runtime log
kubectl exec -n <ns> <lb-pod> -- sh -lc \
  'rg "TCP|CLOSED|connection" /var/log/kamailio/kamailio.log | head -40'
```

---

## Scope
- Project: `cci/cci-studio`
- Command file: `.cursor/commands/analyze-kamailio-traffic.md`
- K3s cluster: `10.133.63.109`
- Use for BHCC, smoke, and general traffic-run failure analysis
