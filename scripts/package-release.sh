#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PRODUCT="nexus-traffic-engine"
VERSION="$(sed -E 's/^Nexus Traffic Engine[[:space:]]+//' VERSION | tr -d '[:space:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="amd64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

RELEASE_NAME="${PRODUCT}-${VERSION}-linux-${ARCH}"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$DIST_DIR/$RELEASE_NAME"
TARBALL="$DIST_DIR/${RELEASE_NAME}.tar.gz"
SHA_FILE="$DIST_DIR/${RELEASE_NAME}.sha256"

echo "Packaging $RELEASE_NAME"

echo "Building backend..."
(cd go && go build -o traffic-engine ./cmd/traffic-engine)

echo "Building GUI standalone..."
(cd gui && bun install && bun run build)

rm -rf "$STAGE_DIR" "$TARBALL" "$SHA_FILE"
mkdir -p "$STAGE_DIR"/{bin,config/examples,logs,runtime/bun,scripts,systemd,gui}

cp VERSION "$STAGE_DIR/VERSION"
cp go/traffic-engine "$STAGE_DIR/bin/traffic-engine"
chmod 0755 "$STAGE_DIR/bin/traffic-engine"

mkdir -p "$STAGE_DIR/gui/standalone"
cp -R gui/.next/standalone/. "$STAGE_DIR/gui/standalone/"
mkdir -p "$STAGE_DIR/gui/standalone/.next"
cp -R gui/.next/static "$STAGE_DIR/gui/standalone/.next/static"
if [ -d gui/public ]; then
  cp -R gui/public "$STAGE_DIR/gui/standalone/public"
fi

BUN_BIN="$(command -v bun || true)"
if [ -z "$BUN_BIN" ]; then
  echo "bun runtime is required to build and package the offline GUI runtime" >&2
  exit 1
fi
cp "$BUN_BIN" "$STAGE_DIR/runtime/bun/bun"
chmod 0755 "$STAGE_DIR/runtime/bun/bun"

if [ -d go/scripts ]; then
  cp -R go/scripts/. "$STAGE_DIR/scripts/"
fi

cat > "$STAGE_DIR/config/engine.env.example" <<'EOF'
# Nexus Traffic Engine backend settings
ENGINE_PORT=8082
LOG_LEVEL=INFO
LOG_DIR=logs/runs
GUI_DRAIN_SECONDS=15
EOF

cat > "$STAGE_DIR/config/gui.env.example" <<'EOF'
# Nexus Traffic Engine GUI settings
GUI_PORT=3000
ENGINE_URL=http://127.0.0.1:8082
EOF

cat > "$STAGE_DIR/config/examples/config_traffic-local.example.yaml" <<'EOF'
# Example CLI config. GUI-driven mode normally pushes config over HTTP.
vm_id: traffic-local
ext_start: 6000000
ext_end: 6000009
sbc_host: 192.0.2.10
sbc_port: 5061
sip_transport: TLS
sip_scheme: SIPS
domain: example.com
sip_password: "123456"
tls_mode: server_ca
cps: 1
hold_time_seconds: 60
metrics_port: 8082
register_batch_size: 10
register_batch_delay_ms: 1000
register_expires: 36000
register_retry: 3
register_timeout: 5
connect_timeout: 5
subscribe_concurrency: 10
subscribe_expires: 36000
subscribe_events:
  - dialog
cleanup_batch_size: 20
cleanup_unsubscribe_rate_per_sec: 20
cleanup_unregister_rate_per_sec: 20
cleanup_audit_timeout_minutes: 30
local_ip_mode: single
local_host: ""
media_enabled: true
media_security: rtp
rtp_mode: continuous
rtp_ptime: 20
traffic_mode: timed
duration_hours: 1
EOF

cat > "$STAGE_DIR/run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CMD="${1:-}"
if [ -z "$CMD" ]; then
  echo "Usage:"
  echo "  ./run engine -p 8082 [--debug]"
  echo "  ./run gui -p 3000 [--engine-url http://SERVER_IP:8082] [--debug]"
  echo "  sudo ./run all --engine-port 8082 --gui-port 3000 [--engine-url http://SERVER_IP:8082] [--debug]"
  exit 1
fi
shift || true

ENGINE_PORT="${ENGINE_PORT:-8082}"
GUI_PORT="${GUI_PORT:-3000}"
ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:8082}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs/runs}"

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)
      if [ "${CMD,,}" = "gui" ]; then GUI_PORT="$2"; else ENGINE_PORT="$2"; fi
      shift 2
      ;;
    --engine-port) ENGINE_PORT="$2"; shift 2 ;;
    --gui-port) GUI_PORT="$2"; shift 2 ;;
    --engine-url) ENGINE_URL="$2"; shift 2 ;;
    --debug) LOG_LEVEL="DEBUG"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

