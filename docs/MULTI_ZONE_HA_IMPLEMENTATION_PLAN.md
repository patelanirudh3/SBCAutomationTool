# Multi-Zone Multi-Controller HA Implementation Plan

## 1. Requirement Summary

Extend the current single-primary/single-secondary dual registration to a **multi-zone, multi-controller** architecture:

- **Two zones**: Zone-A and Zone-B
- **One or more controllers (SBCs) per zone**
- **Configurable agent distribution** across zones (e.g., 50-50 or 60-40)
- **Cross-zone HA**: Zone-A agents use Zone-A controller as primary, Zone-B controller as secondary (and vice versa)
- **Multi-controller per zone**: When a zone has N controllers, agents are evenly split across them
- Must preserve the **existing single-controller mode** (no regression)
- Address all 8 identified gaps from the dual registration review

## 2. Current vs Proposed Architecture

### Current: Flat Primary/Secondary

```
Config:
  sbc_host: 10.1.1.1        (primary)
  secondary_host: 10.1.1.2  (secondary)

All 4000 agents:
  ├── REGISTER → primary (10.1.1.1)     ✓
  ├── REGISTER → secondary (10.1.1.2)   ✓
  └── SUBSCRIBE → primary only           ✓
```

### Proposed: Zoned with Cross-HA

```
Config:
  Zone-A controllers: [10.1.1.1, 10.1.1.2]    (2 SBCs)
  Zone-B controllers: [10.2.1.1, 10.2.1.2]    (2 SBCs)
  Distribution: 50-50
  Agents: 6000000–6003999 (4000 total)

Zone-A agents (2000): 6000000–6001999
  ├── Split across Zone-A controllers:
  │   ├── 6000000–6000999 → primary: 10.1.1.1, secondary: 10.2.1.1
  │   └── 6001000–6001999 → primary: 10.1.1.2, secondary: 10.2.1.2
  ├── REGISTER → primary (Zone-A ctrl)   ✓
  ├── REGISTER → secondary (Zone-B ctrl) ✓
  └── SUBSCRIBE → primary only           ✓

Zone-B agents (2000): 6002000–6003999
  ├── Split across Zone-B controllers:
  │   ├── 6002000–6002999 → primary: 10.2.1.1, secondary: 10.1.1.1
  │   └── 6003000–6003999 → primary: 10.2.1.2, secondary: 10.1.1.2
  ├── REGISTER → primary (Zone-B ctrl)   ✓
  ├── REGISTER → secondary (Zone-A ctrl) ✓
  └── SUBSCRIBE → primary only           ✓
```

### Data Model

```
ZoneConfig:
  zones:
    - zone_id: "zone-a"
      controllers:
        - host: "10.1.1.1"
          port: 5061
        - host: "10.1.1.2"
          port: 5061
    - zone_id: "zone-b"
      controllers:
        - host: "10.2.1.1"
          port: 5061
        - host: "10.2.1.2"
          port: 5061
  zone_distribution_pct: 50   # Zone-A gets 50%, Zone-B gets 50%
```

### Internal Mapping (computed at startup)

For each controller, the engine computes an **AgentGroup**:

```
AgentGroup {
  primary_controller:   Controller{host, port}
  secondary_controller: Controller{host, port}   // cross-zone peer
  ext_start:            int
  ext_end:              int
  primary_agents:       []*ExtensionAgent
  secondary_agents:     []*ExtensionAgent
  active_controller:    "primary" | "secondary"
}
```

With 2 zones x 2 controllers each = 4 AgentGroups. Each group manages its own failover independently.

## 3. Design Decisions

### Q: New tab or extend existing config?

**Recommendation: Extend the existing SERVER tab with a mode selector, not a new tab.**

Rationale:
- The operator workflow (Config → Launch → Traffic → Report → Cleanup) stays the same regardless of HA mode
- Adding a tab creates navigation confusion ("which tab do I configure HA in?")
- The current dual-registration UI already occupies the SERVER tab; multi-zone is a natural extension

**Proposed mode selector on SERVER tab:**

```
HA Mode: [Single Controller] [Dual Controller] [Multi-Zone HA]
```

- **Single Controller**: Current simple mode — just `sbc_host:sbc_port`
- **Dual Controller**: Current dual registration — primary + secondary (flat)
- **Multi-Zone HA**: New — zone configuration with controller lists

