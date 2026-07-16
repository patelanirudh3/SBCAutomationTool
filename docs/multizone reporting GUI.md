# Multizone Reporting GUI

## Purpose

Improve GUI reporting for multi-zone / multi-controller traffic runs.

The current GUI presents most registration, subscription, and traffic metrics as one flat pool. That is misleading in multi-zone mode because each agent group has its own primary controller, secondary controller, registration state, subscription state, traffic volume, and failure profile.

The GUI should show:

- a consolidated global view,
- a per-zone view,
- a per-controller view,
- and per-agent-group failure details.

## Goals

- Make registration and subscription status meaningful in multi-zone mode.
- Show primary and secondary registration separately.
- Show active subscription state per primary controller.
- Show traffic attempts, failures, ASR, and media quality per zone/controller.
- Make traffic imbalance visible.
- Make final reports explain which controller/zone produced failures.
- Avoid changing traffic scheduling as part of reporting work.

## Current Problems

### Flat Registration Counts

The top-level registration display can show confusing values such as:

```text
registered_count: 4
registered_total: 8
```

In multi-zone, that can mean:

```text
primary registered:   4
secondary registered: 4
total bindings:       8
```

The GUI should not force the operator to infer that from flat counters.

### Misleading SIP Remote IP

Some call records show `sip_remote_ip` from the base config instead of the actual agent group's controller. In multi-zone mode, this can make all calls appear to target one controller even when calls are associated with different `agent_group_id` values.

### No Per-Controller Traffic View

If Zone A succeeds and Zone B fails, the global ASR/CSR alone does not explain why. Operators need to see:

- attempts by zone,
- failures by zone,
- top failure reason per controller,
- skew in traffic distribution.

### Fast-Failing Zone Can Dominate Attempts

If calls through one controller fail quickly, those agents return to the idle pool faster and can be reused more frequently. This can produce a large attempt imbalance even if initial agent distribution is 50/50.

Reporting must make this visible.

## Registration / Subscription Reporting

### Global HA Summary

Add a multi-zone summary strip above the registration progress cards.

Example:

```text
Total Agents: 100
Primary Registered: 100 / 100
Secondary Registered: 100 / 100
Subscribed on Active Controller: 100 / 100
Protected: 100
Degraded: 0
Not Usable: 0
```

Recommended fields:

- total configured agents,
- primary registered count,
- secondary registered count,
- active subscribed count,
- protected count,
- degraded primary-only count,
- not usable count,
- active controller status summary.

### Per-Zone / Per-Controller Cards

Show one card per `ha_agent_groups[]` entry.

Example:

```text
Zone A / Controller 172.16.1.107
Primary for: 50 agents
Secondary: 172.16.1.108

TCP/TLS:        100 / 100 sockets
Primary Reg:    50 / 50
Secondary Reg:  50 / 50
Subscribe:      50 / 50
Ready:          50
Reg-only:        0
Failures:        0
```

```text
Zone B / Controller 172.16.1.108
Primary for: 50 agents
Secondary: 172.16.1.107

TCP/TLS:        100 / 100 sockets
Primary Reg:    50 / 50
Secondary Reg:  50 / 50
Subscribe:      50 / 50
Ready:          50
Reg-only:        0
Failures:        0
```

Each card should include:

- group ID,
- zone ID,
- primary controller host/port,
- secondary controller host/port,
- active controller label,
- primary registered count,
- secondary registered count,
- active subscribed count,
- agent count,
- transport health,
- recovery state,
- last move/failover error.

### Registration Failure Table

Replace or supplement the flat failure list with grouped details.

Example:

```text
Controller       Zone    Phase       Count   Top Reason
172.16.1.108     B       REGISTER    50      404 No listen ports found
172.16.1.107     A       SUBSCRIBE    2      Timeout waiting response
```

Clicking a row should expand:

- extensions,
- error text,
- group ID,
- controller host/port,
- operation type.

## Traffic Run Reporting

### Global Traffic Summary

Keep the existing aggregate cards:

```text
Attempted | Answered | Completed | Failed | ASR | CPS | Active Calls
```

Add a multi-zone traffic balance strip:

```text
Traffic Distribution: Critical Skew
Zone A: 229 attempts
Zone B: 2729 attempts
```

### Per-Zone Traffic Cards

Show one traffic card per agent group.

Example:

```text
Zone A / Primary 172.16.1.107
Attempts: 229
Answered: 229
Completed: 229
Failed: 0
ASR: 100%
Active Calls: 25
Avg setup: 110 ms
Media OK: 229
Top failure: —
```

```text
Zone B / Primary 172.16.1.108
Attempts: 2729
Answered: 0
Completed: 0
Failed: 2729
ASR: 0%
Active Calls: 0
Avg setup: —
Media OK: 0
Top failure: 480 Temporarily Unavailable
```

