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

// AgentRecoveryState tracks the failover state of a single agent.
type AgentRecoveryState string

const (
	RecoveryNormal          AgentRecoveryState = "normal"
	RecoveryPending         AgentRecoveryState = "pending"
	RecoveryActiveSecondary AgentRecoveryState = "active_secondary"
	RecoveryFailbackWaiting AgentRecoveryState = "failback_waiting"
)

// PoolController is the interface for pool operations needed by agent recovery.
type PoolController interface {
	RemoveFromIdle(ext string) bool
	AddToIdle(a *agent.ExtensionAgent)
	IsNonIdle(ext string) bool
}

// AgentReadyFunc is called when a recovered agent should rejoin the traffic
// pool. It must handle role assignment and UAS auto-answer listener setup
// (mirroring the onIdle callback used during normal reg/sub).
type AgentReadyFunc func(ag *agent.ExtensionAgent)

// RecoveryConfig holds per-agent recovery parameters.
type RecoveryConfig struct {
	RetryIntervalMs  int
	MaxRetries       int // 0 = unlimited
	FailbackDelaySec int
	BatchSize        int // concurrent recovery goroutines (0 = unlimited)
}

// FailoverTriggerConfig controls when a group-wide failover is triggered
// vs individual agent recovery.
type FailoverTriggerConfig struct {
	Mode     string // "per_agent", "min_agents", "pct_agents"
	Count    int    // threshold count for min_agents mode
	Pct      int    // threshold percentage for pct_agents mode
	WindowMs int    // sliding window in ms for threshold modes
}

// DefaultRecoveryConfig returns sensible defaults.
func DefaultRecoveryConfig() RecoveryConfig {
	return RecoveryConfig{
		RetryIntervalMs:  2000,
		MaxRetries:       0,
		FailbackDelaySec: 30,
		BatchSize:        0,
	}
}

// DefaultFailoverTriggerConfig returns sensible defaults.
func DefaultFailoverTriggerConfig() FailoverTriggerConfig {
	return FailoverTriggerConfig{
		Mode:     "per_agent",
		Count:    5,
		Pct:      20,
		WindowMs: 1000,
	}
}

// RecoveryFromConfig derives RecoveryConfig from the VMConfig failover settings.
func RecoveryFromConfig(cfg *config.VMConfig) RecoveryConfig {
	rc := DefaultRecoveryConfig()
	if cfg.FailbackDelaySeconds > 0 {
		rc.FailbackDelaySec = cfg.FailbackDelaySeconds
	}
	return rc
}

// TriggerFromConfig derives FailoverTriggerConfig from VMConfig.
func TriggerFromConfig(cfg *config.VMConfig) FailoverTriggerConfig {
	tc := DefaultFailoverTriggerConfig()
	if cfg.FailoverTrigger != "" {
		tc.Mode = cfg.FailoverTrigger
	}
	if cfg.FailoverTriggerCount > 0 {
		tc.Count = cfg.FailoverTriggerCount
	}
	if cfg.FailoverTriggerPct > 0 {
		tc.Pct = cfg.FailoverTriggerPct
	}
	if cfg.FailoverTriggerWindowMs > 0 {
		tc.WindowMs = cfg.FailoverTriggerWindowMs
	}
	return tc
}

// AgentRecoveryTracker manages per-agent failover recovery for a group.
// It tracks how many agents are in each state and provides callbacks for
// metrics reporting.
type AgentRecoveryTracker struct {
	mu             sync.Mutex
	states         map[string]AgentRecoveryState // ext -> state
	cancelFuncs    map[string]context.CancelFunc // ext -> cancel recovery goroutine
	pendingCount   atomic.Int32
	retryingCount  atomic.Int32
	activeSecCount atomic.Int32
	failbackCount  atomic.Int32

	onStateChange func() // called after any state transition
}

