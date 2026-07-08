# Traffic CPU Reporting Enhancements

## Goal

Improve CPU reporting so operators can understand whether CPU load is caused by Nexus Traffic Engine, kernel/network processing, GUI/runtime processes, or unrelated VM activity.

The same CPU/health status should be visible across all five GUI states:

```text
Config -> Reg/Sub -> Traffic -> Report -> Cleanup
```

As soon as the GUI can reach the traffic-engine VM API, it should show CPU and VM health data, even before registration starts.

## Current Problem

Current GUI shows host CPU and process CPU, but the values can be misleading:

```text
Host CPU: 80-90%+
Process CPU: 0%
```

This can happen because:

- host CPU is whole-VM CPU usage
- process CPU is currently calculated as traffic-engine jiffy delta divided by whole-system CPU jiffy delta
- process CPU can round to zero on multi-core VMs
- network/kernel/softirq CPU caused by traffic may not be counted as process CPU
- unrelated processes can consume most of the VM CPU
- GUI/Node/Bun/tcpdump/other tools may contribute CPU separately

Operators need clearer attribution.

## Current Metric Behavior

Current process CPU is effectively:

```text
traffic-engine process jiffy delta / whole-system jiffy delta * 100
```

This means:

- it is `% of total VM CPU capacity`
- on many-core VMs the number can look very small
- it can show `0.00%` if the process delta is below jiffy resolution
- it does not explain host CPU increases from kernel network processing

## Required Reporting Improvements

### 1. Rename Current Process CPU Metric

Current metric should be relabeled in GUI as:

```text
Process CPU (% of VM)
```

This avoids implying that it is the same value shown by tools like `top`.

### 2. Add Core-Equivalent Process CPU

Add a second process CPU metric:

```text
Process CPU (% of one core)
```

Semantics:

```text
100% = one fully used CPU core
250% = two and a half cores
```

This is more intuitive for operators and closer to `top`-style process CPU.

Suggested backend fields:

```go
ProcessCPUPercentVM   float64 `json:"process_cpu_percent_vm"`
ProcessCPUPercentCore float64 `json:"process_cpu_percent_core"`
```

Backward compatibility:

- keep existing `process_cpu_percent`
- treat it as alias of `process_cpu_percent_vm` for older GUI code

### 3. Add Host CPU Breakdown

Parse `/proc/stat` and expose CPU categories:

```json
{
  "cpu_user_percent": 12.3,
  "cpu_system_percent": 8.4,
  "cpu_iowait_percent": 1.1,
  "cpu_irq_percent": 0.2,
  "cpu_softirq_percent": 5.7,
  "cpu_steal_percent": 0.0,
  "cpu_idle_percent": 72.3
}
```

Why this matters:

- high `softirq` during RTP/SIP load points to kernel network processing
- high `system` may indicate network/socket/syscall overhead
- high `steal` may indicate VM host contention
- high `iowait` indicates disk or storage bottlenecks

### 4. Add Top Process Snapshot

Add top CPU process list so operators can see who is consuming host CPU.

Example JSON:

```json
"top_processes": [
  { "pid": 1234, "name": "traffic-engine", "cpu_percent_core": 12.5, "rss_bytes": 350000000 },
  { "pid": 2233, "name": "tcpdump", "cpu_percent_core": 25.1, "rss_bytes": 20000000 },
  { "pid": 9876, "name": "bun", "cpu_percent_core": 8.9, "rss_bytes": 150000000 }
]
```

This helps distinguish:

- engine CPU
- GUI runtime CPU
- tcpdump/pcap capture CPU
- unrelated background processes

Implementation options:

- read `/proc/<pid>/stat`, `/proc/<pid>/status`, `/proc/<pid>/comm`
- sample per PID over intervals
- limit to top 5 by CPU

### 5. Add Network/SoftIRQ Warnings

If host CPU rises but process CPU is low, show diagnostic hints:

```text
Host CPU high, traffic-engine process CPU low.
Likely contributors: kernel network processing, tcpdump, GUI runtime, or other VM processes.
Check CPU breakdown and top processes.
```

Warning triggers:

```text
host_cpu > 80%
process_cpu_core < 5%
```

Additional trigger:

```text
cpu_softirq_percent > 10%
```

## GUI Placement Across Five States

CPU/VM health should be available in every lifecycle state.

### Config State

As soon as the GUI can reach the engine API:

```text
Config page should show VM Health summary
```

Suggested card:

```text
Traffic Engine VM Health
Host CPU
Process CPU
Memory
Open FDs
UDP errors
Top CPU process
```

This helps before starting a test:

- VM already overloaded
- another process consuming CPU
- enough memory available
- engine process reachable

### Reg/Sub State

Show the same VM health card near Reg/Sub progress.

Useful for:

- registration burst CPU impact
- SUBSCRIBE/NOTIFY processing impact
- detecting CPU spikes before traffic starts

### Traffic State

Show full VM health card in dashboard.

Useful for:

- host CPU
- process CPU
- softirq/network CPU
- UDP drops/errors
- process FD/socket growth
- top process attribution

### Report State

Final report should preserve:

- max host CPU during run
- avg host CPU during run
- max process CPU core-equivalent during run
- max softirq/system CPU during run
- top process snapshot at peak or final sample

### Cleanup State

Show the same VM health card during unregister/unsubscribe.

Useful for:

- cleanup burst CPU
- NOTIFY/REGISTER response processing
- socket/FD closure
- lingering processes after cleanup

## Backend API Changes

Current metrics endpoint already exposes host health under:

```json
host_health
```

Extend it with:

```json
{
  "host_health": {
    "cpu_percent": 85.0,
    "cpu_user_percent": 20.0,
    "cpu_system_percent": 12.0,
    "cpu_softirq_percent": 8.0,
    "cpu_iowait_percent": 1.0,
    "cpu_steal_percent": 0.0,
    "process_cpu_percent": 0.0,
    "process_cpu_percent_vm": 0.0,
    "process_cpu_percent_core": 2.5,
    "top_processes": []
  }
}
```

Keep old fields for compatibility.

## Aggregated Run Metrics

Track summary values over the run:

```json
{
  "host_cpu_avg_percent": 72.5,
  "host_cpu_max_percent": 91.2,
  "process_cpu_core_avg_percent": 4.8,
  "process_cpu_core_max_percent": 18.6,
  "softirq_cpu_max_percent": 11.4,
  "iowait_cpu_max_percent": 3.2
}
```

These should appear in final report.

## Implementation Plan

### Phase 1: Backend CPU Metrics

- Rename/alias current process CPU metric.
- Add per-category host CPU calculation from `/proc/stat`.
- Add core-equivalent process CPU.
- Preserve existing `process_cpu_percent`.
- Add unit tests for CPU delta calculations where practical.

### Phase 2: Top Process Snapshot

- Add `/proc` scanner for top CPU processes.
- Keep sample size small: top 5.
- Avoid expensive scanning too frequently.
- Add config to enable/disable if needed.

### Phase 3: GUI Health Card Everywhere

- Reuse existing `VMHealthPanel`.
- Display compact mode on Config and Reg/Sub pages.
- Display full mode on Traffic, Report, Cleanup.
- Show warning hints when host CPU high but engine CPU low.

### Phase 4: Final Report Aggregates

- Track max/avg host and process CPU over run.
- Include in downloaded report JSON.
- Show CPU peak summary in Final Report.

## Risks

### CPU Attribution Is Approximate

Linux process CPU and host CPU are sampled values. They are not exact per-packet attribution.

Mitigation:

- label metrics clearly
- show trends and breakdowns
- do not overclaim causality

### Top Process Scanning Can Be Expensive

Scanning `/proc` for every metrics tick may add overhead on large systems.

Mitigation:

- sample less frequently
- limit to top 5
- make it optional if needed

### GUI Clutter

Showing full health details on every page may overwhelm users.

Mitigation:

- compact summary by default
- expandable details
- warnings only when thresholds are crossed

## Recommended GUI Labels

Use clear labels:

```text
Host CPU
Engine CPU (% VM)
Engine CPU (% Core)
System CPU
SoftIRQ CPU
Top CPU Process
Open FDs
UDP Errors
```

Avoid ambiguous label:

```text
Process CPU
```

unless the tooltip explains exactly how it is calculated.

## Acceptance Criteria

- CPU card visible once engine API is reachable, even before Reg/Sub.
- CPU card visible in all five states:
  - Config
  - Reg/Sub
  - Traffic
  - Report
  - Cleanup
- Host CPU and engine CPU are clearly distinguished.
- Engine CPU has both VM-normalized and core-equivalent values.
- High host CPU with low engine CPU shows diagnostic hint.
- Final report includes CPU max/avg summary.
- Existing `host_health` JSON remains backward compatible.

