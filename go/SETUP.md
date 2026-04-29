# Go Traffic Engine — Setup Guide

## Prerequisites

- Ubuntu 22.04+ VM (the traffic engine runs here)
- Go 1.22+ installed
- Network connectivity to the SBC under test
- The CCI Studio Next.js GUI running on a Windows laptop (or any host with a browser)

## 1. Install Go

```bash
cd /tmp
wget -q https://go.dev/dl/go1.22.12.linux-amd64.tar.gz
sudo rm -rf /usr/local/go
sudo tar -C /usr/local -xzf go1.22.12.linux-amd64.tar.gz
rm go1.22.12.linux-amd64.tar.gz

# Add to PATH (add to ~/.bashrc for persistence)
export PATH=$PATH:/usr/local/go/bin
go version
```

## 2. Build the Binary

```bash
cd cci-studio/go
go mod tidy
go build -o traffic-engine ./cmd/traffic-engine/
ls -la traffic-engine   # ~10 MB static binary
```

## 3. Kernel Tuning (recommended for high CPS)

```bash
# Increase file descriptor limit
ulimit -n 65535

# Persist across sessions — add to /etc/security/limits.conf:
#   * soft nofile 65535
#   * hard nofile 65535

# Network tuning for high CPS
sudo sysctl -w net.core.somaxconn=4096
sudo sysctl -w net.ipv4.tcp_max_syn_backlog=4096
sudo sysctl -w net.core.rmem_max=16777216
sudo sysctl -w net.core.wmem_max=16777216
sudo sysctl -w net.ipv4.ip_local_port_range="10000 65535"

# Persist — add to /etc/sysctl.d/99-traffic-engine.conf
```

## 4. Running

### GUI-Driven Mode (recommended)

Start the traffic engine in API-only mode — no YAML files needed. The GUI pushes
config as JSON via `PUT /api/config` and controls the full lifecycle over HTTP.

The engine uses a **single-pool model**: every registered extension can both originate
calls (caller/UAC role) and answer incoming calls (callee/UAS role) within the same
process. Only **one instance** is needed per test VM.

```bash
./traffic-engine --api-only --port 8082
```

The GUI workflow:
1. `PUT /api/config` — pushes VM configuration
2. `POST /api/test/start` — starts the full traffic lifecycle
3. `GET /api/test/status` / `WS /metrics/stream` — monitors progress
4. `POST /api/test/stop` — stops traffic
5. `POST /api/test/reset` — resets for a new run

### CLI Mode (with YAML config)

For headless/CI/dev use without the GUI. A single YAML config file is required:

```bash
./traffic-engine --config config.yaml --log-level INFO
```

### Smoke Test (2 calls)

```bash
./traffic-engine --config uac.yaml --max-calls 2 --log-level DEBUG
```

### Pre-Phase Only (register extensions, no calls)

```bash
./traffic-engine --config uac.yaml --pre-phase-only
```

### Dry Run (validate config)

```bash
./traffic-engine --config uac.yaml --dry-run
```

## 5. CLI Flags

| Flag | Env Var | Default | Description |
|------|---------|---------|-------------|
| `--config`, `-c` | `TRAFFIC_CONFIG` | (none) | Path to YAML config file |
| `--log-level` | `LOG_LEVEL` | `INFO` | `DEBUG\|INFO\|WARNING\|ERROR` |
| `--skip-subscribe` | `SKIP_SUBSCRIBE` | `false` | Skip SUBSCRIBE pre-phase |
| `--dry-run` | — | `false` | Validate config and exit |
| `--log-file` | `LOG_FILE` | (auto) | Log file path |
| `--log-dir` | `LOG_DIR` | `logs` | Directory for auto-generated logs |
| `--max-calls` | `MAX_CALLS` | `0` | Stop after N calls (0 = config-driven) |
| `--pre-phase-only` | `PRE_PHASE_ONLY` | `false` | Register+Subscribe only |
| `--no-unregister` | `NO_UNREGISTER` | `false` | Skip unregister on shutdown |
| `--api-only` | `API_ONLY` | `false` | Start API server only |
| `--port` | `API_PORT` | `0` | API server port (for `--api-only`) |
| `--gui-drain-seconds` | `GUI_DRAIN_SECONDS` | `15` | Keep server alive after SIP cleanup |

## 6. API Endpoints

All endpoints support CORS (`Access-Control-Allow-Origin: *`).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/metrics` | Current metrics snapshot (JSON) |
| WS | `/metrics/stream` | Real-time metrics push (WebSocket) |
| GET | `/api/ping` | Health check / reachability |
| GET | `/api/test/status` | Phase, running state, elapsed time |
| PUT | `/api/config` | Push VM configuration (JSON body) |
| POST | `/api/test/start` | Start traffic (requires `run_id`, `pair_id`) |
| POST | `/api/test/stop` | Stop traffic gracefully |
| POST | `/api/test/reset` | Reset to IDLE for new run |
| POST | `/api/shutdown` | Exit the process |
| GET | `/api/calls` | Call detail records |
| GET | `/api/calls/{id}` | Events for a specific call |
| GET | `/api/call-results` | Raw call result objects |
| GET | `/api/call-spines` | Correlated UAC/UAS call spines |
| GET | `/api/scenarios` | Available test scenarios |
| GET | `/api/vms` | VM info array |

## 7. Output Files

After a traffic run, the engine produces:

- `logs/traffic_{run_id}_{pair_id}_{vm_id}.log` — full debug log
- `logs/run-{run_id}_{pair_id}_{vm_id}.json` — structured run results with call_results, call_spines, and summary

## 8. Architecture

```
cmd/traffic-engine/main.go     CLI + lifecycle orchestration
internal/
  sip/         SIP message parsing, building, transport, digest auth
  config/      VMConfig loading (YAML + env) and validation
  rtp/         RTP endpoint (G.711 PCMU), codec, PCAP writer
  agent/       ExtensionAgent — one per SIP extension
  prephase/    Batched REGISTER + SUBSCRIBE
  engine/      CallEngine (caller) + UasAutoAnswer (callee, same process)
  metrics/     MetricsCollector + HTTP/WS server (15 endpoints)
  spine/       Call spine correlation (GSID + ext_time strategies)
```

## 9. Dependencies

- `gorilla/websocket` — WebSocket support for metrics streaming
- `gopkg.in/yaml.v3` — YAML config parsing
- Standard library only for everything else (SIP, RTP, HTTP, TLS)