When "Multi-Zone HA" is selected, the flat primary/secondary fields collapse and a zone configuration card expands.

### Q: How to map multi-controller per zone to secondary?

**Round-robin cross-zone pairing**: Controller[i] in Zone-A is paired with Controller[i % len(Zone-B)] in Zone-B as its secondary. This ensures even distribution and deterministic failover targets.

Example with 2 Zone-A controllers and 1 Zone-B controller:
- Zone-A ctrl-1 → secondary: Zone-B ctrl-1
- Zone-A ctrl-2 → secondary: Zone-B ctrl-1 (wraps)
- Zone-B ctrl-1 → secondary: Zone-A ctrl-1

### Q: Should each AgentGroup failover independently?

**Yes.** If Zone-A controller-1 goes down, only its 1000 agents move to the paired Zone-B controller. Zone-A controller-2's agents are unaffected. This provides granular HA without unnecessary disruption.

## 4. Implementation Plan

### Phase 1: Backend Config Model (Est: 2-3 days)

**Files:** `go/internal/config/config.go`, `gui/types/index.ts`

#### New config structures (Go)

```go
type ZoneController struct {
    Host string `yaml:"host" json:"host"`
    Port int    `yaml:"port" json:"port"`
}

type Zone struct {
    ZoneID      string           `yaml:"zone_id" json:"zone_id"`
    Controllers []ZoneController `yaml:"controllers" json:"controllers"`
}

type ZoneConfig struct {
    Zones               []Zone `yaml:"zones" json:"zones"`
    ZoneDistributionPct int    `yaml:"zone_distribution_pct" json:"zone_distribution_pct"`
}
```

Add to `VMConfig`:

```go
    HAMode     string      `yaml:"ha_mode" json:"ha_mode"`   // "single", "dual", "multi_zone"
    ZoneConfig *ZoneConfig `yaml:"zone_config,omitempty" json:"zone_config,omitempty"`
```

#### Backward compatibility

- `ha_mode` defaults to `"single"`
- When `dual_registration_enabled: true` and no `zone_config` → `ha_mode = "dual"` (legacy path)
- When `zone_config` present with 2 zones → `ha_mode = "multi_zone"`
- Existing YAML files continue to work unchanged

#### Validation rules

- `multi_zone` requires exactly 2 zones
- Each zone must have >= 1 controller
- `zone_distribution_pct` must be 1-99 (Zone-A gets N%, Zone-B gets 100-N%)
- Total agents (`ext_end - ext_start + 1`) must be >= 2 * total_controllers (at least 2 agents per controller)
- All controllers must have valid host:port

#### Agent distribution algorithm

```
func computeAgentGroups(cfg *VMConfig) []AgentGroup {
    totalAgents := cfg.ExtEnd - cfg.ExtStart + 1
    zoneACount  := totalAgents * cfg.ZoneConfig.ZoneDistributionPct / 100
    zoneBCount  := totalAgents - zoneACount

    // Split within each zone across its controllers
    zoneAPerCtrl := zoneACount / len(zoneA.Controllers)
    zoneBPerCtrl := zoneBCount / len(zoneB.Controllers)

    // Create AgentGroups with cross-zone secondary pairing
    for i, ctrl := range zoneA.Controllers {
        secondary := zoneB.Controllers[i % len(zoneB.Controllers)]
        groups = append(groups, AgentGroup{
            PrimaryController:   ctrl,
            SecondaryController: secondary,
            ExtStart:            ...,
            ExtEnd:              ...,
        })
    }
    // Mirror for Zone-B
    ...
}
```

### Phase 2: Backend Engine — Multi-Group Lifecycle (Est: 4-5 days)

**Files:** `go/cmd/traffic-engine/main.go`, `go/internal/engine/` (new: `agent_group.go`)

#### New: `AgentGroup` manager

```go
type AgentGroup struct {
    GroupID             string
    PrimaryController   ZoneController
    SecondaryController ZoneController
    ExtStart, ExtEnd    int
    PrimaryAgents       map[string]*agent.ExtensionAgent
    SecondaryAgents     map[string]*agent.ExtensionAgent
    ActiveController    string  // "primary" or "secondary"
    mu                  sync.Mutex
}
```

