package engine

import (
	"log/slog"
	"sync"

	"github.com/cci/traffic-engine/internal/agent"
)

// PoolEngine manages the idle/non-idle/reg-only user lists for the single-pool
// traffic model. All methods are safe for concurrent use.
//
// Population rules (set during pre-phase):
//   - Reg OK + Sub OK  → idle_list  (ready for calls)
//   - Reg OK + Sub fail → reg_only_list (registered but no subscription)
//   - Reg fail          → tracked only as failed count, not in any list
//
// Call pairing rules:
//   - NextPair picks the first two agents from idle_list.
//   - The caller's auto-answer is disabled atomically inside the lock.
//   - After BYE/200, ReturnPair appends both back to the END of idle_list
//     so the same users can be reused without re-registering.
type PoolEngine struct {
	mu          sync.Mutex
	idleList    []*agent.ExtensionAgent
	nonIdleList []*agent.ExtensionAgent
	regOnlyList []*agent.ExtensionAgent // registered but subscription failed
}

// NewPoolEngine creates an empty pool engine.
func NewPoolEngine() *PoolEngine {
	return &PoolEngine{}
}

// AddToIdle adds an agent to the idle list (both reg and sub succeeded).
// Called per-agent from pre-phase as each user completes successfully.
// Auto-answer is enabled on the agent before adding to the list.
func (p *PoolEngine) AddToIdle(a *agent.ExtensionAgent) {
	a.SetAutoAnswer(true)
	p.mu.Lock()
	p.idleList = append(p.idleList, a)
	p.mu.Unlock()
}

// AddToRegOnly adds an agent that registered but failed to subscribe.
func (p *PoolEngine) AddToRegOnly(a *agent.ExtensionAgent) {
	p.mu.Lock()
	p.regOnlyList = append(p.regOnlyList, a)
	p.mu.Unlock()
}

// NextPair picks the first two agents from the idle list as (caller, callee).
//
// The caller's auto-answer flag is set to false atomically inside the lock
// to prevent a race where an incoming INVITE is answered while the agent
// is about to act as a caller.
//
// Returns:
//   - (caller, callee, ok=true, stalled=false)  — pair ready
//   - (nil, nil, ok=false, stalled=false)        — fewer than 2 idle; back-pressure
//   - (nil, nil, ok=false, stalled=true)         — permanently stuck (1 idle, 0 non-idle)
func (p *PoolEngine) NextPair() (caller, callee *agent.ExtensionAgent, ok bool, stalled bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.idleList) < 2 {
		// Permanently stuck: only one user exists and no calls are running
		if len(p.idleList) == 1 && len(p.nonIdleList) == 0 {
			slog.Warn("PoolEngine permanently stalled: only 1 idle agent and no active calls — cannot form a pair")
			return nil, nil, false, true
		}
		return nil, nil, false, false
	}

	caller = p.idleList[0]
	callee = p.idleList[1]
	p.idleList = p.idleList[2:]

	// Disable caller's auto-answer INSIDE the lock so no concurrent uasLoop
	// goroutine can accept an INVITE on this agent between now and the INVITE send.
	caller.SetAutoAnswer(false)

	p.nonIdleList = append(p.nonIdleList, caller, callee)
	return caller, callee, true, false
}

// ReturnPair moves a completed pair from non-idle back to the END of idle_list.
// Both agents' auto-answer is re-enabled. Called after BYE/200 OK completes,
// allowing the same users to be reused without re-registering or re-subscribing.
func (p *PoolEngine) ReturnPair(caller, callee *agent.ExtensionAgent) {
	caller.SetAutoAnswer(true)
	callee.SetAutoAnswer(true)

	p.mu.Lock()
	defer p.mu.Unlock()

	p.nonIdleList = removeAgent(p.nonIdleList, caller)
	p.nonIdleList = removeAgent(p.nonIdleList, callee)
	// Append to END so other waiting agents get a turn first.
	p.idleList = append(p.idleList, caller, callee)
}

// AllForCleanup returns all agents across idle, non-idle, and reg-only lists.
// Used during the cleanup phase (unsubscribe + unregister everyone).
func (p *PoolEngine) AllForCleanup() []*agent.ExtensionAgent {
	p.mu.Lock()
	defer p.mu.Unlock()
	all := make([]*agent.ExtensionAgent, 0,
		len(p.idleList)+len(p.nonIdleList)+len(p.regOnlyList))
	all = append(all, p.idleList...)
	all = append(all, p.nonIdleList...)
	all = append(all, p.regOnlyList...)
	return all
}

// ReplaceIdle swaps the ready pool after a controlled HA subscription move.
// It is intentionally conservative: callers must ensure no calls are active.
func (p *PoolEngine) ReplaceIdle(agents []*agent.ExtensionAgent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, a := range p.idleList {
		a.SetAutoAnswer(false)
	}
	p.idleList = append([]*agent.ExtensionAgent(nil), agents...)
	p.nonIdleList = nil
	p.regOnlyList = nil
	for _, a := range p.idleList {
		a.SetAutoAnswer(true)
	}
}

// Counts returns current list sizes for metrics reporting.
func (p *PoolEngine) Counts() (idle, nonIdle, regOnly int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.idleList), len(p.nonIdleList), len(p.regOnlyList)
}

// removeAgent removes the first occurrence of target from list and returns
// the modified slice. Order is preserved.
func removeAgent(list []*agent.ExtensionAgent, target *agent.ExtensionAgent) []*agent.ExtensionAgent {
	for i, a := range list {
		if a == target {
			return append(list[:i], list[i+1:]...)
		}
	}
	return list
}
