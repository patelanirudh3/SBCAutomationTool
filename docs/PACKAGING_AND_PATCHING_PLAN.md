# Nexus Traffic Engine Packaging and Patching Plan

## Goals

- Ship Nexus Traffic Engine as a downloadable package that can be installed on a target Linux server.
- Provide simple operator commands for running the backend engine and GUI:
  - `./run Engine -p 8082`
  - `./run GUI -p 3000`
- Allow the user to choose GUI and engine ports at runtime.
- Support production patch delivery without requiring a full reinstall.
- Keep logs, configuration, binaries, GUI assets, and patch backups in predictable locations.

## Proposed Package Layout

```text
nexus-traffic-engine/
  VERSION
  README-INSTALL.md
  run
  install.sh
  patch.sh

  bin/
    traffic-engine

  gui/
    .next/
    package.json
    node_modules/          # optional if shipping a self-contained GUI runtime
    bun.lock               # optional if building/installing with bun

  config/
    engine.env
    gui.env
    examples/

  scripts/
    capture_sip_tcpdump.sh
    capture_rtp_tcpdump.sh

  logs/
    engine/
    gui/
    runs/

  backups/
  patches/
```

Recommended install locations for a system install:

```text
/opt/nexus-traffic-engine
/etc/nexus-traffic-engine
/var/log/nexus-traffic-engine
```

For a portable/lab install, the package can run directly from the extracted directory.

## Runtime Commands

### Engine

Operator command:

```bash
./run Engine -p 8082
```

Equivalent backend command:

```bash
./bin/traffic-engine --api-only --port 8082 --log-level INFO
```

The wrapper should:

- validate the engine binary exists
- create log directories if needed
- pass the selected port to the backend
- print the API and health-check URLs

Example output:

```text
Nexus Traffic Engine API started
Engine API: http://0.0.0.0:8082
Health:     http://127.0.0.1:8082/api/ping
Logs:       logs/engine/
```

### GUI

Operator command:

```bash
./run GUI -p 3000 --engine-url http://SERVER_IP:8082
```

Equivalent GUI command:

```bash
cd gui
bun run start -- --hostname 0.0.0.0 --port 3000
```

The wrapper should:

- validate GUI build assets exist
- pass selected GUI port
- set or validate the engine URL
- print the GUI URL

Example output:

```text
Nexus Traffic Engine GUI started
GUI:        http://0.0.0.0:3000
Engine API: http://SERVER_IP:8082
Logs:       logs/gui/
```

### Optional Combined Mode

Optional operator command:

```bash
./run All --engine-port 8082 --gui-port 3000 --engine-url http://SERVER_IP:8082
```

This can be useful for demo/lab setups. For production, running the GUI and engine as separate services is cleaner.

## GUI Backend URL

The GUI must know the backend engine API URL.

Do not rely on browser-side `localhost` for remote users. If a user opens the GUI from a laptop, `localhost:8082` points to the laptop, not the traffic-engine server.

Recommended explicit form:

```bash
./run GUI -p 3000 --engine-url http://10.1.2.3:8082
```

Where `10.1.2.3` is the traffic-engine server IP or DNS name reachable from the browser.

## Build Strategy

### Backend

Build before packaging:

```bash
cd go
go build -o traffic-engine ./cmd/traffic-engine
```

Package output:

```text
bin/traffic-engine
```

### GUI

If using `bun`:

```bash
cd gui
bun install
bun run build
```

Package output:

```text
gui/.next/
gui/package.json
gui/node_modules/       # if shipping runtime dependencies
```

Open decision:

- Ship `node_modules`/runtime dependencies for an offline install.
- Or require `bun install` on the target server during `install.sh`.

For production-style packaging, prefer a self-contained package where the install does not need internet access.

## Install Flow

Example user flow:

```bash
unzip nexus-traffic-engine-1.3-linux-amd64.zip
cd nexus-traffic-engine
sudo ./install.sh
./run Engine -p 8082
./run GUI -p 3000 --engine-url http://SERVER_IP:8082
```

`install.sh` should:

1. Validate OS and CPU architecture.
2. Check required dependencies:
   - shell
   - curl
   - optional: systemd
   - optional: bun/node runtime if GUI is not fully bundled
3. Create install directories.
4. Copy binaries, GUI assets, scripts, and default config.
5. Create log directories.
6. Optionally install systemd service files.
7. Print next-step commands.

## Logs

Recommended log paths:

```text
logs/engine/
logs/gui/
logs/runs/
```

System install paths:

```text
/var/log/nexus-traffic-engine/engine/
/var/log/nexus-traffic-engine/gui/
/var/log/nexus-traffic-engine/runs/
```

Backend run logs and final reports should remain easy to locate:

```text
traffic_run-*.log
run-*.json
```