Each `AgentGroup` independently:
- Connects transports (primary + secondary)
- Registers agents (primary + secondary)
- Subscribes agents (active controller only)
- Handles failover/failback for its agents only
- Reports HA status per group

#### Lifecycle changes in main.go

**Current flow (dual mode):**
```
Create primary agents → connect → create secondary agents → connect
→ register primary → register secondary → subscribe primary → pool
```

**New flow (multi-zone mode):**
```
Compute AgentGroups from ZoneConfig
For each AgentGroup (parallel):
  → create primary agents for ext range
  → create secondary agents for ext range
  → connect primary transports (use new gated pipeline - fixes Gap #1)
  → connect secondary transports
  → register primary
  → register secondary
  → subscribe primary → onIdle → pool
Wire per-group failover handlers
Start traffic (pool contains agents from ALL groups)
```

#### Fixing Gap #1: Use gated pipeline for all HA modes

Replace the staged `connectTransportsBatched` + `RunRegister` + `RunSubscribe` with `RunConnectRegSubPipeline` for each AgentGroup. The gate mechanism already supports this — each group gets its own pipeline instance.

#### Fixing Gap #2: Graceful failover during active calls

```go
func (g *AgentGroup) moveToController(target string, force bool) error {
    if !force {
        // Wait for group's agents to become idle (with timeout)
        // Only block THIS group's agents, not all groups
    } else {
        // Force mode: drain active calls on this group's agents first
        // Send BYE to all active calls, wait short timeout, then move
    }
    ...
}
```

#### Fixing Gap #3: Implement FailoverMode=force

When `failover_mode: force`:
1. Stop launching new calls on the affected group's agents
2. Send BYE to all active calls on those agents (drain with 15s timeout)
3. Move subscriptions
4. Resume traffic on new controller's agents

#### Fixing Gap #4: Stronger failback validation

```go
func (g *AgentGroup) canFailback() bool {
    for _, ag := range g.PrimaryAgents {
        if !ag.IsTransportConnected() {
            return false
        }
        if ag.GrantedRegisterExpiry() <= 0 {
            return false  // not re-registered yet
        }
    }
    return true
}
```

#### Fixing Gap #6: Per-call controller tagging

Add `ActiveController string` to `CallResult`:

```go
type CallResult struct {
    ...
    ActiveController string `json:"active_controller,omitempty"`
    AgentGroupID     string `json:"agent_group_id,omitempty"`
}
```

Populated in `executeCall` from the pool agent's current group. Emitted in `/api/calls` response and available in reports.

### Phase 3: Backend Metrics — Per-Group HA Status (Est: 1-2 days)

**Files:** `go/internal/metrics/metrics.go`

#### Extended HA metrics

```go
type AgentGroupStatus struct {
    GroupID             string `json:"group_id"`
    ZoneID              string `json:"zone_id"`
    PrimaryHost         string `json:"primary_host"`
    SecondaryHost       string `json:"secondary_host"`
    ActiveController    string `json:"active_controller"`
    PrimaryRegistered   int    `json:"primary_registered"`
    SecondaryRegistered int    `json:"secondary_registered"`
    Subscribed          int    `json:"subscribed"`
    AgentCount          int    `json:"agent_count"`
    PrimaryReachable    bool   `json:"primary_reachable"`
    MoveActive          bool   `json:"move_active"`
    LastEvent           string `json:"last_event,omitempty"`
}
```

```go
type TrafficMetrics struct {
    ...
    // Existing flat HA fields kept for backward compat
    HAEnabled           bool   `json:"ha_enabled"`
    HAActiveController  string `json:"ha_active_controller"`
    ...
    // New: per-group breakdown
    HAAgentGroups []AgentGroupStatus `json:"ha_agent_groups,omitempty"`
}
```

### Phase 4: GUI Config — Multi-Zone UI (Est: 3-4 days)

**Files:** `gui/components/config/VMConfigPanel.tsx`, `gui/types/index.ts`, `gui/lib/config-schema.ts`

#### Mode selector

At the top of the "Remote SIP Server" section, add an HA mode selector:

```
┌─────────────────────────────────────────────────────────┐
│  HA Mode:  ● Single Controller  ○ Dual Controller  ○ Multi-Zone  │
└─────────────────────────────────────────────────────────┘
```

#### Single Controller mode (existing, unchanged)