// NewAgentRecoveryTracker creates a tracker for the given extensions.
func NewAgentRecoveryTracker(exts []string, onStateChange func()) *AgentRecoveryTracker {
	states := make(map[string]AgentRecoveryState, len(exts))
	for _, ext := range exts {
		states[ext] = RecoveryNormal
	}
	return &AgentRecoveryTracker{
		states:        states,
		cancelFuncs:   make(map[string]context.CancelFunc),
		onStateChange: onStateChange,
	}
}

// setState transitions an agent and updates counters.
func (t *AgentRecoveryTracker) setState(ext string, newState AgentRecoveryState) {
	t.mu.Lock()
	old := t.states[ext]
	t.states[ext] = newState
	t.mu.Unlock()

	// Update atomic counters
	switch old {
	case RecoveryPending:
		t.pendingCount.Add(-1)
	case RecoveryActiveSecondary:
		t.activeSecCount.Add(-1)
	case RecoveryFailbackWaiting:
		t.failbackCount.Add(-1)
	}
	switch newState {
	case RecoveryPending:
		t.pendingCount.Add(1)
	case RecoveryActiveSecondary:
		t.activeSecCount.Add(1)
	case RecoveryFailbackWaiting:
		t.failbackCount.Add(1)
	}

	if t.onStateChange != nil {
		t.onStateChange()
	}
}

// PendingCount returns agents waiting for failover (removed from pool, move not complete).
func (t *AgentRecoveryTracker) PendingCount() int { return int(t.pendingCount.Load()) }

// RetryingCount returns agents actively retrying subscription moves.
func (t *AgentRecoveryTracker) RetryingCount() int { return int(t.retryingCount.Load()) }

// ActiveOnSecondaryCount returns agents successfully failed over to secondary.
func (t *AgentRecoveryTracker) ActiveOnSecondaryCount() int { return int(t.activeSecCount.Load()) }

// FailbackPendingCount returns agents waiting for call completion before moving home.
func (t *AgentRecoveryTracker) FailbackPendingCount() int { return int(t.failbackCount.Load()) }

// CancelAll cancels all active recovery goroutines.
func (t *AgentRecoveryTracker) CancelAll() {
	t.mu.Lock()
	for ext, cancel := range t.cancelFuncs {
		cancel()
		delete(t.cancelFuncs, ext)
	}
	t.mu.Unlock()
}

// SetOnStateChange updates the state-change callback.
func (t *AgentRecoveryTracker) SetOnStateChange(fn func()) {
	t.mu.Lock()
	t.onStateChange = fn
	t.mu.Unlock()
}