mkdir -p "$ROOT_DIR/logs/engine" "$ROOT_DIR/logs/gui" "$ROOT_DIR/logs/runs"

run_engine() {
  echo "Starting Nexus Traffic Engine API on port $ENGINE_PORT"
  echo "Health: http://127.0.0.1:$ENGINE_PORT/api/ping"
  echo "Run logs: $LOG_DIR"
  if [ "$(id -u)" -ne 0 ]; then
    echo "WARNING: engine is not running as root. VIP apply requires sudo/root or CAP_NET_ADMIN." >&2
  fi
  exec "$ROOT_DIR/bin/traffic-engine" --api-only --port "$ENGINE_PORT" --log-level "$LOG_LEVEL" --log-dir "$LOG_DIR"
}

run_gui() {
  echo "Starting Nexus Traffic Engine GUI on port $GUI_PORT"
  echo "GUI: http://0.0.0.0:$GUI_PORT"
  echo "Engine API: $ENGINE_URL"
  cd "$ROOT_DIR/gui/standalone"
  if [ -x "$ROOT_DIR/runtime/bun/bun" ]; then
    JS_RUNTIME="$ROOT_DIR/runtime/bun/bun"
  elif command -v node >/dev/null 2>&1; then
    JS_RUNTIME="$(command -v node)"
  elif command -v bun >/dev/null 2>&1; then
    JS_RUNTIME="$(command -v bun)"
  else
    echo "No JavaScript runtime found. This package normally includes runtime/bun/bun." >&2
    exit 1
  fi
  HOSTNAME=0.0.0.0 PORT="$GUI_PORT" NEXT_PUBLIC_COORDINATOR_URL="$ENGINE_URL" exec "$JS_RUNTIME" server.js
}

case "${CMD,,}" in
  engine) run_engine ;;
  gui) run_gui ;;
  all)
    "$ROOT_DIR/bin/traffic-engine" --api-only --port "$ENGINE_PORT" --log-level "$LOG_LEVEL" --log-dir "$LOG_DIR" &
    ENGINE_PID=$!
    trap 'kill "$ENGINE_PID" 2>/dev/null || true' EXIT
    echo "Engine started with PID $ENGINE_PID"
    echo "Health: http://127.0.0.1:$ENGINE_PORT/api/ping"
    sleep 2
    run_gui
    ;;
  *) echo "Unknown command: $CMD" >&2; exit 1 ;;
esac
EOF
chmod 0755 "$STAGE_DIR/run"

cat > "$STAGE_DIR/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(sed -E 's/^Nexus Traffic Engine[[:space:]]+//' "$SRC_DIR/VERSION" | tr -d '[:space:]')"
BASE="/opt/nexus-traffic-engine"
REL="$BASE/releases/$VERSION"
ETC="/etc/nexus-traffic-engine"
LOG="/var/log/nexus-traffic-engine"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must be run with sudo/root" >&2
  exit 1
fi

mkdir -p "$BASE/releases" "$ETC" "$LOG"/{engine,gui,runs}
rm -rf "$REL"
mkdir -p "$REL"
cp -a "$SRC_DIR"/. "$REL"/
ln -sfn "$REL" "$BASE/current"

[ -f "$ETC/engine.env" ] || cp "$REL/config/engine.env.example" "$ETC/engine.env"
[ -f "$ETC/gui.env" ] || cp "$REL/config/gui.env.example" "$ETC/gui.env"

cp "$REL/systemd/nexus-traffic-engine.service" /etc/systemd/system/nexus-traffic-engine.service
cp "$REL/systemd/nexus-traffic-gui.service" /etc/systemd/system/nexus-traffic-gui.service
systemctl daemon-reload || true

echo "Installed Nexus Traffic Engine $VERSION"
echo "Portable run: $BASE/current/run engine -p 8082"
echo "Service run:"
echo "  sudo systemctl start nexus-traffic-engine"
echo "  sudo systemctl start nexus-traffic-gui"
EOF
chmod 0755 "$STAGE_DIR/install.sh"

cat > "$STAGE_DIR/upgrade.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE="/opt/nexus-traffic-engine"
if [ "$(id -u)" -ne 0 ]; then
  echo "upgrade.sh must be run with sudo/root" >&2
  exit 1
fi