```
┌──────────────────────────────┐
│  SBC Host: ___________       │
│  SBC Port: ___________       │
│  Transport: [TCP ▾]         │
│  ...                         │
└──────────────────────────────┘
```

#### Dual Controller mode (existing, unchanged)

Current two-column primary/secondary layout — no changes.

#### Multi-Zone mode (new)

```
┌──────────────────────────────────────────────────────────────┐
│  Zone Distribution:  Zone-A [50]% ←──slider──→ Zone-B [50]% │
├──────────────────────────┬───────────────────────────────────┤
│  ZONE-A                  │  ZONE-B                           │
│  ┌────────────────────┐  │  ┌────────────────────┐           │
│  │ Controller 1       │  │  │ Controller 1       │           │
│  │ Host: __________   │  │  │ Host: __________   │           │
│  │ Port: __________   │  │  │ Port: __________   │           │
│  └────────────────────┘  │  └────────────────────┘           │
│  ┌────────────────────┐  │  ┌────────────────────┐           │
│  │ Controller 2       │  │  │ Controller 2       │           │
│  │ Host: __________   │  │  │ Host: __________   │           │
│  │ Port: __________   │  │  │ Port: __________   │           │
│  └────────────────────┘  │  └────────────────────┘           │
│  [+ Add Controller]     │  [+ Add Controller]               │
├──────────────────────────┴───────────────────────────────────┤
│  Transport: [TLS ▾]   Domain: __________   Password: ____   │
│  Failover Mode: [Graceful ▾]   Auto Failback: [On] Delay: _ │
└──────────────────────────────────────────────────────────────┘
```

Transport, domain, password, TLS settings, and failover config are shared across all controllers (same as current dual mode).

#### Agent distribution preview

Below the zone config, show a computed preview:

```
┌─ Agent Distribution Preview ─────────────────────────────────┐
│  Total agents: 4000 (6000000–6003999)                        │
│                                                               │
│  Zone-A (2000 agents):                                       │
│    Controller 10.1.1.1:5061  →  1000 agents (6000000–6000999)│
│      Secondary: 10.2.1.1:5061                                │
│    Controller 10.1.1.2:5061  →  1000 agents (6001000–6001999)│
│      Secondary: 10.2.1.2:5061                                │
│                                                               │
│  Zone-B (2000 agents):                                       │
│    Controller 10.2.1.1:5061  →  1000 agents (6002000–6002999)│
│      Secondary: 10.1.1.1:5061                                │
│    Controller 10.2.1.2:5061  →  1000 agents (6003000–6003999)│
│      Secondary: 10.1.1.2:5061                                │
└──────────────────────────────────────────────────────────────┘
```

### Phase 5: GUI Launch Panel — Per-Group HA (Est: 2-3 days)

**Files:** `gui/components/launch/PrePhasePanel.tsx`

#### Replace flat HA card with group-based view

```
┌─ Multi-Zone HA Status ──────────────────────────────────────┐
│                                                              │
│  ┌─ Zone-A: ctrl-1 (10.1.1.1) ─────────────────────────┐   │
│  │ Active: primary  │ Reg: 1000/1000  │ Sub: 1000/1000  │   │
│  │ Secondary: 10.2.1.1 (registered)   [Move →]          │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌─ Zone-A: ctrl-2 (10.1.1.2) ─────────────────────────┐   │
│  │ Active: primary  │ Reg: 1000/1000  │ Sub: 1000/1000  │   │
│  │ Secondary: 10.2.1.2 (registered)   [Move →]          │   │
│  └───────────────────────────────────────────────────────┘   │
│  ┌─ Zone-B: ctrl-1 (10.2.1.1) ─────────────────────────┐   │
│  │ Active: primary  │ Reg: 1000/1000  │ Sub: 1000/1000  │   │
│  │ Secondary: 10.1.1.1 (registered)   [Move →]          │   │
│  └───────────────────────────────────────────────────────┘   │
│  ...                                                         │
│                                                              │
│  HA Timeline [Download JSON]                                 │
└──────────────────────────────────────────────────────────────┘
```

### Phase 6: Run Dashboard — HA Status Strip (Est: 1 day)

**Files:** `gui/app/run/page.tsx`

**Fixes Gap #5: No HA status on run dashboard.**

Add a compact HA strip below the runtime stats during traffic:

