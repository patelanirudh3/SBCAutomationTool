# Wrap, Hold & Pool Count — Architecture & Solution

> **Scope:** `callflow_tool/traffic/call_engine.py` (backend) + `gui/components/config/VMPairBook.tsx` / `AdvancedSettings.tsx` (GUI)

---

## 1. Core Concepts

| Term | Definition | Source |
|------|-----------|--------|
| **pool_count** | `LCM(uac_ext_count, uas_ext_count)` — number of calls before every extension has been used at least once and the pairing cycle resets. | `config.py → VMConfig.pool_wrap_count` |
| **wrap_time** | `pool_count / CPS` — wall-clock seconds to fire one full pool wrap at steady-state CPS. | Derived at runtime |
| **hold_time** | User-configured seconds a call stays active (INVITE→ACK→RTP→BYE). | `config.hold_time_seconds` |
| **SIP_BYE_BUFFER** | `2.0s` — internal constant covering BYE round-trip (~200ms) + SBC dialog cleanup (~500ms–1s). Never user-configurable, never shown in GUI. | `call_engine.py` hardcoded |
| **pool_wrap_delay_seconds** | Optional extra safety margin (default `0`). Only needed if SBC is slow to release dialogs (e.g. lingering 503s). | `config.pool_wrap_delay_seconds` |
| **natural spacing** | When `wrap_time >= hold_time + SIP_BYE_BUFFER`, ext #1 is already free before the pool restarts — no sleep needed. | Computed |

---

## 2. The Problem (Bug)

The original code tracked when the *very first call of the entire run* was launched (`_first_call_launch_time`), set once, never reset:

```python
elapsed = time.monotonic() - self._first_call_launch_time
sleep_for = max(0.0, delay_sec - elapsed)
```

After wrap 1, `elapsed` grows monotonically → `sleep_for` is always 0 for wraps 2, 3, 4... Extensions get reused before their previous calls complete → SBC rejects with 503 or stale dialog errors.

---

## 3. The Fix — `_current_wrap_start_time`

Replace `_first_call_launch_time` in the sleep calculation with `_current_wrap_start_time`, which resets at every wrap boundary.

**Lifecycle:**

```
Engine start
  └─ _calls_attempted == 0 → _current_wrap_start_time = time.monotonic()

Wrap boundary (calls_attempted % pool_count == 0)
  └─ compute sleep_for
  └─ sleep if needed
  └─ _current_wrap_start_time = time.monotonic()   ← RESET
```

`_first_call_launch_time` is **not removed** — it still serves elapsed-time metrics and logging elsewhere. It is simply no longer used in the sleep calculation.

---

## 4. Wrap Delay Formula

```
sleep_for = max(0, hold_time + SIP_BYE_BUFFER + extra_margin - elapsed)

where:
  elapsed      = time.monotonic() - _current_wrap_start_time
  extra_margin = pool_wrap_delay_seconds (default 0)
  SIP_BYE_BUFFER = 2.0
```

### Why "Always Compute" (No If/Else Shortcut)

The formula is **always evaluated** regardless of whether natural spacing holds. We do NOT have a branch that hardcodes `sleep_for = 0` for natural spacing. The `natural` boolean is used **only for logging**.

**Reason:** At the exact boundary `wrap_time == hold_time`, an if/else shortcut (`wrap_time >= hold_time → sleep_for = 0`) would skip the sleep, but ext #1 is still active for ~2s more (BYE exchange). The formula naturally handles this:

```
elapsed ≈ wrap_time = hold_time
sleep_for = max(0, hold_time + 2.0 - hold_time) = 2.0s
```

The formula converges to 0 when `wrap_time >> hold_time` because `elapsed >> hold_time + 2`, making `max(0, ...)` yield 0 without any conditional.

### Implementation (call_engine.py lines 216–265)

```python
SIP_BYE_BUFFER = 2.0

pool_count = cfg.pool_wrap_count
if pool_count > 0 and self._calls_attempted > 0 and self._calls_attempted % pool_count == 0:
    wrap_time    = pool_count / max(cfg.cps, 0.001)
    hold_time    = cfg.hold_time_seconds
    extra_margin = getattr(cfg, 'pool_wrap_delay_seconds', 0) or 0
    natural      = wrap_time >= hold_time + SIP_BYE_BUFFER

    elapsed   = time.monotonic() - self._current_wrap_start_time
    sleep_for = max(0.0, hold_time + SIP_BYE_BUFFER + extra_margin - elapsed)

    if sleep_for > 0:
        log.info(
            "Pool wrap delay: sleeping %.1fs before wrap %d "
            "(wrap_time=%.1fs, hold=%ds, natural=%s)",
            sleep_for, (self._calls_attempted // pool_count) + 1,
            wrap_time, hold_time, 'yes' if natural else 'no',
        )
        await asyncio.sleep(sleep_for)

    self._current_wrap_start_time = time.monotonic()
```

---

