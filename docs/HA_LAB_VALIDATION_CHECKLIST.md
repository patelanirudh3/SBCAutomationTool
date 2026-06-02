# Nexus Traffic Engine HA Lab Validation Checklist

Use this checklist when validating Remote Server HA in a lab environment.

## Pre-flight

- Build and deploy the same backend and GUI version.
- Start the engine with console capture enabled:
  ```bash
  GOTRACEBACK=all ./traffic-engine --api-only --port 8082 2>&1 | tee ../engine-console.log
  ```
- Confirm primary and secondary SBC/controller IPs and ports are reachable.
- Confirm VIPs are applied and routeable from the VM.
- Keep `auto_failback_enabled` off for the first pass.

## Single-controller regression

- Run the known-good single-controller baseline.
- Confirm TCP/TLS connections complete.
- Confirm REGISTER completes.
- Confirm SUBSCRIBE completes.
- Confirm ready pool count is expected.
- Run short traffic and cleanup.

## HA baseline

- Enable dual registration.
- Start with 10-50 extensions.
- Confirm primary registration count.
- Confirm secondary registration count.
- Confirm active subscription starts on primary only.
- Confirm HA readiness counts:
  - HA Protected
  - Degraded
  - Not Usable

## Manual failover

- Move subscriptions to secondary from the GUI.
- Confirm active controller changes to secondary.
- Confirm ready pool contains only successfully moved/subscribed users.
- Confirm HA timeline records the move.
- Run short traffic on secondary.

## Primary recovery and manual failback

- Restore primary reachability.
- Confirm GUI shows primary recovery.
- Click Move to Primary.
- Confirm active controller changes to primary.
- Confirm ready pool contains only successfully moved/subscribed users.
- Confirm HA timeline records the failback.

## Automatic failback

- Enable auto failback only after manual failback passes.
- Configure a conservative failback delay.
- Move/fail over to secondary.
- Restore primary.
- Confirm auto failback starts only after the delay.
- Confirm timeline records recovery and auto failback.

## Artifacts to collect

- `traffic_run-*.log`
- `engine-console.log`
- `run-*.json`
- Screenshots of HA readiness panel
- SBC-side registration/subscription state
- Timestamps for failover, recovery, and failback