## TLS Certificate Storage

When operators upload TLS certificates from the GUI, the traffic engine stores
them under a managed certificate directory. Operators normally do not need to
type these paths manually.

Portable/lab package layout:

```text
certs/
  ca/
  client/
  private/
```

System install layout:

```text
/etc/nexus-traffic-engine/certs/
  ca/
  client/
  private/
```

Certificate upload rules:

- CA certificates are stored under `certs/ca/`.
- Client identity certificates are stored under `certs/client/`.
- Client private keys are stored under `certs/private/`.
- Uploaded filenames can be any safe name; they do not need to be `sbc-ca.pem`.
- Accepted file extensions should include `.pem`, `.crt`, and `.cer` for certificates, and `.pem`/`.key` for private keys.
- File contents must be valid PEM.
- Uploaded filenames are sanitized by the engine before writing to disk.
- Private keys are written with restricted permissions (`0600`).
- Certificate and key contents must never be logged or returned to the GUI.

SNI / Server Name is optional:

```text
Use SNI only when connecting by IP or alias but the SBC certificate is issued
to a different DNS name.
```

## Service Mode

For production installs, consider systemd services:

```text
nexus-traffic-engine.service
nexus-traffic-gui.service
```

Common commands:

```bash
sudo systemctl start nexus-traffic-engine
sudo systemctl start nexus-traffic-gui
sudo systemctl status nexus-traffic-engine
sudo systemctl status nexus-traffic-gui
journalctl -u nexus-traffic-engine -f
journalctl -u nexus-traffic-gui -f
```

The `./run` command can remain available for foreground/lab usage.

## Patching Strategy

Production patching should avoid full reinstall whenever possible.

### Patch Package Layout

```text
patches/
  nexus-traffic-engine-1.3.1.patch/
    PATCH_MANIFEST.json
    VERSION
    bin/
      traffic-engine              # if backend changed
    gui/
      .next/                      # if GUI changed
      package.json
    scripts/
      post_patch_check.sh         # optional
```

### Patch Manifest

Example:

```json
{
  "product": "Nexus Traffic Engine",
  "from_version": "1.3.0",
  "to_version": "1.3.1",
  "type": "hotfix",
  "components": ["engine", "gui"],
  "requires_restart": true,
  "backup": true,
  "notes": "Fix cleanup state reporting and subscription timeout behavior"
}
```

### Patch Command

Operator command:

```bash
./patch.sh patches/nexus-traffic-engine-1.3.1.patch
```

`patch.sh` should:

1. Read `PATCH_MANIFEST.json`.
2. Verify current installed version matches `from_version`.
3. Stop affected services/processes.
4. Create a backup:

   ```text
   backups/1.3.0-YYYYMMDD-HHMMSS/
   ```

5. Copy patched files.
6. Update `VERSION`.
7. Run post-patch health checks.
8. Restart services if `requires_restart=true`.
9. Print success/failure summary.

### Rollback

Rollback command:

```bash
./patch.sh --rollback backups/1.3.0-YYYYMMDD-HHMMSS
```

Rollback should:

1. Stop affected services.
2. Restore backed-up files.
3. Restore `VERSION`.
4. Restart services.
5. Run health checks.

## Patch Types

### Engine-Only Patch

Use when only Go backend changes.

Contents:

```text
bin/traffic-engine
VERSION
PATCH_MANIFEST.json
```

Requires backend restart.

### GUI-Only Patch

Use when only GUI changes.

Contents:

```text
gui/.next/
gui/package.json
VERSION
PATCH_MANIFEST.json
```

Requires GUI restart.

### Full Patch

Use when both backend and GUI change.

Contents:

```text
bin/traffic-engine
gui/.next/
gui/package.json
VERSION
PATCH_MANIFEST.json
```

Requires backend and GUI restart.

## Health Checks

Backend:

```bash
curl -fsS http://127.0.0.1:8082/api/ping
```

GUI:

```bash
curl -fsS http://127.0.0.1:3000
```

Optional API checks:

```bash
curl -fsS http://127.0.0.1:8082/metrics
curl -fsS http://127.0.0.1:8082/api/test/status
```

## Versioning

Suggested version style:

```text
1.3.0  full feature release
1.3.1  hotfix patch
1.3.2  second hotfix patch
1.4.0  next feature release
```

Current version marker files:

```text
VERSION
go/internal/version/version.go
gui/package.json
```

## Open Decisions

- Should the package bundle `bun` or require it on the target server?
- Should GUI be shipped prebuilt or built during install?
- Should `./run All` be supported for production or only labs?
- Should systemd service installation be optional or default?
- Should patch packages be zip files or directories?
- Should `patch.sh` verify checksums for patch files?
- Should logs stay inside the package directory for portable installs or always move to `/var/log`?