// StartAgentRecovery launches a recovery goroutine for a single agent.
// It implements the race-to-recovery model:
//   - Path A: retry SUBSCRIBE to secondary
//   - Path B: retry TCP connect + REGISTER to primary
//   - Whichever succeeds first wins
//   - If on secondary and primary recovers → wait for idle → move home
func StartAgentRecovery(
	ctx context.Context,
	tracker *AgentRecoveryTracker,
	ext string,
	primaryAgent *agent.ExtensionAgent,
	secondaryAgent *agent.ExtensionAgent,
	primaryCfg *config.VMConfig,
	secondaryCfg *config.VMConfig,
	pool PoolController,
	onReady AgentReadyFunc,
	rcfg RecoveryConfig,
	sem chan struct{},
) {
	// Acquire semaphore if rate-limiting is configured
	if sem != nil {
		select {
		case sem <- struct{}{}:
			defer func() { <-sem }()
		case <-ctx.Done():
			return
		}
	}

	recoveryCtx, cancel := context.WithCancel(ctx)
	tracker.mu.Lock()
	tracker.cancelFuncs[ext] = cancel
	tracker.mu.Unlock()
	defer func() {
		cancel()
		tracker.mu.Lock()
		delete(tracker.cancelFuncs, ext)
		tracker.mu.Unlock()
	}()

	// Step 1: Remove agent from pool
	pool.RemoveFromIdle(ext)
	tracker.setState(ext, RecoveryPending)

	slog.Info("Agent recovery starting", "ext", ext)

	retryInterval := time.Duration(rcfg.RetryIntervalMs) * time.Millisecond
	if retryInterval < 500*time.Millisecond {
		retryInterval = 500 * time.Millisecond
	}

	// Step 2: Race — Path A (subscribe secondary) vs Path B (reconnect primary)
	type result struct {
		path string // "secondary" or "primary"
	}
	winCh := make(chan result, 1)

	// Path A: Subscribe to secondary
	go func() {
		tracker.retryingCount.Add(1)
		defer tracker.retryingCount.Add(-1)
		attempts := 0
		for {
			select {
			case <-recoveryCtx.Done():
				return
			default:
			}
			attempts++
			subCtx, subCancel := context.WithTimeout(recoveryCtx, time.Duration(secondaryCfg.RegisterTimeout)*time.Second)
			err := secondaryAgent.Subscribe(subCtx)
			subCancel()
			if err == nil {
				select {
				case winCh <- result{path: "secondary"}:
				default:
				}
				return
			}
			slog.Debug("Agent recovery Path A: subscribe secondary failed",
				"ext", ext, "attempt", attempts, "err", err)
			if rcfg.MaxRetries > 0 && attempts >= rcfg.MaxRetries {
				slog.Warn("Agent recovery Path A: max retries reached", "ext", ext, "attempts", attempts)
				return
			}
			select {
			case <-recoveryCtx.Done():
				return
			case <-time.After(retryInterval):
			}
		}
	}()

	// Path B: Reconnect + Re-register primary
	go func() {
		attempts := 0
		for {
			select {
			case <-recoveryCtx.Done():
				return
			default:
			}
			attempts++
			if !primaryAgent.IsTransportConnected() {
				connCtx, connCancel := context.WithTimeout(recoveryCtx, time.Duration(primaryCfg.ConnectTimeout)*time.Second)
				err := primaryAgent.Start(connCtx)
				connCancel()
				if err != nil {
					slog.Debug("Agent recovery Path B: reconnect primary failed",
						"ext", ext, "attempt", attempts, "err", err)
					select {
					case <-recoveryCtx.Done():
						return
					case <-time.After(retryInterval):
					}
					continue
				}
			}
			regCtx, regCancel := context.WithTimeout(recoveryCtx, time.Duration(primaryCfg.RegisterTimeout)*time.Second)
			err := primaryAgent.Register(regCtx)
			regCancel()
			if err != nil {
				slog.Debug("Agent recovery Path B: register primary failed",
					"ext", ext, "attempt", attempts, "err", err)
				select {
				case <-recoveryCtx.Done():
					return
				case <-time.After(retryInterval):
				}
				continue
			}
			// Primary re-registered successfully
			select {
			case winCh <- result{path: "primary"}:
			default:
			}
			return
		}
	}()

	// Step 3: Wait for winner
	var winner result
	select {
	case winner = <-winCh:
	case <-recoveryCtx.Done():
		slog.Debug("Agent recovery cancelled", "ext", ext)
		return
	}

	if winner.path == "primary" {
		// Primary recovered first — subscribe on primary and rejoin pool
		slog.Info("Agent recovery: primary recovered first, subscribing on primary", "ext", ext)
		subCtx, subCancel := context.WithTimeout(ctx, time.Duration(primaryCfg.RegisterTimeout)*time.Second)
		err := primaryAgent.Subscribe(subCtx)
		subCancel()
		if err != nil {
			slog.Warn("Agent recovery: subscribe primary failed after re-register", "ext", ext, "err", err)
			// Fall through — try adding to pool anyway, next call will determine health
		}
		tracker.setState(ext, RecoveryNormal)
		onReady(primaryAgent)
		slog.Info("Agent recovery complete: back on primary", "ext", ext)
		return
	}

	// Path A won — active on secondary
	slog.Info("Agent recovery: subscribed on secondary", "ext", ext)
	tracker.setState(ext, RecoveryActiveSecondary)
	onReady(secondaryAgent)

	// Step 4: Continue trying to recover primary in background for failback
	failbackDelay := time.Duration(rcfg.FailbackDelaySec) * time.Second
	var primaryReRegisteredAt time.Time

	for {
		select {
		case <-ctx.Done():
			return
		case <-time.After(retryInterval):
		}

		// Check if primary is back
		if !primaryAgent.IsTransportConnected() {
			connCtx, connCancel := context.WithTimeout(ctx, time.Duration(primaryCfg.ConnectTimeout)*time.Second)
			err := primaryAgent.Start(connCtx)
			connCancel()
			if err != nil {
				continue
			}
		}
		if primaryAgent.GrantedRegisterExpiry() <= 0 {
			regCtx, regCancel := context.WithTimeout(ctx, time.Duration(primaryCfg.RegisterTimeout)*time.Second)
			err := primaryAgent.Register(regCtx)
			regCancel()
			if err != nil {
				continue
			}
			primaryReRegisteredAt = time.Now()
			slog.Info("Agent recovery: primary re-registered, waiting for failback delay",
				"ext", ext, "delay_s", rcfg.FailbackDelaySec)
		}

		// Wait for failback delay
		if primaryReRegisteredAt.IsZero() || time.Since(primaryReRegisteredAt) < failbackDelay {
			continue
		}

		// Primary is stable — move subscription home
		tracker.setState(ext, RecoveryFailbackWaiting)

		// Wait for agent to become idle (not in active call)
		for pool.IsNonIdle(ext) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(1 * time.Second):
			}
		}

		// Remove from pool (it's on secondary), unsubscribe secondary, subscribe primary
		pool.RemoveFromIdle(ext)

		unsubCtx, unsubCancel := context.WithTimeout(ctx, time.Duration(secondaryCfg.RegisterTimeout)*time.Second)
		_ = secondaryAgent.Unsubscribe(unsubCtx)
		unsubCancel()

		subCtx, subCancel := context.WithTimeout(ctx, time.Duration(primaryCfg.RegisterTimeout)*time.Second)
		err := primaryAgent.Subscribe(subCtx)
		subCancel()
		if err != nil {
			slog.Warn("Agent recovery failback: subscribe primary failed, retrying",
				"ext", ext, "err", err)
			onReady(secondaryAgent)
			tracker.setState(ext, RecoveryActiveSecondary)
			continue
		}

		// Success — back on primary
		onReady(primaryAgent)
		tracker.setState(ext, RecoveryNormal)
		slog.Info("Agent recovery failback complete: back on primary", "ext", ext)
		return
	}
}

