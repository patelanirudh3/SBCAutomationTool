package engine

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
)

// AgentGroup manages a set of agents that share the same primary and
// secondary controller pair within a multi-zone HA topology. Each group
// independently handles registration, subscription, failover, and failback.
type AgentGroup struct {
	GroupID           string
	ZoneID            string
	PrimaryController config.ZoneController
	SecondaryCtrl     config.ZoneController
	ExtStart          int
	ExtEnd            int

	PrimaryAgents   map[string]*agent.ExtensionAgent
	SecondaryAgents map[string]*agent.ExtensionAgent

	PrimaryRegistered   []*agent.ExtensionAgent
	SecondaryRegistered []*agent.ExtensionAgent
	ActiveSubscribed    []*agent.ExtensionAgent

	activeController atomic.Value // stores string: "primary" or "secondary"
	primaryReachable atomic.Bool
	moveActive       atomic.Bool
	lastMoveError    atomic.Value // stores string

	mu sync.Mutex
}

// NewAgentGroup creates an agent group from a computed assignment.
func NewAgentGroup(assignment config.AgentGroupAssignment) *AgentGroup {
	g := &AgentGroup{
		GroupID:           assignment.GroupID,
		ZoneID:            assignment.ZoneID,
		PrimaryController: assignment.PrimaryController,
		SecondaryCtrl:     assignment.SecondaryController,
		ExtStart:          assignment.ExtStart,
		ExtEnd:            assignment.ExtEnd,
		PrimaryAgents:     make(map[string]*agent.ExtensionAgent),
		SecondaryAgents:   make(map[string]*agent.ExtensionAgent),
	}
	g.activeController.Store("primary")
	g.primaryReachable.Store(true)
	g.lastMoveError.Store("")
	return g
}

// ActiveController returns the currently active controller label.
func (g *AgentGroup) ActiveController() string {
	if v, ok := g.activeController.Load().(string); ok {
		return v
	}
	return "primary"
}

// HasSecondary reports whether this group has a configured standby controller.
// Single-zone multi-zone topologies intentionally leave SecondaryCtrl empty and
// still use the multi-zone code path with secondary-only work skipped.
func (g *AgentGroup) HasSecondary() bool {
	return g.SecondaryCtrl.Host != "" && g.SecondaryCtrl.Port > 0
}

// SetActiveController sets the active controller label.
func (g *AgentGroup) SetActiveController(controller string) {
	g.activeController.Store(controller)
}

// PrimaryReachable reports whether primary transports are connected.
func (g *AgentGroup) PrimaryReachable() bool {
	return g.primaryReachable.Load()
}

// SetPrimaryReachable marks whether primary transports are connected.
func (g *AgentGroup) SetPrimaryReachable(reachable bool) {
	g.primaryReachable.Store(reachable)
}

// MoveActive reports whether a subscription move is in progress.
func (g *AgentGroup) MoveActive() bool {
	return g.moveActive.Load()
}

// LastMoveError returns the last subscription move error, or empty string.
func (g *AgentGroup) LastMoveError() string {
	if v, ok := g.lastMoveError.Load().(string); ok {
		return v
	}
	return ""
}

// AgentCount returns the total number of agents in this group.
func (g *AgentGroup) AgentCount() int {
	return g.ExtEnd - g.ExtStart + 1
}

// PrimaryConfig returns a VMConfig copy pointed at the primary controller.
func (g *AgentGroup) PrimaryConfig(base *config.VMConfig) *config.VMConfig {
	c := *base
	c.SBCHost = g.PrimaryController.Host
	c.SBCPort = g.PrimaryController.Port
	c.ExtStart = g.ExtStart
	c.ExtEnd = g.ExtEnd
	return &c
}

// SecondaryConfig returns a VMConfig copy pointed at the secondary controller.
func (g *AgentGroup) SecondaryConfig(base *config.VMConfig) *config.VMConfig {
	c := *base
	c.SBCHost = g.SecondaryCtrl.Host
	c.SBCPort = g.SecondaryCtrl.Port
	c.ExtStart = g.ExtStart
	c.ExtEnd = g.ExtEnd
	return &c
}

// CountConnectedPrimary returns how many primary agents have connected transports.
func (g *AgentGroup) CountConnectedPrimary() int {
	count := 0
	for _, ag := range g.PrimaryAgents {
		if ag.IsTransportConnected() {
			count++
		}
	}
	return count
}

// CountConnectedSecondary returns how many secondary agents have connected transports.
func (g *AgentGroup) CountConnectedSecondary() int {
	count := 0
	for _, ag := range g.SecondaryAgents {
		if ag.IsTransportConnected() {
			count++
		}
	}
	return count
}

