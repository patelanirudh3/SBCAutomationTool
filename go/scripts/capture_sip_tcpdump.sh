#!/usr/bin/env bash
# capture_sip_tcpdump.sh — capture SIP signaling on the traffic-engine VM.
#
# Usage:
#   sudo SBC_HOST=10.133.48.203 scripts/capture_sip_tcpdump.sh
#   sudo DURATION=240 IFACE=any SIP_PORT=5060 scripts/capture_sip_tcpdump.sh
#   sudo INCLUDE_RTP=1 SBC_HOST=10.133.48.203 scripts/capture_sip_tcpdump.sh
#
# Environment overrides:
#   IFACE       Capture interface (default: any)
#   DURATION    Capture duration in seconds (default: 180)
#   OUT_DIR     Directory for pcap output (default: logs/tcpdump)
#   SBC_HOST    Optional SBC IP/hostname filter
#   SIP_PORT    SIP TCP/UDP port (default: 5060)
#   INCLUDE_RTP Capture RTP UDP high ports too: 0|1 (default: 0)
#   RTP_RANGE   RTP UDP port range when INCLUDE_RTP=1 (default: 10000-65535)

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
MODULE_ROOT="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${MODULE_ROOT}"

IFACE="${IFACE:-any}"
DURATION="${DURATION:-180}"
OUT_DIR="${OUT_DIR:-logs/tcpdump}"
SBC_HOST="${SBC_HOST:-}"
SIP_PORT="${SIP_PORT:-5060}"
INCLUDE_RTP="${INCLUDE_RTP:-0}"
RTP_RANGE="${RTP_RANGE:-10000-65535}"
DATE_STAMP="$(date +%d%m%Y)"
DAY_STAMP="$(date +%A)"
TIME_STAMP="$(date +%H-%M-%S)"

mkdir -p "${OUT_DIR}"

OUT_FILE="${OUT_DIR}/TrafficEngine_sip_rtp_TCPdump_${DATE_STAMP}_${DAY_STAMP}_${TIME_STAMP}.pcap"
FILTER="(tcp port ${SIP_PORT} or udp port ${SIP_PORT})"

if [[ "${INCLUDE_RTP}" == "1" ]]; then
  FILTER="(${FILTER} or udp portrange ${RTP_RANGE})"
fi

if [[ -n "${SBC_HOST}" ]]; then
  FILTER="host ${SBC_HOST} and ${FILTER}"
fi

log() { printf '\033[36m[sip-tcpdump]\033[0m %s\n' "$*"; }
ok()  { printf '\033[32m[sip-tcpdump]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[sip-tcpdump]\033[0m %s\n' "$*" >&2; }

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

log "Starting SIP capture on traffic-engine VM"
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