```
┌─ HA ──────────────────────────────────────────────────────┐
│ Zone-A/ctrl-1: ● primary  Zone-A/ctrl-2: ● primary      │
│ Zone-B/ctrl-1: ● primary  Zone-B/ctrl-2: ◉ SECONDARY    │
│ [1 failover event]                                        │
└──────────────────────────────────────────────────────────┘
```

Color coding: green dot = primary active, amber dot = on secondary (failover occurred).

### Phase 7: Fix Remaining Gaps (Est: 2 days)

#### Gap #7: CLI mode dual registration

Add `--ha-mode multi_zone` flag and zone config file support. Use the same `AgentGroup` model.

#### Gap #8: Stale TODO comment

Remove the outdated TODO in `config.go` lines 26-30 and replace with accurate description of the implemented HA model.

## 5. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **State explosion**: N groups x 2 controllers x (connect/register/subscribe/failover) states | High | High | AgentGroup encapsulates per-group state machine; each group is self-contained |
| **Pool management complexity**: agents from different groups in the same pool, some failing over independently | High | High | Pool tagging — each agent carries its GroupID; failover replaces only that group's agents in pool |
| **Transport resource limits**: 4+ controllers x 1000+ agents = 4000+ TCP connections | Medium | Medium | This is the same as current agent-agent mode; multi-zone doesn't increase total connections |
| **Partial zone failure**: Zone-A ctrl-1 fails but ctrl-2 is fine; agents migrate mid-traffic | Medium | High | Per-group independence prevents cascade; force mode drains only affected group's calls |
| **Config migration**: existing single/dual configs must keep working | Low | High | `ha_mode` defaults to "single"; `dual_registration_enabled: true` auto-maps to `ha_mode: "dual"` |
| **GUI complexity**: zone config UI could overwhelm operators | Medium | Medium | Agent distribution preview + mode selector keeps simple cases simple |
| **Secondary controller pairing asymmetry**: unequal controllers per zone causes uneven secondary load | Low | Medium | Round-robin pairing + validation warning when zone controller counts differ |
| **Cleanup ordering**: N groups x 2 controllers requires coordinated cleanup | Medium | Medium | Cleanup per-group: unsubscribe active → unregister primary → unregister secondary → close |

## 6. Effort Estimate

| Phase | Description | Effort | Dependencies |
|-------|-------------|--------|-------------|
| Phase 1 | Backend config model (ZoneConfig, validation, agent distribution) | 2-3 days | None |
| Phase 2 | Backend engine (AgentGroup lifecycle, failover, gap fixes #1-4,6) | 4-5 days | Phase 1 |
| Phase 3 | Backend metrics (per-group HA status) | 1-2 days | Phase 2 |
| Phase 4 | GUI config (mode selector, zone UI, distribution preview) | 3-4 days | Phase 1 |
| Phase 5 | GUI launch panel (per-group HA controls) | 2-3 days | Phase 3 |
| Phase 6 | GUI run dashboard (HA status strip — gap #5) | 1 day | Phase 3 |
| Phase 7 | CLI mode + stale comment (gaps #7, #8) | 2 days | Phase 2 |
| Testing | Integration testing: 1-zone, 2-zone x 1-ctrl, 2-zone x 2-ctrl, failover, failback | 3-4 days | All |
| **Total** | | **18-24 days** | |

## 7. Recommendations

1. **Phase the rollout**: Ship Phase 1-3 (backend) first with CLI testing. GUI can follow in a second release.

2. **Keep dual mode as a first-class citizen**: Multi-zone with 1 controller per zone is functionally identical to current dual mode. Validate this equivalence with automated tests.

3. **Add a "Test Failover" button**: In the launch panel, let operators trigger a simulated primary-down for a specific group without actually killing the transport. This exercises the failover path safely during acceptance testing.

4. **Per-group CPS allocation**: Consider allowing different CPS targets per zone (e.g., Zone-A at 10 CPS, Zone-B at 5 CPS) for asymmetric load testing.

5. **Group-aware reporting**: Post-run report should show per-zone and per-controller call statistics (attempted/completed/failed) so operators can compare controller performance.

6. **Health dashboard for controllers**: A dedicated view showing all controller connections (TCP up/down, registration status, subscription status) as a matrix — useful when managing 4+ controllers.
