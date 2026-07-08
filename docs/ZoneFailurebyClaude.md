# Zone Failover Implementation — Per-Agent Autonomous Recovery

## Design

### Per-Agent Recovery State Machine

```
NORMAL (subscribed on primary, registered on both, in traffic pool)
   │
   ▼ [primary transport down / TCP reset]
FAILOVER_PENDING (removed from pool, not taking new calls)
   │
   ├──→ Path A: retry SUBSCRIBE to secondary (with backoff)
   │      └─ success → ACTIVE_ON_SECONDARY (re-add to pool, calls via secondary)
   │
   ├──→ Path B: retry TCP connect + REGISTER to primary (with backoff)
   │      └─ success → re-SUBSCRIBE primary → NORMAL (re-add to pool, cancel Path A)
   │
   └──→ Race: whichever path succeeds first wins
         │
         └─ If Path A wins → agent is ACTIVE_ON_SECONDARY
              │    └─ Path B continues in background
              │         └─ When primary re-registers successfully:
              │              ├─ If agent idle → move sub to primary → NORMAL
              │              └─ If agent in active call → wait for BYE/200 → move sub → NORMAL
```

### Reporting Display

```
Controller-1 (Primary, Zone-A):
  1000(P) subscribed | 400 pending-move-out ↗ | 50 move-failed ↻

Controller-2 (Secondary, Zone-B):
  1000(P) + 350(S) subscribed | 50 move-in retrying ↻
```

Where:
- (P) = agents whose primary/home controller is this one
- (S) = agents on secondary (failover guests)
- pending-move-out = agents whose primary transport died, subscription move not yet complete
- move-failed = agents retrying subscription move

### Configuration

```yaml
failover_agent_mode: independent    # "independent" (per-agent) or "batched" (rate-limited)
failover_batch_size: 10             # concurrent moves when batched (default 10)
failover_retry_interval_ms: 2000    # retry backoff for subscribe/register attempts
failover_max_retries: 0             # 0 = unlimited retries until success or primary recovers
```

## Implementation Plan

### Phase A: Pool Engine — Per-Agent Remove/Add (pool_engine.go)

Add two new operations to the pool's command channel:

1. `RemoveFromIdle(ext string)` — removes an agent from uacIdle or uasIdle by extension
2. `AddToIdle(agent *ExtensionAgent)` — adds an agent back to idle (auto-assigns UAC/UAS role)
3. `IsNonIdle(ext string) bool` — checks if an agent is currently in an active call

These enable per-agent pool manipulation without the global `ReplaceIdle`.

### Phase B: Agent Recovery Goroutine (agent_group.go)

New method on `AgentGroup`:

```go
func (g *AgentGroup) StartAgentRecovery(
    ctx context.Context,
    ext string,
    primaryAgent *ExtensionAgent,
    secondaryAgent *ExtensionAgent,
    cfg *VMConfig,
    pool PoolController,       // interface: RemoveFromIdle, AddToIdle, IsNonIdle
    onStatusChange func(),     // callback to update metrics
)
```

This spawns a goroutine per agent that:
1. Removes agent from pool
2. Races Path A (subscribe secondary) vs Path B (reconnect + register primary)
3. Adds agent back to pool on success
4. If on secondary and primary recovers → waits for idle → moves home

### Phase C: Replace Bulk MoveSubscriptions with Per-Agent Recovery

Instead of calling `MoveSubscriptions(1000 agents)` on transport-down:
1. Transport-down handler iterates affected agents
2. For each agent, calls `StartAgentRecovery`
3. Each agent independently converges to the best available controller
4. Rate-limiting (batched mode): semaphore limits concurrent recovery goroutines

### Phase D: Metrics Per-Agent State Tracking

New per-group counters:

```go
type AgentGroupStatus struct {
    // ... existing fields ...
    PendingMoveOut    int    `json:"pending_move_out"`    // agents removed from pool, move not complete
    MoveRetrying      int    `json:"move_retrying"`       // agents retrying subscribe on secondary
    ActiveOnSecondary int    `json:"active_on_secondary"` // agents successfully failed over
    FailbackPending   int    `json:"failback_pending"`    // agents waiting for call to end before moving home
}
```

### Phase E: Fixes for Other Open Issues

1. **Issue #1 (duplicate agents)**: Skip `createAgents(cfg)` when `multiZoneMode`
2. **Issue #2 (sequential connect)**: Use goroutine pool with configurable concurrency for multi-zone connects
3. **Issue #8 (generic failure details)**: Include group_id and controller host in failure error messages
4. **Issue #9 (GUI validation)**: Add Zod schema rules for `ha_mode` + `zone_config`

## Key Files

| File | Changes |
|------|---------|
| `go/internal/engine/pool_engine.go` | Add RemoveFromIdle, AddToIdle, IsNonIdle |
| `go/internal/engine/agent_group.go` | Replace bulk move with per-agent recovery state machine |
| `go/internal/engine/agent_recovery.go` | NEW — per-agent recovery goroutine |
| `go/cmd/traffic-engine/main.go` | Wire per-agent recovery, fix duplicate agents, concurrent connect |
| `go/internal/metrics/metrics.go` | Add pending/retrying/failback counters to AgentGroupStatus |
| `gui/types/index.ts` | Add new status fields |
| `gui/components/launch/PrePhasePanel.tsx` | Show per-agent recovery status |
| `gui/lib/config-schema.ts` | Add multi-zone validation rules |

## Risk Mitigation

- **Goroutine explosion**: With 4000 agents failing over, 4000 recovery goroutines spawn. Mitigated by:
  - Configurable semaphore (`failover_batch_size`)
  - Default independent mode still uses a bounded goroutine pool internally
  - Context cancellation on cleanup

- **Thundering herd on secondary**: Rate-limit SUBSCRIBE attempts with per-group semaphore

- **Oscillation**: If primary keeps flapping (up/down/up/down), agents bounce between controllers. Mitigated by:
  - Require primary to be stable for `failback_delay_seconds` before moving home
  - Existing `FailbackDelaySeconds` config already handles this