// GroupRecoveryStatus returns aggregate recovery counts for metrics.
type GroupRecoveryStatus struct {
	PendingMoveOut    int
	MoveRetrying      int
	ActiveOnSecondary int
	FailbackPending   int
}

// Status returns the current aggregate recovery state.
func (t *AgentRecoveryTracker) Status() GroupRecoveryStatus {
	return GroupRecoveryStatus{
		PendingMoveOut:    t.PendingCount(),
		MoveRetrying:      t.RetryingCount(),
		ActiveOnSecondary: t.ActiveOnSecondaryCount(),
		FailbackPending:   t.FailbackPendingCount(),
	}
}

// TriggerSingleAgentRecovery starts recovery for one specific agent in the group.
// Used when failover_trigger=per_agent or for the individual agent that failed
// before a group threshold is reached.
func TriggerSingleAgentRecovery(
	ctx context.Context,
	group *AgentGroup,
	tracker *AgentRecoveryTracker,
	ext string,
	baseCfg *config.VMConfig,
	pool PoolController,
	onReady AgentReadyFunc,
	rcfg RecoveryConfig,
) {
	primaryAg, ok := group.PrimaryAgents[ext]
	if !ok {
		slog.Warn("TriggerSingleAgentRecovery: no primary agent", "ext", ext, "group", group.GroupID)
		return
	}
	secondaryAg, ok := group.SecondaryAgents[ext]
	if !ok {
		slog.Warn("TriggerSingleAgentRecovery: no secondary agent", "ext", ext, "group", group.GroupID)
		return
	}
	primaryCfg := group.PrimaryConfig(baseCfg)
	secondaryCfg := group.SecondaryConfig(baseCfg)
	go StartAgentRecovery(ctx, tracker, ext, primaryAg, secondaryAg, primaryCfg, secondaryCfg, pool, onReady, rcfg, nil)
	slog.Info("Single agent recovery triggered", "ext", ext, "group", group.GroupID)
}

