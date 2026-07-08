# Design for Single Instance Traffic Run

## Goal

Make the Nexus Traffic Engine safe and usable as a shared internal traffic-test tool on a VM:

- only one engine/web service instance runs per VM
- users open one URL and see the current tool state
- each user has a dedicated saved configuration
- users can see current traffic owner/status and queue for the tool
- users can browse previous run reports

This design is intentionally phased so each step has limited blast radius.

## Phase 1: Single Engine Instance Lock

### Objective

Prevent multiple traffic-engine instances from running on the same VM, even if someone tries a different port.

### Design

Use an OS-level advisory lock file at startup, for example:

```text
/tmp/nexus-traffic-engine.lock
```

or a configurable path:

```text
NEXUS_TRAFFIC_ENGINE_LOCK=/var/lock/nexus-traffic-engine.lock
```

Startup behavior:

1. Open the lock file.
2. Try to acquire an exclusive non-blocking lock.
3. If successful, continue startup.
4. If lock is already held, exit with:

```text
Engine is already running, check the status in a browser.
```

Optionally write metadata into the lock file:

```json
{
  "pid": 12345,
  "port": 8082,
  "started_at": "2026-05-25T10:00:00Z",
  "status_url": "https://<vm-ip>/nexustraffic"
}
```

### Risk

Low risk.

This affects startup only. It does not touch SIP, RTP, registration, traffic generation, metrics, or GUI runtime.

### Notes

Do not rely on `ps | grep traffic-engine` as the enforcement mechanism. It is useful for diagnostics, but it is not race-safe and can match unrelated processes.

## Phase 2: Login and Per-User Configuration Storage

### Objective

Give each internal user a dedicated saved configuration profile.

### Design

Use a lightweight local login model:

- admin pre-creates users
- user logs in with Avaya email and password
- email must end with `@avaya.com`
- password is stored as a one-way hash, not plain text and not reversible encryption

Example user file:

```json
{
  "users": [
    {
      "email": "user@avaya.com",
      "name": "User Name",
      "password_hash": "$argon2id$...",
      "role": "user",
      "enabled": true,
      "created_at": "2026-05-25T10:00:00Z"
    }
  ]
}
```

Recommended storage:

```text
data/users/<sha256-email>/profile.json
data/users/<sha256-email>/config.json
```

Backend APIs:

```text
POST /api/session/login
POST /api/session/logout
GET  /api/session/me
GET  /api/user/config
PUT  /api/user/config
```

Minimum safety requirements:

- password hashes using Argon2id or bcrypt
- user/admin files restricted to engine service user permissions
- atomic JSON writes: write temp file, fsync, rename
- validate config before saving/loading
- HTTPS when users enter passwords
- session cookie/token expiry

### Risk

Low to moderate risk.

This should not affect traffic execution if kept separate from SIP/RTP paths. Main risk is GUI/config workflow regression.

### Notes

This is not as strong as enterprise SSO, but it is practical for an internal testing tool. SSO can replace the login method later while keeping the same per-user config storage model.

## Phase 3: Single URL, State-Aware Landing, Owner Status, and Queue

### Objective

Users open one URL and always land in the right tool context:

```text
https://<vm-ip>/nexustraffic
```

After login, the user sees the Config page plus current traffic status.

### Design

Add a backend app-state endpoint:

```text
GET /api/app/state
```

Example response:

```json
{
  "phase": "TRAFFIC",
  "owner_email": "user1@avaya.com",
  "owner_name": "User One",
  "run_id": "run-20260525_140000",
  "elapsed_seconds": 600,
  "estimated_time_left_seconds": 1200,
  "current_user_email": "user2@avaya.com",
  "can_control": false,
  "queue_position": 2
}
```

The GUI status card should show:

- current engine phase
- current owner
- current run ID
- elapsed time and estimated time left
- whether current user can control the run
- queue position
- action button: `Start Now`, `View Running Traffic`, `Join Queue`, or `Wait for Turn`

Queue endpoints:

```text
GET    /api/queue/status
POST   /api/queue/join
DELETE /api/queue/me
```

Queue storage:

```text
data/queue.json
```

Low-risk queue behavior:

- only one active owner can control traffic
- other users can view running dashboard read-only
- users can join queue while traffic is running
- do not auto-start queued runs in this phase
- when current run completes, first queued user gets `Your turn`
- user manually clicks Start Reg/Sub when ready

### Risk

Moderate risk.

The traffic engine runtime can remain unchanged, but this changes shared GUI state, ownership decisions, and routing.

### Notes

Keep existing internal routes such as `/config`, `/launch`, and `/run`. Use `/nexustraffic` as the main entry point and shell. Avoid aggressive auto-redirects; show clear buttons instead.

## Phase 4: Run History and Report Browser

### Objective

Add a GUI page showing previous runs and their final reports.

### Design

At end of each run, save report artifacts:

```text
data/runs/
  run-20260525_140000/
    metadata.json
    report.json
    call-events.json
```

Example `metadata.json`:

```json
{
  "run_id": "run-20260525_140000",
  "owner_email": "user@avaya.com",
  "owner_name": "User Name",
  "started_at": "2026-05-25T14:00:00Z",
  "ended_at": "2026-05-25T14:30:00Z",
  "status": "COMPLETED",
  "traffic_mode": "timed",
  "cps": 10,
  "duration_seconds": 1800,
  "asr": 99.5,
  "csr": 99.0
}
```

Backend APIs:

```text
GET /api/reports
GET /api/reports/{run_id}
```

GUI:

- add `Reports` option on home/config page
- report list table:
  - date/time
  - owner
  - run ID
  - status
  - traffic mode
  - CPS
  - duration
  - ASR/CSR
- clicking a row opens report detail page

### Risk

Very low risk if implemented as read-only.

It should not affect current traffic execution because it is additive and reads saved report files.

### Notes

To avoid performance and disk issues:

- keep small `metadata.json` for list view
- load full report only when a run is selected
- add pagination/search/filter
- make report save best-effort so traffic completion is not blocked
- later add retention policy, such as last 100 runs or last 30 days

## Recommended Implementation Order

1. Phase 1: Single-instance lock.
2. Phase 2: Login and per-user config JSON.
3. Phase 3: `/nexustraffic` state-aware landing and manual queue.
4. Phase 4: Read-only run history/report browser.

## Overall Risk Summary

| Phase | Scope | Risk to Traffic Runtime | Main Risk |
|---|---|---:|---|
| Phase 1 | Startup lock | Low | lock path/permissions |
| Phase 2 | Login + user configs | Low | GUI config workflow |
| Phase 3 | Shared state + queue | Low to moderate | ownership/routing/queue state |
| Phase 4 | Report history | Very low | disk growth/report read performance |

The safest rule is to keep SIP/RTP traffic execution unchanged until the shared-user workflow is proven stable.