## 5. Formula — All Cases Explained

| Case | Numbers | elapsed at boundary | sleep_for | Outcome |
|------|---------|-------------------|-----------|---------|
| **Natural** (`wrap >> hold`) | pool=1080, cps=6, hold=180s → wrap=180s | ≈180s | max(0, 180+2-180) = 2.0s → but if wrap > hold+2: **0s** | No sleep. Ext #1 free since ~t=182s, boundary at t=180s+. |
| **Exact boundary** (`wrap == hold`) | pool=10, cps=2, hold=5s → wrap=5.0s | ≈5.0s | max(0, 5+2-5) = **2.0s** | 2s sleep. Protects ext #1 mid-BYE. |
| **Computed** (`wrap < hold`) | pool=10, cps=2, hold=10s → wrap=5.0s | ≈5.0s | max(0, 10+2-5) = **7.0s** | 7s sleep. Ext #1 busy for 5 more seconds + BYE. |
| **Ramp-up active** (wrap 1 only) | pool=10, cps=2, ramp=5s → ramp_steps=10 | ≈29.75s (calls fire slowly) | max(0, 10+2-29.75) = **0s** | No sleep. Ramp-up already exceeded hold+buffer. |
| **Large pool** | pool=250, cps=6, hold=180s → wrap=41.7s | ≈41.7s | max(0, 180+2-41.7) = **140.3s** | 140s sleep. Large gap until ext #1 frees. |

---

## 6. Ramp-Up Compatibility

The ramp-up mechanism operates via a `step` counter that increments per call, **independent of wrap boundaries**:

```python
if step < ramp_steps:
    ramp_factor = 1.0 + 9.0 * (1.0 - step / ramp_steps)
    interval = full_interval * ramp_factor
    step += 1
else:
    interval = full_interval
```

Where `ramp_steps = max(ramp_up_seconds * cps, 1)`.

**Key properties:**

- `step` does **not** reset at wrap boundaries — ramp-up spans across wraps if `pool_count < ramp_steps`
- During ramp-up, calls fire slower → `elapsed` at boundary is much larger than theoretical `wrap_time`
- The formula uses actual `elapsed`, not theoretical `wrap_time`, for the sleep calculation
- After ramp-up completes (`step >= ramp_steps`), all subsequent wraps fire at full CPS

**Example:** `pool_count=5, ramp_steps=20` → Wraps 1-4 are ramping (steps 0-4, 5-9, 10-14, 15-19). Each wrap boundary has large `elapsed` → `sleep_for = 0`. Wrap 5+ at full CPS.

**Example:** `pool_count=100, ramp_steps=10` → First 10 calls ramp, remaining 90 at full CPS. By wrap boundary, ramp is long done. Standard formula applies.

---

## 7. Relevance of `pool_wrap_delay_seconds`

| Scenario | Effect |
|----------|--------|
| **Natural spacing** (`wrap >= hold + 2s`) | **No effect.** `elapsed` already exceeds `hold + 2 + margin`, formula yields 0. |
| **Computed delay** (`wrap < hold`) | **Adds to sleep.** Formula: `hold + 2 + margin - elapsed`. |
| **Exact boundary** (`wrap ≈ hold`) | **Adds padding on top of SIP_BYE_BUFFER.** Usually unnecessary since 2s covers BYE. |

**Default = 0.** The auto-computed delay + SIP_BYE_BUFFER handle all normal cases. Users set it to 3–5s only if observing SBC-side 503 errors at wrap boundaries (slow dialog release).

**Semantic change from original:** Previously `pool_wrap_delay_seconds` was the *primary* gap mechanism (old formula: `hold + pool_wrap_delay - elapsed`). Now it is an *extra margin* on top of the auto-computed `hold + SIP_BYE_BUFFER`.

---

## 8. Boundary Condition Deep Dive: `wrap_time == hold_time`

### Timeline (pool=10, cps=2, hold=5s → wrap=5.0s)

```
t=0.0s   Ext #1 INVITE sent         ← _current_wrap_start_time
t≈0.3s   Ext #1 200 OK + ACK sent   ← hold timer starts
t≈5.3s   Hold expires → BYE sent
t≈5.5s   200 BYE received           ← ext #1 freed

t=5.0s   10th call fired (wrap boundary)
         elapsed = 5.0s
         sleep_for = max(0, 5+2-5) = 2.0s
         Engine sleeps 2.0s
t=7.0s   Wrap 2 starts → ext #1 INVITE sent (safe: freed at t≈5.5s)
```

Without SIP_BYE_BUFFER: `sleep_for = max(0, 5-5) = 0` → ext #1 reused at t=5.0s while BYE is still in flight → **collision**.

### Natural Spacing Threshold

```
natural = wrap_time >= hold_time + SIP_BYE_BUFFER
```