Each card should include:

- attempts,
- answered,
- acknowledged,
- completed,
- failed,
- ASR,
- CSR,
- active calls,
- average setup time,
- BYE completion time,
- media verified count,
- RTP transmit/receive,
- top SIP failure code,
- top failure reason.

### Controller Distribution Chart

Add a simple bar chart for attempts by controller:

```text
Attempts by Primary Controller
172.16.1.107 | ███ 229
172.16.1.108 | █████████████████████████ 2729
```

Add another for failures:

```text
Failures by Primary Controller
172.16.1.107 | 0
172.16.1.108 | 2729
```

### Live Balance Indicator

Add a status pill:

```text
Traffic Distribution: Balanced / Skewed / Critical
```

Suggested thresholds:

- Balanced: each controller within +/-20% of expected share.
- Skewed: 20-50% off expected share.
- Critical: more than 50% off expected share.

Example message:

```text
Critical skew: 92% of attempts went through Zone B because Zone B calls failed quickly and returned to idle faster.
```

This is important because skew may be a consequence of failure duration, not initial distribution.

## Final Report

Add a new section:

```text
Multi-Zone Controller Report
```

Example:

```text
Controller    Zone   Primary Agents   Attempts   Completed   Failed   ASR
172.16.1.107  A      50               229        229         0        100%
172.16.1.108  B      50               2729       0           2729     0%
```

Add failure reason grouping:

```text
Failure Reason by Controller
172.16.1.108 -> 480 Temporarily Unavailable: 2729
```

Add media grouping:

```text
Media Quality by Controller
Controller    RTP TX   RTP RX   Media OK   Critical
172.16.1.107  ...      ...      ...        ...
172.16.1.108  ...      ...      ...        ...
```

## Backend Data Needed

Some data already exists:

- `ha_agent_groups`
- `agent_group_id`
- `active_controller`
- `CallResult.AgentGroupID`
- `CallResult.ActiveController`

But multi-zone reporting needs stronger controller metadata in every call result.

Add fields to call results and call events:

```json
{
  "agent_group_id": "zone-a-ctrl-1",
  "zone_id": "zone-a",
  "controller_host": "172.16.1.107",
  "controller_port": 5061,
  "controller_role": "primary",
  "active_controller": "primary"
}
```

The existing `sip_remote_ip` field should be corrected in multi-zone mode. It should reflect the actual controller used by the agent that produced the record, not the base `cfg.SBCHost`.

## Deriving Controller Metadata

During call result recording:

1. Find the caller extension in `AgentGroup.PrimaryAgents` or `AgentGroup.SecondaryAgents`.
2. Set:
   - `AgentGroupID`
   - `ZoneID`
   - `ActiveController`
   - `ControllerHost`
   - `ControllerPort`
   - `ControllerRole`
3. For UAS-side records, do the same using the callee extension if caller mapping is empty.

This should happen before the result is passed to metrics/reporting.

## Recommended UI Sections

### During Reg/Sub

Sections:

- Global HA summary strip.
- Per-zone registration cards.
- Per-controller failure table.
- Existing raw failure lists as expandable details.

### During Traffic

Sections:

- Global traffic summary.
- Per-zone traffic cards.
- Attempts by controller chart.
- Failures by controller chart.
- Distribution skew warning.
- Failed calls table with `zone_id`, `controller_host`, and `agent_group_id` columns.

### Final Report

Sections:

- Existing aggregate report.
- Multi-zone controller report.
- Controller failure reason breakdown.
- Controller media quality breakdown.
- Exportable per-controller CSV/JSON data.

## Implementation Phases

### Phase 1: Correct Backend Metadata

- Add `ZoneID`, `ControllerHost`, `ControllerPort`, and `ControllerRole` to call results.
- Correct `sip_remote_ip` for multi-zone records.
- Ensure call events include controller metadata where possible.

### Phase 2: Registration UI

- Add global HA summary.
- Add per-zone registration cards from `ha_agent_groups`.
- Group register/subscribe failures by controller.

### Phase 3: Traffic UI

- Add per-zone traffic cards.
- Add attempts/failures by controller charts.
- Add skew indicator.

### Phase 4: Final Report

- Add multi-zone report section.
- Add per-controller failure and media quality tables.
- Include controller metadata in exports.

## Risk

Risk level: low to medium.

Low risk if changes are limited to reporting and metadata.

Medium risk if current metrics aggregation logic is refactored heavily. Avoid changing call scheduling or registration logic as part of this work.

## Recommendation

Start by fixing backend metadata and the misleading `sip_remote_ip` field. Then add per-zone cards using existing `ha_agent_groups`. After that, build per-controller traffic summary from call results.

This will make multi-zone behavior understandable without changing how traffic is generated.
