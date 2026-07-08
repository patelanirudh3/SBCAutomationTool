# Trunk Traffic Implementation Plan

## Feasibility Assessment

### Key Finding: The existing architecture already supports multiplexing

The current `ExtensionAgent` dispatch loop (`go/internal/agent/agent.go:2286`) already routes incoming SIP messages by Call-ID via `dialogQueues[callID]`. A single transport + dispatch loop can handle multiple concurrent INVITE transactions. This means **Trunk mode is architecturally feasible without rewriting the SIP engine**.

The critical difference between Agent mode and Trunk mode:

- **Agent-Agent Mode**: 1 socket per agent (1000 agents = 1000 sockets), each agent handles 1 call at a time
- **Trunk-Trunk Mode**: 1 UAC socket + 1 UAS socket (total 2), each trunk handles N concurrent calls multiplexed by Call-ID

### What needs to change

| Layer | Agent-Agent (current) | Trunk-Trunk (new) |
|-------|----------------------|-------------------|
| Sockets | 1 per agent (1000 agents = 1000 sockets) | 1 UAC socket, 1 UAS socket (total 2) |
| Registration | REGISTER per agent | No registration |
| INVITE From/To | Agent ext as URI | Configurable number range |
| Call-ID routing | 1 call per agent at a time | Many concurrent calls per trunk |
| RTP ports | 1 per call (unchanged) | 1 per call (unchanged) |
| Metrics/Report | Same | Same (count by Call-ID) |

---

## Architecture Design

### New Component: TrunkAgent

A `TrunkAgent` wraps a single `sip.Transport` but manages multiple concurrent dialogs (unlike `ExtensionAgent` which does 1 call at a time). It reuses the existing:
- `sip.Transport` interface (TCP/TLS/UDP)
- `sip.BuildMessage` / `sip.ClassifyMessage` parsing
- `rtp.RtpEndpoint` per-call media
- `metrics.MetricsCollector` reporting

### Data Flow

```
TrunkConfig (from_range, to_range, cps, hold_time)
    |
    v
TrunkCallEngine
    |
    +---> TrunkAgent UAC (1 transport)
    |         |-- INVITE (Call-ID-1) --\
    |         |-- INVITE (Call-ID-2) ---}--> TCP/TLS Socket --> SBC
    |         |-- INVITE (Call-ID-N) --/
    |
    +---> TrunkAgent UAS (1 transport)
              |<-- INVITE (Call-ID-1) --\
              |<-- INVITE (Call-ID-2) ---}-- TCP/TLS Socket <-- SBC
              |<-- INVITE (Call-ID-N) --/
```

---

## Implementation Phases

### Phase 1: Backend - TrunkAgent + TrunkCallEngine

#### 1.1 TrunkAgent (`go/internal/engine/trunk_agent.go` - new file)

- Wraps a single `sip.Transport`
- Manages a map of active dialogs: `map[string]*TrunkDialog` keyed by Call-ID
- Dispatch loop routes responses to the correct dialog by Call-ID (same pattern as `ExtensionAgent.dispatchLoop`)
- No REGISTER/SUBSCRIBE logic
- Methods: `SendInvite(fromNum, toNum, rtpPort) (*TrunkDialog, error)`, `SendAck(dialog)`, `SendBye(dialog)`, `WaitForEvent(callID, timeout, codes...)`
- From/To URIs built from number range + domain config

#### 1.2 TrunkCallEngine (`go/internal/engine/trunk_call_engine.go` - new file)

- Similar to `CallEngine` but:
  - Uses 1 `TrunkAgent` for UAC, 1 for UAS
  - Picks next caller/callee from configured number ranges
  - Manages CPS pacing (reuse existing `pacingInterval` logic)
  - Each call goroutine: `INVITE -> 180 -> 200 -> ACK -> RTP -> BYE -> 200 BYE`
  - `CallResult` output is identical to agent-agent (same metrics pipeline)
- Max concurrent calls governed by config (since all share 1 socket)

#### 1.3 TrunkConfig (`go/internal/config/config.go` - extend)

New fields in config YAML:

```yaml
traffic_type: trunk_trunk  # or "agent_agent" (default), "trunk_agent", "combined"

trunk:
  uac_from_start: 1000
  uac_from_end: 1999
  uac_local_ip: 172.16.101.1
  uas_to_start: 2000
  uas_to_end: 2999
  uas_local_ip: 172.16.101.2
  max_concurrent: 500
```

#### 1.4 Integration with existing metrics

`TrunkCallEngine` produces the same `CallResult` struct. The existing `callResultToMetrics()` bridge, `MetricsCollector.RecordCall()`, and `/api/calls` endpoint work unchanged. The GUI `FailedCallsTable`, aggregate panels, and reports all work as-is.

---

### Phase 2: Backend - Trunk-Agent hybrid

#### 2.1 Trunk-Agent mode