if [ "${1:-}" = "--rollback" ]; then
  current="$(readlink -f "$BASE/current" || true)"
  previous="$(ls -dt "$BASE"/releases/* 2>/dev/null | grep -v "^$current$" | head -n 1 || true)"
  if [ -z "$previous" ]; then echo "No previous release found" >&2; exit 1; fi
  systemctl stop nexus-traffic-gui nexus-traffic-engine 2>/dev/null || true
  ln -sfn "$previous" "$BASE/current"
  systemctl start nexus-traffic-engine nexus-traffic-gui 2>/dev/null || true
  echo "Rolled back to $(basename "$previous")"
  exit 0
fi

pkg="${1:-}"
if [ -z "$pkg" ] || [ ! -f "$pkg" ]; then
  echo "Usage: sudo ./upgrade.sh nexus-traffic-engine-X.Y.Z-linux-amd64.tar.gz | --rollback" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
tar -xzf "$pkg" -C "$tmp"
src="$(find "$tmp" -maxdepth 1 -type d -name 'nexus-traffic-engine-*' | head -n 1)"
version="$(sed -E 's/^Nexus Traffic Engine[[:space:]]+//' "$src/VERSION" | tr -d '[:space:]')"
rel="$BASE/releases/$version"

systemctl stop nexus-traffic-gui nexus-traffic-engine 2>/dev/null || true
mkdir -p "$BASE/releases"
rm -rf "$rel"
mkdir -p "$rel"
cp -a "$src"/. "$rel"/
ln -sfn "$rel" "$BASE/current"
cp "$rel/systemd/nexus-traffic-engine.service" /etc/systemd/system/nexus-traffic-engine.service
cp "$rel/systemd/nexus-traffic-gui.service" /etc/systemd/system/nexus-traffic-gui.service
systemctl daemon-reload || true
systemctl start nexus-traffic-engine nexus-traffic-gui 2>/dev/null || true
echo "Upgraded to Nexus Traffic Engine $version"
EOF
chmod 0755 "$STAGE_DIR/upgrade.sh"

cat > "$STAGE_DIR/uninstall.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" -ne 0 ]; then echo "uninstall.sh must be run with sudo/root" >&2; exit 1; fi
systemctl stop nexus-traffic-gui nexus-traffic-engine 2>/dev/null || true
systemctl disable nexus-traffic-gui nexus-traffic-engine 2>/dev/null || true
rm -f /etc/systemd/system/nexus-traffic-engine.service /etc/systemd/system/nexus-traffic-gui.service
systemctl daemon-reload || true
echo "Removed systemd services. Preserved /opt/nexus-traffic-engine, /etc/nexus-traffic-engine, and /var/log/nexus-traffic-engine."
EOF
chmod 0755 "$STAGE_DIR/uninstall.sh"

