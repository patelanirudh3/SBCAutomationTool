# TODO: Extension Pool Redesign — Unified Free/Unavailable Pools

## Why

The current design separates extensions into UAC (callers) and UAS (callees) with
independent configuration, registration, and traffic control. This creates several
problems:

1. **Double configuration burden** — Users must define two extension ranges, two
   YAML configs, and two separate processes. The launch page segregates UAC/UAS
   settings even though both sides use the same SBC, domain, and traffic parameters.

2. **No per-extension busy tracking** — The engine cycles through extensions by
   index (`nextPair`). There is no check whether an extension is already on an
   active call. Under overload or when pool wrap fails, an extension can be reused
   while its previous call is still being torn down, causing 486 Busy or SIP
   state corruption on the SBC/CM.

3. **Wrap delay is a proxy, not a guarantee** — The current pool wrap delay
   formula (`hold_time + SIP_BYE_BUFFER - elapsed`) estimates when extensions
   become free. It works well under steady state but cannot handle:
   - Extensions stuck in timeout (20s SIP timeout vs 5s hold time)
   - Calls that fail mid-flow (PRACK timeout, BYE timeout) where the extension
     remains "logically busy" longer than hold time
   - Variable CPS or ramp-up phases where the wrap timing assumption breaks

4. **Asymmetric failure visibility** — When a UAC call fails, the callee extension
   on the UAS side may still be processing the failed INVITE. Neither side has
   visibility into the other's extension state.

## What

Replace the separate UAC/UAS extension pools with a **unified extension pool**
using two logical states:

```
┌──────────┐    call starts    ┌──────────────┐
│   FREE   │ ───────────────── │  UNAVAILABLE  │
│  (idle)  │ ◄──────────────── │  (in-call)    │
└──────────┘    call ends      └──────────────┘
```

### User-Facing Changes

- User provides a single extension range (e.g., `ext_start: 4001000`, `ext_end: 4001499`)
  which gives 500 extensions = 250 possible concurrent call pairs.
- No more `uac_ext_start/end` vs `uas_ext_start/end` split.
- The tool pairs extensions dynamically from the free pool: pick any two free
  extensions, one becomes caller, the other becomes callee.

### Data Structure: Per-Extension Busy Flag

```go
type ExtensionState int32

const (
    ExtFree        ExtensionState = 0
    ExtUnavailable ExtensionState = 1
)

type ExtensionPool struct {
    mu         sync.Mutex
    extensions []int                          // all extension numbers
    state      map[int]*atomic.Int32          // ext -> ExtFree/ExtUnavailable
    freeList   []int                          // snapshot refreshed on demand
    cooldown   map[int]time.Time              // ext -> earliest reuse time
}

// AcquirePair picks two free extensions (caller, callee) and marks them
// unavailable. Returns false if fewer than 2 are free.
func (p *ExtensionPool) AcquirePair() (caller, callee int, ok bool)

// Release returns one extension to the free pool with an optional cooldown.
func (p *ExtensionPool) Release(ext int, cooldownDuration time.Duration)

// ForceRelease reclaims an extension stuck in unavailable past the safety timer.
func (p *ExtensionPool) ForceRelease(ext int)
```

### Conditions That Return Extensions to Free Pool

| Condition | Action |
|-----------|--------|
| **Normal completion:** caller receives 200-OK-BYE AND callee sends 200-OK-BYE | Release both with `SIP_BYE_BUFFER` cooldown |
| **SIP timeout:** INVITE, PRACK, ACK, BYE timeout on either side | Release both immediately (SBC/CM already timed out) |
| **SIP error responses:** 4xx, 5xx, 6xx received | Release both immediately |
| **CANCEL sent:** UAC sends CANCEL due to timeout | Release both after 487 received or 5s safety timer |
| **SBC-initiated BYE:** Unexpected BYE from SBC (session timer) | Release both immediately |
| **Transport error:** TCP disconnect, connection refused | Release both immediately |
| **Zombie safety timer:** Extension in unavailable for > `hold_time + max_sip_timeout + 10s` | Force-release (prevents permanent starvation) |

### Pool Behaviour at Capacity

When fewer than 2 extensions are free, the engine waits in a tight loop
(50ms sleep) checking for free extensions before launching new calls. This
naturally applies back-pressure to the CPS rate without dropping calls.

## How

### Phase 1: Per-Extension Busy Flag (stepping stone)

Add a per-extension busy flag to the existing UAC/UAS model as an intermediate
step. This can be done with a `sync.Map[string]struct{}` keyed by extension
number:

- **Set busy** when `executeCall` gets a successful INVITE (after `SendInvite`
  returns a dialog).
- **Clear busy** in the `defer` block of `executeCall` (same place as
  `activeCount.Add(-1)`).
- **Check busy** in `nextPair()` — skip busy extensions and advance the index.
- On the UAS side, the extension is implicitly busy while `handleCall` is
  running. Add a similar flag to `UasAutoAnswer`.

This flag directly maps to the `ExtUnavailable` state in the full redesign and
validates the concept before the larger refactor.

### Phase 2: Unified Pool (full redesign)

1. **Config changes:**
   - Replace `uac_ext_start/end` + `uas_ext_start/end` with `ext_start/end`.
   - Keep backward compat: if old fields are set, merge into single range.
   - `PoolWrapCount()` becomes `len(extensions) / 2` (pairs from single pool).

2. **Pre-phase changes:**
   - Register ALL extensions from the single pool (not split UAC/UAS).
   - Subscribe ALL extensions (same concurrency controls: batch size, delay).
   - Each extension gets one SIP agent with one TCP/TLS connection.

3. **Engine changes:**
   - `CallEngine` uses `ExtensionPool.AcquirePair()` instead of `nextPair()`.
   - Both caller and callee agents are local — no separate UAS process needed
     for loopback traffic.
   - For distributed mode (caller on VM-A, callee on VM-B), the coordinator
     assigns extension sub-ranges to each VM and the pool operates within the
     assigned range.

4. **Launch page changes:**
   - Single "Extension Range" input instead of separate UAC/UAS sections.
   - Remove `uac_ext_start/end` and `uas_ext_start/end` from Advanced Settings.
   - Show pool utilisation in real-time: "Free: 180 / 200 | Unavailable: 20".

5. **Live metrics changes:**
   - Add pool metrics: `pool_free_count`, `pool_unavailable_count`,
     `pool_force_released_count`, `pool_wait_count` (times engine waited for
     free extensions).
   - Dashboard shows pool utilisation gauge alongside CPS and concurrent calls.

6. **Post-run summary changes:**
   - Report pool statistics: peak unavailable, total force-releases, average
     time-in-unavailable per extension.
   - Flag extensions that were force-released as potential state leaks.

## Migration Path

1. Ship the per-extension busy flag (Phase 1) with the current UAC/UAS model.
2. Validate with traffic runs at 4 CPS / 5s hold / 100 extensions.
3. Implement the unified pool (Phase 2) behind a feature flag.
4. Update the launch page and YAML schema.
5. Deprecate the old `uac_ext_start/end` + `uas_ext_start/end` fields.

## Open Questions

- Should the cooldown duration be configurable or always derived from
  `SIP_BYE_BUFFER`?
- For distributed mode, how does the coordinator partition extensions across VMs?
- Should the pool support priority levels (e.g., recently-failed extensions get
  deprioritised)?