- UAC side: `TrunkAgent` (1 socket, number range)
- UAS side: Standard `ExtensionAgent` pool (registered agents answer)
- Call engine pairs: trunk picks next number, agent pool picks next available UAS
- Requires agents to REGISTER first (existing pre-phase), then trunk sends INVITEs

#### 2.2 Combined mode

- Config specifies weights: `agent_agent_weight: 60`, `trunk_trunk_weight: 30`, `trunk_agent_weight: 10`
- A master scheduler distributes CPS across the three engines based on weights
- Each engine runs independently with its own transport(s)
- Metrics tagged with `scenario` field (already exists on `CallResult`)

---

### Phase 3: GUI - New Tab + Config

#### 3.1 Rename Scenarios tab to "Trunk-Trunk Traffic"

- File: `gui/app/scenarios/page.tsx` - repurpose as Trunk-Trunk config/launch page
- New fields:
  - From number range (start/end)
  - To number range (start/end)
  - CPS
  - Hold time
  - Max concurrent calls
  - SBC host/port (inherited from main config)
  - Media settings (inherited)

#### 3.2 Config page extension

- File: `gui/app/config/` - add traffic_type selector (Agent-Agent / Trunk-Trunk / Trunk-Agent / Combined)
- When Trunk mode selected, show trunk-specific fields instead of agent registration fields

#### 3.3 Run page

- The existing run dashboard (`gui/app/run/page.tsx`) works unchanged since metrics are the same shape
- Pre-phase panel hides Register/Subscribe progress for Trunk-Trunk mode (no registration needed)

---

## Key Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `go/internal/engine/trunk_agent.go` | CREATE | Shared-transport trunk with multi-dialog dispatch |
| `go/internal/engine/trunk_call_engine.go` | CREATE | CPS-paced call generator for trunk mode |
| `go/internal/config/config.go` | MODIFY | Add `TrafficType`, `TrunkConfig` fields |
| `go/cmd/traffic-engine/main.go` | MODIFY | Route to trunk engine based on config |
| `gui/app/scenarios/page.tsx` | MODIFY | Rename to Trunk-Trunk Traffic tab |
| `gui/types/index.ts` | MODIFY | Add trunk config types |
| `gui/app/config/` | MODIFY | Add traffic type selector + trunk fields |

---

## Suggestions for Improvement

1. **Connection pooling for high CPS**: For very high CPS trunk traffic (100+ CPS), a single TCP connection may bottleneck. Add an option for N connections per trunk (e.g., 2-4) with round-robin send. This is a simple extension of TrunkAgent holding `[]Transport`.

2. **Call-ID format configuration**: Different SBCs expect different Call-ID formats. Make it configurable (e.g., `{uuid}@{local-ip}` vs `{prefix}-{seq}@{domain}`).

3. **Trunk authentication**: Some SBCs require IP-based auth or digest auth on the trunk. Add optional trunk-level auth config (IP allowlist or single credential).

4. **Capacity testing mode**: For trunk mode, add a "ramp to failure" mode that increases CPS until the SBC rejects calls (503/486), useful for finding SBC capacity limits.

5. **Per-trunk metrics split**: In combined mode, show separate panels for each traffic type in the GUI (agent-agent calls vs trunk calls) so the operator can see which mode is failing.

6. **Codec negotiation**: Trunk calls may need specific codec offers (G.711, G.729, Opus). Make the SDP codec list configurable per trunk.

---

## Effort Estimate

| Phase | Effort | Dependencies |
|-------|--------|--------------|
| Phase 1 (Trunk-Trunk backend) | 3-4 days | None |
| Phase 2 (Trunk-Agent + Combined) | 2-3 days | Phase 1 |
| Phase 3 (GUI) | 2-3 days | Phase 1 |
| Testing + integration | 2 days | All phases |
| **Total** | **9-12 days** | |

Phase 1 can be tested independently with CLI mode before the GUI is ready.

---

## Technical Notes

### Why this works without rewriting the SIP engine

1. **Transport layer** (`go/internal/sip/transport.go`): TCP/TLS already handles Content-Length framing for multiple interleaved messages. No changes needed.

2. **Message parsing** (`go/internal/sip/message.go`, `util.go`): `ClassifyMessage()`, `ParseSDPMediaInfo()`, header extraction all work on individual messages regardless of transport multiplexing. No changes needed.

3. **RTP** (`go/internal/rtp/endpoint.go`): Each `NewRtpEndpointFull()` gets an OS-assigned ephemeral UDP port. Works per-call regardless of how many calls share a SIP socket. No changes needed.

4. **Metrics** (`go/internal/metrics/metrics.go`): `RecordCall()` accepts `CallResultData` — it doesn't care whether the call came from an agent or a trunk. No changes needed.

5. **Only new code**: `TrunkAgent` (dialog management without registration) and `TrunkCallEngine` (call scheduling without pool pairing).