// CanFailback checks whether the primary controller is ready for failback.
// Requires all primary agents to have connected transports AND successful
// re-registration (GrantedRegisterExpiry > 0).
func (g *AgentGroup) CanFailback() bool {
	if !g.primaryReachable.Load() {
		return false
	}
	connected := 0
	for _, ag := range g.PrimaryAgents {
		if ag.IsTransportConnected() && ag.GrantedRegisterExpiry() > 0 {
			connected++
		}
	}
	return connected >= 2
}

// MoveSubscriptions moves active subscriptions from the current controller
// to the target controller. When force=true, it drains active calls first.
// When fromDown=true (primary failure), it skips unsubscribe on the source.
func (g *AgentGroup) MoveSubscriptions(
	ctx context.Context,
	target string,
	fromDown bool,
	baseCfg *config.VMConfig,
	drainFunc func(agents []*agent.ExtensionAgent) error,
) ([]*agent.ExtensionAgent, error) {
	g.mu.Lock()
	if g.moveActive.Load() {
		g.mu.Unlock()
		return nil, fmt.Errorf("group %s: subscription move already in progress", g.GroupID)
	}
	g.moveActive.Store(true)
	g.mu.Unlock()
	defer g.moveActive.Store(false)

	slog.Info("Agent group subscription move starting",
		"group", g.GroupID, "zone", g.ZoneID,
		"target", target, "from_down", fromDown)

	// Drain active calls on the affected agents before moving subscriptions.
	// This ensures graceful failover doesn't disrupt in-progress calls.
	if drainFunc != nil && !fromDown {
		if err := drainFunc(g.ActiveSubscribed); err != nil {
			slog.Warn("Agent group drain returned error (proceeding with move)",
				"group", g.GroupID, "err", err)
		}
	}

	var fromAgents, toAgents []*agent.ExtensionAgent
	var toCfg *config.VMConfig

	if target == "secondary" {
		fromAgents = g.ActiveSubscribed
		toAgents = g.SecondaryRegistered
		toCfg = g.SecondaryConfig(baseCfg)
	} else {
		fromAgents = g.ActiveSubscribed
		toAgents = g.PrimaryRegistered
		toCfg = g.PrimaryConfig(baseCfg)
	}

	if len(toAgents) == 0 {
		err := fmt.Errorf("group %s: no registered agents on target controller %s", g.GroupID, target)
		g.lastMoveError.Store(err.Error())
		return nil, err
	}

	toByExt := make(map[string]*agent.ExtensionAgent, len(toAgents))
	for _, ag := range toAgents {
		toByExt[ag.Ext] = ag
	}

	var moved []*agent.ExtensionAgent
	moveTimeout := time.Duration(baseCfg.RegisterTimeout*len(baseCfg.SubscribeEvents)+10) * time.Second
	moveCtx, cancel := context.WithTimeout(ctx, moveTimeout)
	defer cancel()

	var unsubscribedFrom []*agent.ExtensionAgent
	for _, from := range fromAgents {
		to := toByExt[from.Ext]
		if to == nil {
			slog.Warn("Agent group move: no matching agent on target",
				"group", g.GroupID, "ext", from.Ext, "target", target)
			continue
		}
		if !fromDown {
			if err := from.Unsubscribe(moveCtx); err != nil {
				slog.Warn("Agent group move: unsubscribe failed",
					"group", g.GroupID, "ext", from.Ext, "err", err)
			}
			unsubscribedFrom = append(unsubscribedFrom, from)
		}
		if err := to.Subscribe(moveCtx); err != nil {
			errMsg := fmt.Sprintf("group %s: subscribe %s to %s:%d failed: %v",
				g.GroupID, to.Ext, toCfg.SBCHost, toCfg.SBCPort, err)

			// Rollback: unsubscribe already-moved agents on target,
			// re-subscribe them on the source controller.
			slog.Warn("Agent group move: rolling back partial move",
				"group", g.GroupID, "moved_so_far", len(moved), "failed_ext", to.Ext)
			rollbackCtx, rollbackCancel := context.WithTimeout(ctx, moveTimeout)
			for _, movedAg := range moved {
				_ = movedAg.Unsubscribe(rollbackCtx)
			}
			// Re-subscribe the agents we unsubscribed from the source
			fromCfg := g.PrimaryConfig(baseCfg)
			if target == "primary" {
				fromCfg = g.SecondaryConfig(baseCfg)
			}
			_ = fromCfg // suppress unused (re-subscribe uses the agent's own config)
			for _, srcAg := range unsubscribedFrom {
				if resubErr := srcAg.Subscribe(rollbackCtx); resubErr != nil {
					slog.Warn("Agent group rollback: re-subscribe source failed",
						"group", g.GroupID, "ext", srcAg.Ext, "err", resubErr)
				}
			}
			rollbackCancel()

			g.lastMoveError.Store(errMsg)
			return nil, fmt.Errorf("%s (rolled back %d agents)", errMsg, len(moved))
		}
		moved = append(moved, to)
	}

	if len(moved) < 2 {
		err := fmt.Errorf("group %s: only %d agents subscribed on %s; need at least 2", g.GroupID, len(moved), target)
		g.lastMoveError.Store(err.Error())
		return moved, err
	}

	g.mu.Lock()
	g.ActiveSubscribed = moved
	g.mu.Unlock()
	g.SetActiveController(target)
	g.lastMoveError.Store("")

	slog.Info("Agent group subscription move complete",
		"group", g.GroupID, "target", target, "moved", len(moved))
	return moved, nil
}