// TriggerGroupRecoveryExcluding starts recovery for all agents in the group
// EXCEPT those already in recovery (tracked by the accumulator).
func TriggerGroupRecoveryExcluding(
	ctx context.Context,
	group *AgentGroup,
	tracker *AgentRecoveryTracker,
	accumulator *FailoverTriggerAccumulator,
	baseCfg *config.VMConfig,
	pool PoolController,
	onReady AgentReadyFunc,
	rcfg RecoveryConfig,
) {
	primaryCfg := group.PrimaryConfig(baseCfg)
	secondaryCfg := group.SecondaryConfig(baseCfg)

	var sem chan struct{}
	if rcfg.BatchSize > 0 {
		sem = make(chan struct{}, rcfg.BatchSize)
	}

	count := 0
	for ext, primaryAg := range group.PrimaryAgents {
		alreadyTriggered, _ := accumulator.RecordResetAndCheck(ext)
		if alreadyTriggered {
			continue
		}
		secondaryAg, ok := group.SecondaryAgents[ext]
		if !ok {
			continue
		}
		capturedExt := ext
		capturedPrimary := primaryAg
		capturedSecondary := secondaryAg
		go StartAgentRecovery(ctx, tracker, capturedExt, capturedPrimary, capturedSecondary, primaryCfg, secondaryCfg, pool, onReady, rcfg, sem)
		count++
	}
	slog.Info("Group recovery triggered for remaining agents",
		"group", group.GroupID,
		"new_agents", count,
		"already_recovering", accumulator.TriggeredExtCount()-count)
}

// TriggerGroupRecovery starts per-agent recovery for all agents in a group
// whose primary transport has gone down. It spawns recovery goroutines
// according to the configured batch size.
func TriggerGroupRecovery(
	ctx context.Context,
	group *AgentGroup,
	tracker *AgentRecoveryTracker,
	baseCfg *config.VMConfig,
	pool PoolController,
	onReady AgentReadyFunc,
	rcfg RecoveryConfig,
) {
	primaryCfg := group.PrimaryConfig(baseCfg)
	secondaryCfg := group.SecondaryConfig(baseCfg)

	var sem chan struct{}
	if rcfg.BatchSize > 0 {
		sem = make(chan struct{}, rcfg.BatchSize)
	}

	for ext, primaryAg := range group.PrimaryAgents {
		secondaryAg, ok := group.SecondaryAgents[ext]
		if !ok {
			slog.Warn("TriggerGroupRecovery: no secondary agent for ext", "ext", ext, "group", group.GroupID)
			continue
		}
		capturedExt := ext
		capturedPrimary := primaryAg
		capturedSecondary := secondaryAg
		go StartAgentRecovery(ctx, tracker, capturedExt, capturedPrimary, capturedSecondary, primaryCfg, secondaryCfg, pool, onReady, rcfg, sem)
	}

	slog.Info("Group recovery triggered",
		"group", group.GroupID,
		"agents", len(group.PrimaryAgents),
		"batch_size", fmt.Sprintf("%d (0=unlimited)", rcfg.BatchSize))
}
