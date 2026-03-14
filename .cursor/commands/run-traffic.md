# /run-traffic — SBCAutomationTool Traffic Runner

## Context Files
- Always reference @uas.yaml and @uac.yaml before executing
- Flag (don't auto-fix) anything suspicious in either file:
  (wrong ports, missing keys, mismatched IPs, bad codec config)

## Log Files
- Location: `SBCAutomationTool/logs/`
- UAS logs:
  - `traffic_uas-local_<YYYYMMDD_HHMMSS>.log`
  - `traffic_summary_uas-local_<YYYYMMDD_HHMMSS>.log`
- UAC logs:
  - `traffic_uac-local_<YYYYMMDD_HHMMSS>.log`
  - `traffic_summary_uac-local_<YYYYMMDD_HHMMSS>.log`
- Always resolve to the latest file by timestamp when reading logs

---

## Pre-flight: Kill Stale Python Processes

Detect OS and kill any stale processes matching `callflow_tool`:

**Windows (PowerShell):**
```powershell
Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -like '*callflow_tool*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**Linux/Ubuntu:**
```bash
pkill -f "callflow_tool" 2>/dev/null || true
```

---

## Execution

### Step 1 — Start UAS (background)
```bash
python -m callflow_tool.traffic.main --config uas.yaml --log-level INFO
```
- Capture PID
- Sleep 10–12 seconds (allow UAS to initialize)
- Then tail the latest `traffic_uas-local_*.log` and watch for ALL of
  these lines (count N is dynamic — match the pattern, not the number):

  **Common pre-phase lines (UAS):**
```
  REGISTER complete: N/N OK, 0 failed
  SUBSCRIBE complete: N/N OK, 0 failed
  ALL EXTENSIONS READY — N registered, N subscribed
```

  **UAS-specific only — NOT expected in UAC:**
```
  UAS auto-answer started for N extensions
  UAS auto-answer mode active on N extensions
```

- ✅ All 5 lines found → proceed to Step 2
- ❌ Timeout after 60s without all 5 → abort, report which lines were missing

### Step 2 — Start UAC (background)
```bash
python -m callflow_tool.traffic.main --config uac.yaml --log-level INFO
```
- Capture PID
- Sleep 10 seconds (initial buffer only — NOT a fixed wait)
- Then immediately start tailing `traffic_uac-local_*.log`
- Watch for ALL 3 lines (do not sleep further, poll the log actively):
```
  REGISTER complete: N/N OK, 0 failed
  SUBSCRIBE complete: N/N OK, 0 failed
  ALL EXTENSIONS READY — N registered, N subscribed
```
  > ⚠️ Do NOT expect or flag absence of `UAS auto-answer` lines in UAC logs.
  > These are UAS-only signals.
  
- ✅ All 3 lines found → move to Step 3 immediately, do not wait further
- ❌ If not found within 60s after process start → abort and report

> ⚠️ Do NOT use a fixed sleep like `sleep 20` or `sleep 60` for UAC.
> The 10s is only an initial buffer before log tailing begins.
> Always transition to log-line detection — never wait blindly.

### Step 3 — Monitor Until Both Processes Exit
- Poll both PIDs every 5 seconds
- On completion verify exit codes:
  - UAS → exit 0 ✅ | non-zero ❌
  - UAC → exit 0 ✅ | non-zero ❌

> ℹ️ **Expected noise — do NOT flag as failure:**
> Both logs will contain the following traceback at the very end:
> ```
> ERROR:    Traceback (most recent call last):
>   ...
>   asyncio.exceptions.CancelledError
> ```
> This is the uvicorn metrics HTTP server being cancelled when the process
> exits. It is cosmetic and does not affect the exit code or traffic results.
> Only flag this if the exit code is also non-zero.

---

## Post-Run Summary (always produce this)
```
═══════════════════════════════════════
         TRAFFIC RUN SUMMARY
═══════════════════════════════════════
UAS Exit Status : ✅ 0 / ❌ <code>
UAC Exit Status : ✅ 0 / ❌ <code>
Run Duration    : Xs

Key Call Stats (parsed from logs):
  • Extensions registered   : N
  • Extensions subscribed   : N
  • Calls attempted         : N
  • Calls completed         : N
  • Calls failed            : N

Log Files Used:
  • UAS : traffic_uas-local_<timestamp>.log
          traffic_summary_uas-local_<timestamp>.log
  • UAC : traffic_uac-local_<timestamp>.log
          traffic_summary_uac-local_<timestamp>.log
═══════════════════════════════════════
```

---

## On Failure — Log Correlation & Analysis

If either process exits non-zero OR logs contain errors/warnings:

1. Read last 100 lines of both latest UAS and UAC logs
   (both `traffic_*` and `traffic_summary_*` variants)
2. Correlate events by timestamp across all 4 log files
3. Report strictly in this format — no raw log dumps:
```
ROOT CAUSE (most likely):
  → <one line summary>

SUPPORTING EVIDENCE:
  [HH:MM:SS] UAS: <relevant log line>
  [HH:MM:SS] UAC: <relevant log line>

SECONDARY ISSUES (if any):
  → <brief bullet points>

RECOMMENDATION:
  → <one actionable fix>
```

Failure triggers to watch for:
- Network/connectivity errors
- Non-zero exit codes
- Call failure counts > 0
- Registration or subscription failures
- Timeout or socket errors
- UAS auto-answer lines missing from UAS logs specifically

**Explicitly NOT a failure trigger:**
- `asyncio.exceptions.CancelledError` at end of both logs — this is the
  uvicorn metrics server shutting down on process exit. Ignore unless
  accompanied by a non-zero exit code.

---

## Scope & Availability
- Project : `SBCAutomationTool`
- Branches: `automation-poc-phase1`, `main`
- Save to `.cursor/commands/run-traffic.md` at project root
- Available in both local and remote SSH Cursor sessions for this repo