cat > "$STAGE_DIR/systemd/nexus-traffic-engine.service" <<'EOF'
[Unit]
Description=Nexus Traffic Engine API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-/etc/nexus-traffic-engine/engine.env
WorkingDirectory=/opt/nexus-traffic-engine/current
ExecStart=/opt/nexus-traffic-engine/current/run engine -p ${ENGINE_PORT}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > "$STAGE_DIR/systemd/nexus-traffic-gui.service" <<'EOF'
[Unit]
Description=Nexus Traffic Engine GUI
After=network-online.target nexus-traffic-engine.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=-/etc/nexus-traffic-engine/gui.env
WorkingDirectory=/opt/nexus-traffic-engine/current
ExecStart=/opt/nexus-traffic-engine/current/run gui -p ${GUI_PORT} --engine-url ${ENGINE_URL}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > "$STAGE_DIR/scripts/apply-vips.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENGINE_URL="${ENGINE_URL:-http://127.0.0.1:8082}"
echo "Apply VIPs from GUI, or POST /api/vips/apply to $ENGINE_URL."
echo "This operation requires the engine to run with sudo/root or CAP_NET_ADMIN."
EOF
chmod 0755 "$STAGE_DIR/scripts/apply-vips.sh"

cat > "$STAGE_DIR/scripts/verify-vips.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ip -br addr
EOF
chmod 0755 "$STAGE_DIR/scripts/verify-vips.sh"

cat > "$STAGE_DIR/scripts/collect-diagnostics.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
OUT="diagnostics-$(date +%Y%m%d_%H%M%S).txt"
{
  date
  echo "== VERSION =="; cat VERSION || true
  echo "== IP ADDR =="; ip -br addr || true
  echo "== UDP SNMP =="; grep -A1 '^Udp:' /proc/net/snmp || true
  echo "== DISK =="; df -h . || true
  echo "== RECENT LOGS =="; ls -lt logs logs/runs 2>/dev/null | head -n 50 || true
} > "$OUT"
echo "Wrote $OUT"
EOF
chmod 0755 "$STAGE_DIR/scripts/collect-diagnostics.sh"

cat > "$STAGE_DIR/README-INSTALL.md" <<EOF
# Nexus Traffic Engine ${VERSION} Install Guide

This package supports two deployment styles:

1. Portable lab mode (run directly from the extracted folder)
2. Installed service mode (install under /opt and run with systemd)

## Requirements

- Ubuntu 22.04+ x86_64/amd64
- Bundled Bun runtime for the packaged Next.js standalone GUI
- sudo/root access if using VIP mode
- Engine API port, default: 8082
- GUI port, default: 3000

## Verify Package

\`\`\`bash
sha256sum -c ${RELEASE_NAME}.sha256
\`\`\`

## Portable Lab Mode

\`\`\`bash
tar -xzf ${RELEASE_NAME}.tar.gz
cd ${RELEASE_NAME}
sudo ./run engine -p 8082
\`\`\`

In another shell:

\`\`\`bash
./run gui -p 3000 --engine-url http://SERVER_IP:8082
\`\`\`

Open:

\`\`\`text
GUI:        http://SERVER_IP:3000
Engine API: http://SERVER_IP:8082
Health:     http://SERVER_IP:8082/api/ping
\`\`\`

## Debug Mode

Portable backend debug:

\`\`\`bash
sudo ./run engine -p 8082 --debug
\`\`\`

Equivalent backend command:

\`\`\`bash
sudo ./bin/traffic-engine --api-only --port 8082 --log-level DEBUG --log-dir logs/runs
\`\`\`

Service mode debug:

\`\`\`bash
sudo vi /etc/nexus-traffic-engine/engine.env
# set LOG_LEVEL=DEBUG
sudo systemctl restart nexus-traffic-engine
\`\`\`

## Installed Service Mode

\`\`\`bash
tar -xzf ${RELEASE_NAME}.tar.gz
cd ${RELEASE_NAME}
sudo ./install.sh
sudo systemctl start nexus-traffic-engine
sudo systemctl start nexus-traffic-gui
\`\`\`

Enable on boot:

\`\`\`bash
sudo systemctl enable nexus-traffic-engine
sudo systemctl enable nexus-traffic-gui
\`\`\`

## Logs

Portable mode:

\`\`\`text
./logs/
./logs/runs/
\`\`\`

System install mode:

\`\`\`text
/var/log/nexus-traffic-engine/
/var/log/nexus-traffic-engine/runs/
\`\`\`

Run artifacts include:

\`\`\`text
traffic_run-*.log
run-*.json
*_calls.ndjson
traffic_summary_*.log
\`\`\`

## VIP Mode Notes

If using \`unique_vip\` or \`vip_pool\`, the VIPs must exist on the Linux interface before sockets can bind to them.

The engine must run with sudo/root or CAP_NET_ADMIN to apply VIPs from the GUI.

If you see:

\`\`\`text
bind: cannot assign requested address
\`\`\`

verify VIPs:

\`\`\`bash
ip -br addr
\`\`\`

## Upgrade

\`\`\`bash
sudo ./upgrade.sh nexus-traffic-engine-NEWVERSION-linux-amd64.tar.gz
\`\`\`

Rollback:

\`\`\`bash
sudo ./upgrade.sh --rollback
\`\`\`

Upgrade preserves:

\`\`\`text
/etc/nexus-traffic-engine/*
/var/log/nexus-traffic-engine/*
\`\`\`
EOF

cat > "$STAGE_DIR/RELEASE-NOTES.txt" <<EOF
Nexus Traffic Engine ${VERSION}

Highlights:
- Long-run memory retention bounded.
- Full call details streamed to disk as NDJSON.
- Current-run UDP error delta reporting.
- REGISTER refresh failure recovery and traffic-pool protection.
- GUI Start New Run flow and post-cleanup reporting improvements.
EOF

touch "$STAGE_DIR/logs/.gitkeep"

echo "Creating tarball..."
(cd "$DIST_DIR" && tar -czf "$TARBALL" "$RELEASE_NAME")
(cd "$DIST_DIR" && sha256sum "$(basename "$TARBALL")" > "$(basename "$SHA_FILE")")

echo "Created:"
echo "  $TARBALL"
echo "  $SHA_FILE"
