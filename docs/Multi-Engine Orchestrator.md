# Multi-Engine Orchestrator

## Purpose

Design a fresh central orchestrator that can control multiple traffic-engine workers running on one or more hosts/VMs, while keeping the current GUI unchanged.

The orchestrator is not a SIP/RTP engine. It coordinates existing traffic-engine instances, pushes per-engine configuration, starts/stops phases, and aggregates live and final reporting.

## Requirements Summary

1. The orchestrator controls multiple traffic-engine instances.
2. Each engine can manage its own agents, and each agent can have two controllers: primary and secondary.
3. Each engine can use the same or different user-agent configuration.
4. Reporting must show both:
   - consolidated/global view across all engines,
   - per-engine view for TCP/TLS connection, registration, subscription, and traffic run.
5. Operators must be able to start/stop:
   - all engines together,
   - one selected engine independently.
6. Traffic distribution modes must support:
   - UAC and UAS on the same engine,
   - UAC on one engine and UAS on another engine,
   - mixed mode where UAC/UAS roles can be distributed across engines.
7. This should be written from scratch as a new controller/orchestrator, not by altering the current GUI.

## Recommended Architecture

Use a hub-and-worker model.

```text
                 +-----------------------------+
                 | Multi-Engine Orchestrator   |
                 | Fresh controller + GUI      |
                 +--------------+--------------+
                                |
              REST / WebSocket / polling APIs
                                |
      +-------------------------+--------------------------+
      |                         |                          |
+-----+------+           +------+-----+             +------+-----+
| Engine A   |           | Engine B   |             | Engine C   |
| VM/Host A  |           | VM/Host B  |             | VM/Host C  |
+-----+------+           +------+-----+             +------+-----+
      |                         |                          |
 SIP/TLS/RTP                SIP/TLS/RTP                 SIP/TLS/RTP
      |                         |                          |
 Primary/Secondary       Primary/Secondary          Primary/Secondary
 Controllers             Controllers                Controllers
```

Each engine remains responsible for:

- SIP transport connections,
- REGISTER/SUBSCRIBE,
- SIP retransmission,
- call traffic,
- UAS auto-answer,
- RTP generation/receive,
- per-engine HA/failover,
- local metrics and call reports.

The orchestrator is responsible for:

- worker inventory,
- config sharding,
- lifecycle orchestration,
- aggregate state,
- per-worker state,
- cross-engine traffic role assignment,
- report merging,
- operator controls.

## Worker Inventory Model

The orchestrator should store a worker inventory separate from engine config.

Example:

```yaml
workers:
  - worker_id: engine-a
    host: 10.10.1.11
    api_port: 8082
    label: Zone A Generator 1
    enabled: true
    ext_start: 6000000
    ext_end: 6002999
    role_policy: mixed
    primary_controller:
      host: 10.1.1.1
      port: 5061
    secondary_controller:
      host: 10.2.1.1
      port: 5061

  - worker_id: engine-b
    host: 10.10.1.12
    api_port: 8082
    label: Zone B Generator 1
    enabled: true
    ext_start: 6003000
    ext_end: 6005999
    role_policy: mixed
    primary_controller:
      host: 10.2.1.1
      port: 5061
    secondary_controller:
      host: 10.1.1.1
      port: 5061
```

The orchestrator should validate:

- no overlapping extension ranges,
- worker API reachability,
- version compatibility,
- unique worker IDs,
- valid primary/secondary controller mappings,
- enough agents per engine for the selected traffic mode.

## Per-Engine Configuration

Each engine can receive either:

- a shared base config with per-worker overrides, or
- a fully independent config.

Recommended model:

```text
global base config
        +
worker-specific overrides
        =
final worker config pushed to /api/config
```

Worker-specific overrides may include:

- `vm_id`,
- extension range,
- local host/IP mode,
- primary/secondary controllers,
- CPS share,
- max concurrent calls,
- RTP mode,
- codec,
- subscribe events,
- media security,
- TLS settings.

This avoids forcing every engine to have identical user-agent behavior.

## Lifecycle Orchestration

The orchestrator should expose commands at two levels.

### Combined Commands

- Start all enabled engines.
- Start TCP/TLS connection/prep for all engines.
- Start registration/subscription for all engines.
- Start traffic across all engines.
- Stop traffic across all engines.
- Cleanup all engines.
- Reset all engines.

### Per-Engine Commands

