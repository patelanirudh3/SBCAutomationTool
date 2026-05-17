#!/usr/bin/env bash
# capture_rtp_tcpdump.sh — capture RTP/SIP UDP traffic on the traffic-engine VM.
#
# This script runs tcpdump on the machine where it is executed and writes a
# Wireshark-readable pcap under logs/tcpdump by default.
#
# Usage:
#   sudo scripts/capture_rtp_tcpdump.sh
#   sudo DURATION=240 IFACE=any scripts/capture_rtp_tcpdump.sh
#   sudo SBC_HOST=10.133.48.203 PORT_RANGE=10000-65535 scripts/capture_rtp_tcpdump.sh
#
# Environment overrides:
#   IFACE       Capture interface (default: any)
#   DURATION    Capture duration in seconds (default: 180)
#   OUT_DIR     Directory for pcap output (default: logs/tcpdump)
#   PORT_RANGE  UDP port range to capture (default: 10000-65535)
#   SBC_HOST    Optional SBC/media IP or hostname to narrow capture
#   EXTRA_FILTER Optional tcpdump filter expression appended with "and (...)"

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MODULE_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${MODULE_ROOT}"

IFACE="${IFACE:-any}"
DURATION="${DURATION:-180}"
OUT_DIR="${OUT_DIR:-logs/tcpdump}"
PORT_RANGE="${PORT_RANGE:-10000-65535}"
SBC_HOST="${SBC_HOST:-}"
EXTRA_FILTER="${EXTRA_FILTER:-}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "${OUT_DIR}"

OUT_FILE="${OUT_DIR}/traffic_engine_udp_${TS}.pcap"
FILTER="udp and portrange ${PORT_RANGE}"

if [[ -n "${SBC_HOST}" ]]; then
  FILTER="${FILTER} and host ${SBC_HOST}"
fi

if [[ -n "${EXTRA_FILTER}" ]]; then
  FILTER="${FILTER} and (${EXTRA_FILTER})"
fi

log() { printf '\033[36m[tcpdump]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[tcpdump]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[tcpdump]\033[0m %s\n' "$*" >&2; }

if ! command -v tcpdump >/dev/null 2>&1; then
  err "tcpdump not found. Install tcpdump on this VM and retry."
  exit 1
fi

if ! command -v timeout >/dev/null 2>&1; then
  err "timeout command not found. Install coreutils or run tcpdump manually."
  exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
  err "tcpdump usually requires root. Re-run with sudo, or grant capture capabilities to tcpdump."
  exit 1
fi

log "Starting capture on traffic-engine VM"
log "Interface : ${IFACE}"
log "Duration  : ${DURATION}s"
log "Output    : ${OUT_FILE}"
log "Filter    : ${FILTER}"

set +e
timeout --preserve-status "${DURATION}" tcpdump \
  -i "${IFACE}" \
  -nn \
  -s 0 \
  -w "${OUT_FILE}" \
  "${FILTER}"
status=$?
set -e

# GNU timeout commonly returns 143 when it terminates tcpdump after SIGTERM.
if [[ "${status}" -ne 0 && "${status}" -ne 124 && "${status}" -ne 143 ]]; then
  err "tcpdump failed with exit code ${status}"
  exit "${status}"
fi

if [[ ! -s "${OUT_FILE}" ]]; then
  err "Capture file is empty: ${OUT_FILE}"
  exit 1
fi

ok "Capture complete: ${OUT_FILE}"
ls -lh "${OUT_FILE}"