Uses `>=` (not `>`). When `wrap_time` exactly equals `hold_time + 2`, the formula gives `sleep_for = 0` because `elapsed ≈ wrap_time ≈ hold_time + 2`, and `max(0, hold_time + 2 - elapsed) = 0`. Safe: ext #1 freed at `hold_time + ~0.5s`, well before `hold_time + 2`.

---

## 9. GUI — What Is Shown vs Hidden vs Editable

| Parameter | Show? | Editable? | Where |
|-----------|-------|-----------|-------|
| `cps` | Yes | Yes | VMConfigPanel TRAFFIC section |
| `hold_time_seconds` | Yes | Yes | VMConfigPanel TRAFFIC section |
| `media_enabled` | Yes | Yes (toggle) | VMConfigPanel TRAFFIC section (UAC only) |
| `ramp_up_seconds` | Yes | Yes | AdvancedSettings REGISTRATION column |
| `metrics_interval` | Yes | Yes | AdvancedSettings RTP column |
| `pool_count` (derived) | Yes | No | Wrap Analysis panel + sidebar, read-only |
| `wrap_time` (derived) | Yes | No | Wrap Analysis panel + sidebar, read-only |
| Natural spacing result | Yes | No | Wrap Analysis panel, color-coded (emerald/amber) |
| Auto-computed delay | Yes | No | Wrap Analysis panel, read-only |
| `pool_wrap_delay_seconds` | Yes | Yes (min=0) | AdvancedSettings, hint: "Extra margin beyond auto-computed delay" |
| `SIP_BYE_BUFFER` (2.0s) | **No** | **No** | Internal constant. Never shown, never configurable. |

### GUI Wrap Analysis Panel

Placed in the sticky sidebar (`VMPairBook.tsx → WrapSidebar`). Recomputes live from draft form values (not saved state).

**Natural spacing (emerald):**
> pool_count = 1080 · wrap_time = 180.0s · hold = 180s
> "Extensions are free before the pool restarts — no wrap delay applied."

**Wrap delay required (amber):**
> pool_count = 5 · wrap_time = 2.5s · hold = 5s
> Auto-computed delay: 4.5s · Your extra margin: +0s · Effective per wrap: 4.5s
> "Minimum pool_count needed at current CPS and hold: 32 extensions (LCM)"

### Token Row (collapsed AdvancedSettings)

```
reg_rate: 10 · timeout: 8s · retry: 3 ·
rtp_burst: 2s/50pps · keepalive: 3s ·
pool_wrap_delay: 0s · metrics: 3s ·
wrap: natural ✅   (or)   wrap: auto 4.5s + 0s
```

---

## 10. Verification Scenarios

| # | Config | Expected |
|---|--------|----------|
| 1 | pool=10, cps=2, hold=5s | wrap=5.0s, hold+buffer=7.0s → amber, autoDelay=2.0s |
| 2 | pool=5, cps=2, hold=5s | wrap=2.5s → amber, autoDelay=4.5s |
| 3 | pool=250, cps=6, hold=180s | wrap=41.7s → amber, autoDelay=140.3s |
| 4 | pool=1080, cps=6, hold=180s | wrap=180.0s, hold+buffer=182.0s → amber, autoDelay=2.0s |
| 5 | pool=1100, cps=6, hold=180s | wrap=183.3s >= 182.0s → **emerald (natural)** |
| 6 | **Boundary:** pool=10, cps=2, hold=5s | wrap=5.0s == hold → amber, sleep=2.0s (SIP_BYE_BUFFER) |
| 7 | **Ramp-up wrap 1:** pool=10, cps=2, hold=10s, ramp=5s | elapsed≈29.75s >> 12s → sleep=0 |

**Backend verification:**
- `_first_call_launch_time` must **not** appear in the sleep calculation block
- `_current_wrap_start_time` must appear in `__init__`, first-call gate, and wrap boundary block
- Log line format: `"Pool wrap delay: sleeping 7.0s before wrap 2 (wrap_time=5.0s, hold=10s, natural=no)"`

---

## 11. Mental Model Summary

```
         pool_count calls
    ┌─────────────────────────┐
    │ ext#1    ext#2  ... ext#N│
    │ ──────   ──────     ─────│
    │ INVITE   INVITE     INV  │
    │ hold..   hold..     hold │
    │ BYE      BYE        BYE  │
    └─────────────┬───────────┘
                  │  ← wrap boundary
                  │
         Is ext #1 free?
         ┌─────────────────────┐
         │ wrap_time >= hold   │
         │ + SIP_BYE_BUFFER?   │
         └────┬──────────┬─────┘
              │ YES      │ NO
              ▼          ▼
         sleep = 0   sleep = hold + 2s
         (natural)   + margin - elapsed
                     (computed)
              │          │
              ▼          ▼
         RESET _current_wrap_start_time
         START next wrap
```

The formula always computes the correct answer in one expression. The YES/NO branch is only used for log labels. Both paths execute the same `max(0, ...)` formula — natural spacing simply means `elapsed` is large enough that the result is 0.
