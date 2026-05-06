#!/usr/bin/env bash
# redeploy.sh — rebuild traffic-engine and restart it in place.
#
# What it does (in order):
#   1. cd into the go module root
#   2. Build a fresh ./traffic-engine binary
#   3. Stop any currently-running traffic-engine process
#   4. Start the new binary in the background (--api-only --port $PORT)
#   5. Wait for the API to become ready and curl /api/regsub/start as a smoke
#      test so the operator sees immediately whether the new routes are live
#
# Usage:
#   scripts/redeploy.sh                  # default port 8082
#   PORT=9000 scripts/redeploy.sh        # custom port
#   scripts/redeploy.sh --no-build       # restart only, skip recompile
#   scripts/redeploy.sh --foreground     # run in foreground (for debugging)
#
# Environment overrides:
#   PORT              API port (default: 8082)
#   LOG_LEVEL         INFO|DEBUG|WARNING|ERROR (default: INFO)
#   BINARY_NAME       Output binary name (default: traffic-engine)
#   STDOUT_LOG        Where the background process's stdout/stderr goes
#                     (default: /tmp/traffic-engine.out)

set -euo pipefail

# --------------------------------------------------------------------------
# Locate the module root (one level up from this script's dir)
# --------------------------------------------------------------------------
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MODULE_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${MODULE_ROOT}"

PORT="${PORT:-8082}"
LOG_LEVEL="${LOG_LEVEL:-INFO}"
BINARY_NAME="${BINARY_NAME:-traffic-engine}"
STDOUT_LOG="${STDOUT_LOG:-/tmp/traffic-engine.out}"

DO_BUILD=1
FOREGROUND=0
for arg in "$@"; do
  case "$arg" in
    --no-build)   DO_BUILD=0 ;;
    --foreground) FOREGROUND=1 ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '\033[36m[redeploy]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[redeploy]\033[0m %s\n' "$*"; }
warn(){ printf '\033[33m[redeploy]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[redeploy]\033[0m %s\n' "$*" >&2; }

# --------------------------------------------------------------------------
# 1. Build
# --------------------------------------------------------------------------
if [[ $DO_BUILD -eq 1 ]]; then
  log "Building ${BINARY_NAME} from ${MODULE_ROOT}"
  go build -o "${BINARY_NAME}" ./cmd/traffic-engine
  ls -lh "${BINARY_NAME}"
  ok "Build complete"
else
  warn "Skipping build (--no-build)"
fi

# --------------------------------------------------------------------------
# 2. Stop any running instance
# --------------------------------------------------------------------------
PIDS=$(pgrep -f "${BINARY_NAME}" 2>/dev/null | grep -v "$$" || true)
if [[ -n "${PIDS}" ]]; then
  log "Stopping existing traffic-engine PID(s): ${PIDS}"
  # Polite SIGTERM first
  for pid in ${PIDS}; do
    kill -TERM "${pid}" 2>/dev/null || true
  done
  # Give it up to 5s to exit cleanly
  for _ in 1 2 3 4 5; do
    REMAINING=$(pgrep -f "${BINARY_NAME}" 2>/dev/null | grep -v "$$" || true)
    [[ -z "${REMAINING}" ]] && break
    sleep 1
  done
  REMAINING=$(pgrep -f "${BINARY_NAME}" 2>/dev/null | grep -v "$$" || true)
  if [[ -n "${REMAINING}" ]]; then
    warn "Process(es) still alive after SIGTERM, forcing SIGKILL: ${REMAINING}"
    for pid in ${REMAINING}; do
      kill -KILL "${pid}" 2>/dev/null || true
    done
    sleep 1
  fi
  ok "Old process stopped"
else
  log "No existing traffic-engine process found"
fi

# --------------------------------------------------------------------------
# 3. Start the new binary
# --------------------------------------------------------------------------
if [[ $FOREGROUND -eq 1 ]]; then
  log "Starting in foreground: ./${BINARY_NAME} --api-only --port ${PORT} --log-level ${LOG_LEVEL}"
  exec ./"${BINARY_NAME}" --api-only --port "${PORT}" --log-level "${LOG_LEVEL}"
fi

log "Starting in background → ${STDOUT_LOG}"
nohup ./"${BINARY_NAME}" --api-only --port "${PORT}" --log-level "${LOG_LEVEL}" \
  > "${STDOUT_LOG}" 2>&1 &
NEW_PID=$!
disown "${NEW_PID}" 2>/dev/null || true
log "New PID: ${NEW_PID}"

# --------------------------------------------------------------------------
# 4. Wait for /api/ping to respond, then smoke-test new endpoints
# --------------------------------------------------------------------------
log "Waiting for API on port ${PORT}…"
for i in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/ping" > /dev/null 2>&1; then
    ok "API is up after ${i}s"
    break
  fi
  if ! kill -0 "${NEW_PID}" 2>/dev/null; then
    err "Process ${NEW_PID} died — check ${STDOUT_LOG}"
    tail -20 "${STDOUT_LOG}" || true
    exit 1
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:${PORT}/api/ping" > /dev/null 2>&1; then
  err "API never came up. Last 20 lines of ${STDOUT_LOG}:"
  tail -20 "${STDOUT_LOG}" || true
  exit 1
fi

# Smoke-test the new lifecycle endpoints. We expect:
#   - /api/regsub/start → 400 (not in CONFIGURED state) on a fresh server,
#     OR 202 if config has been pushed. Either way: NOT 404.
#   - /api/prep/start  → same as above.
# A 404 here means we're hitting a stale binary somehow.
log "Smoke testing new routes…"
for route in /api/regsub/start /api/prep/start /api/restart-traffic; do
  STATUS=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}${route}" || echo 000)
  case "${STATUS}" in
    404)
      err "  ${route} → 404 (stale binary?? this should never happen)"
      exit 1
      ;;
    000)
      err "  ${route} → no response"
      exit 1
      ;;
    *)
      ok "  ${route} → HTTP ${STATUS} (route exists)"
      ;;
  esac
done

ok "Redeploy complete. PID=${NEW_PID}, port=${PORT}, log=${STDOUT_LOG}"