- Start one engine.
- Stop one engine.
- Re-run prephase on one engine.
- Start/stop traffic on one engine.
- Cleanup/reset one engine.
- Remove one failed engine from aggregate run.

The current worker API already appears close to this model, with per-VM calls such as:

- `PUT /api/config`
- `POST /api/prephase/start`
- `POST /api/regsub/start`
- `POST /api/traffic/start`
- `POST /api/shutdown/graceful`
- `POST /api/cleanup/start`
- `GET /metrics`
- `GET /api/calls`
- `GET /api/call-spines`

The new orchestrator can call those endpoints on each worker.

## Reporting Model

Reporting must be two-level: consolidated and per-engine.

### Consolidated View

Shows global totals:

- total workers,
- reachable workers,
- total configured agents,
- TCP/TLS connected agents,
- registered agents,
- subscribed agents,
- ready-for-traffic agents,
- active calls,
- attempted calls,
- answered calls,
- completed calls,
- failed calls,
- aggregate CPS,
- aggregate RTP TX/RX,
- aggregate media quality,
- aggregate retransmission/timeout counts.

### Per-Engine View

Shows the same lifecycle per worker:

- engine ID,
- host/IP,
- phase,
- API health,
- version,
- source IP/local IP mode,
- extension range,
- primary/secondary controller,
- TCP/TLS connection status,
- registration progress,
- subscription progress,
- traffic progress,
- failures by reason,
- RTP/media metrics,
- current controller state,
- HA/failover state,
- transaction/retransmission counters.

The UI should let operators switch between:

- global dashboard,
- worker dashboard,
- controller/zone dashboard,
- failed call table,
- final report.

## Traffic Distribution Modes

The orchestrator must support three traffic distribution modes.

### Mode 1: Same-Engine UAC/UAS

Each worker runs calls inside its own agent pool.

```text
Engine A: UAC and UAS both from Engine A
Engine B: UAC and UAS both from Engine B
```

Pros:

- minimal backend changes,
- workers are independent,
- simplest failure isolation,
- no cross-worker callee coordination.

Cons:

- less realistic if testing traffic between different source hosts/IPs.

This should be the first supported mode.

### Mode 2: Cross-Engine UAC/UAS

One engine launches calls and another engine provides callees.

```text
Engine A UAC -> Engine B UAS
Engine B UAC -> Engine A UAS
```

Pros:

- validates traffic between different source hosts/IPs,
- better for distributed media and signaling realism.

Cons:

- requires cross-worker role/pool coordination,
- requires the orchestrator to reserve callee ranges on remote engines,
- requires correlation of UAC and UAS call legs across engines.

This may need small backend additions unless the existing engine already supports externally directed UAC/UAS pairing.

### Mode 3: Mixed Mode

Workers can use local pairs and cross-engine pairs in the same run.

Example:

```text
70% same-engine calls
30% cross-engine calls
```

Pros:

- most flexible,
- models more deployment patterns.

Cons:

- highest orchestration complexity,
- requires clear pairing rules and report correlation.

This should be a later phase after same-engine and simple cross-engine modes are stable.

## Call Pairing Strategy

For same-engine mode, each worker can use its existing pool engine.

For cross-engine and mixed modes, the orchestrator needs a pairing plan.

Example:

```text
call_plan:
  - source_worker: engine-a
    target_worker: engine-b
    source_ext_range: 6000000-6000999
    target_ext_range: 6003000-6003999
    cps_share_pct: 50

  - source_worker: engine-b
    target_worker: engine-a
    source_ext_range: 6003000-6003999
    target_ext_range: 6000000-6000999
    cps_share_pct: 50
```

The key question is whether the worker engine can be told:

- which extensions can act as UAC,
- which extensions can act as UAS,
- which remote target range to call,
- whether remote target users are managed by another worker.

If not, cross-engine mode will require backend support.

## Does This Require Backend/Engine Changes?

For same-engine UAC/UAS mode, major engine changes should not be required.

Likely minimal additions:

- Ensure every metrics/report payload includes `worker_id`.
- Add a worker health/capabilities/version endpoint if not already present.
- Ensure config can be pushed fully by API.
- Ensure final call reports can be fetched reliably per worker.
- Ensure per-worker phase/status APIs are stable.

For cross-engine UAC/UAS mode, some backend changes may be required.

Possible additions:

- Role partitioning: configure a worker as UAC-only, UAS-only, or mixed.
- Remote callee targeting: tell Engine A to call extensions hosted by Engine B.
- Cross-worker call correlation fields:
  - `run_id`,
  - `worker_id`,
  - `source_worker_id`,
  - `target_worker_id`,
  - `call_id`,
  - caller/callee extension,
  - direction.
- Optional externally supplied call plan.
- Better UAS readiness reporting per callee range.

These changes should not touch low-level SIP retransmission, RTP packet generation, or existing single-engine call state unless cross-engine pairing cannot be expressed through current config.

## Backend Risk Assessment

### Low Risk

Low risk if the first implementation supports only:

- multiple independent engines,
- same-engine UAC/UAS,
- separate and combined start/stop,
- aggregate reporting.

This mostly uses existing APIs and avoids changing core SIP/RTP behavior.

### Medium Risk

Medium risk if the orchestrator adds:

- per-engine independent configs,
- per-engine HA controller mapping,
- coordinated all-engine phase transitions,
- partial worker failure handling,
- report merging.

Risk is mostly in orchestration state and reporting, not in the SIP engine.

### High Risk

High risk if the first version includes:

- cross-engine UAC/UAS pairing,
- mixed local/cross-engine pairing,
- distributed call scheduling,
- global CPS balancing across engines,
- automatic failover of traffic from one worker to another.

This can affect call pairing, metrics accuracy, and failure handling. It should be phased later.

## Recommended Phasing

### Phase 1: Fresh Orchestrator, Independent Workers

Scope:

- new orchestrator app,
- worker inventory,
- worker health/version checks,
- push per-worker config,
- start/stop all,
- start/stop individual worker,
- consolidated metrics,
- per-worker metrics,
- final report merge.

Traffic mode:

- same-engine UAC/UAS only.

Engine change:

- none or very small identity/report fields.

### Phase 2: Better Worker Identity and Reporting

Scope:

- add `worker_id` everywhere,
- add worker capability endpoint,
- improve report fetch/merge,
- show per-worker failures,
- add worker-level logs/errors.

Engine change:

- small API/metadata additions only.

### Phase 3: Cross-Engine UAC/UAS

Scope:

- UAC worker calls callee ranges on another worker,
- remote UAS readiness validation,
- cross-worker call correlation,
- per-call source/target worker reporting.

Engine change:

- likely needed for role partitioning and target-range control.

### Phase 4: Mixed Mode

Scope:

- same-engine and cross-engine traffic in one run,
- configurable distribution percentages,
- global CPS scheduler or per-worker CPS allocation,
- advanced reporting by traffic type.

Engine change:

- likely moderate unless current engine can express all pairing rules through config.

## Orchestrator State Model

The orchestrator should track:

```text
Run
  run_id
  status
  started_at
  ended_at
  global_config
  workers[]

WorkerRun
  worker_id
  host
  api_port
  phase
  config_hash
  ext_start
  ext_end
  primary_controller
  secondary_controller
  health
  last_error
  metrics_snapshot

CallReport
  run_id
  worker_id
  source_worker_id
  target_worker_id
  call_id
  caller
  callee
  direction
  result
```

## Failure Handling

The orchestrator should distinguish worker failure from call failure.

Worker-level failures:

- worker API unreachable,
- worker version incompatible,
- config push failed,
- phase command failed,
- metrics stream lost.

Call-level failures:

- SIP timeout,
- rejected call,
- media failure,
- RTP asymmetry,
- transaction retransmission timeout.

If one worker fails:

- combined run can continue if policy allows partial runs,
- failed worker is marked degraded/offline,
- global report shows partial-run status,
- operator can retry that worker independently.

## What Not To Do

The orchestrator should not:

- proxy SIP traffic,
- proxy RTP traffic,
- own SIP transaction retransmission,
- directly manipulate per-agent SIP state,
- make per-call retransmission decisions,
- replace the engine’s internal HA/failover logic,
- require the current GUI to be rewritten in-place.

## Recommendation

Build a fresh multi-engine orchestrator that treats each existing traffic-engine instance as a worker.

Start with independent same-engine UAC/UAS workers and aggregate reporting. This gives scale and safety with minimal backend risk.

Add cross-engine UAC/UAS and mixed mode later, because those modes likely require backend support for role partitioning, remote target selection, and cross-worker call correlation.

This approach avoids major SIP/RTP engine changes in the first phase and keeps the current GUI untouched while enabling a cleaner future architecture.