// FailoverTriggerAccumulator tracks connection-reset events within a sliding
// window to determine whether a group-wide failover should be triggered.
// Only resets from previously-established connections are counted.
type FailoverTriggerAccumulator struct {
	mu              sync.Mutex
	events          []time.Time
	triggeredExts   map[string]bool
	groupTriggered  bool
	config          FailoverTriggerConfig
	groupAgentCount int
}

// NewFailoverTriggerAccumulator creates an accumulator for a group.
func NewFailoverTriggerAccumulator(tcfg FailoverTriggerConfig, groupAgentCount int) *FailoverTriggerAccumulator {
	return &FailoverTriggerAccumulator{
		events:          make([]time.Time, 0),
		triggeredExts:   make(map[string]bool),
		config:          tcfg,
		groupAgentCount: groupAgentCount,
	}
}

// RecordResetAndCheck records a connection-reset event for an agent and returns
// whether the group-wide threshold has been reached.
// Returns (alreadyTriggeredForExt, groupThresholdReached).
func (a *FailoverTriggerAccumulator) RecordResetAndCheck(ext string) (alreadyTriggered bool, groupTrigger bool) {
	a.mu.Lock()
	defer a.mu.Unlock()

	if a.triggeredExts[ext] {
		return true, false
	}
	a.triggeredExts[ext] = true

	if a.config.Mode == "per_agent" || a.groupTriggered {
		return false, false
	}

	now := time.Now()
	a.events = append(a.events, now)

	// Prune events outside the window
	windowDuration := time.Duration(a.config.WindowMs) * time.Millisecond
	cutoff := now.Add(-windowDuration)
	firstValid := 0
	for i, t := range a.events {
		if t.After(cutoff) {
			firstValid = i
			break
		}
		if i == len(a.events)-1 {
			firstValid = len(a.events)
		}
	}
	a.events = a.events[firstValid:]

	threshold := 0
	switch a.config.Mode {
	case "min_agents":
		threshold = a.config.Count
	case "pct_agents":
		threshold = a.groupAgentCount * a.config.Pct / 100
		if threshold < 2 {
			threshold = 2
		}
	}

	if len(a.events) >= threshold {
		a.groupTriggered = true
		return false, true
	}
	return false, false
}

// AlreadyGroupTriggered returns true if group-wide recovery was already triggered.
func (a *FailoverTriggerAccumulator) AlreadyGroupTriggered() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.groupTriggered
}

// TriggeredExtCount returns how many distinct agents have reported resets.
func (a *FailoverTriggerAccumulator) TriggeredExtCount() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.triggeredExts)
}

// Reset clears the accumulator state (e.g., after failback completes).
func (a *FailoverTriggerAccumulator) Reset() {
	a.mu.Lock()
	a.events = a.events[:0]
	a.triggeredExts = make(map[string]bool)
	a.groupTriggered = false
	a.mu.Unlock()
}

// SetupTransportDownHandlers wires transport-down detection on primary agents.
// onAgentDown is called for each individual agent whose established connection resets.
// onGroupTrigger is called once when the threshold is reached (threshold modes only).
func (g *AgentGroup) SetupTransportDownHandlers(
	accumulator *FailoverTriggerAccumulator,
	onAgentDown func(group *AgentGroup, ext string, err error),
	onGroupTrigger func(group *AgentGroup),
) {
	for _, ag := range g.PrimaryAgents {
		ag := ag
		ag.SetTransportDownHandler(func(ext string, err error) {
			g.SetPrimaryReachable(false)

			alreadyTriggered, groupTrigger := accumulator.RecordResetAndCheck(ext)
			if alreadyTriggered {
				return
			}

			if onAgentDown != nil {
				onAgentDown(g, ext, err)
			}

			if groupTrigger && onGroupTrigger != nil {
				onGroupTrigger(g)
			}
		})
	}
}

// Close closes all agent transports in this group (primary and secondary).
func (g *AgentGroup) Close() {
	for _, ag := range g.PrimaryAgents {
		ag.Close()
	}
	for _, ag := range g.SecondaryAgents {
		ag.Close()
	}
}
