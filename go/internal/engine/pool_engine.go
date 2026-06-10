package engine

import (
	"log/slog"

	"github.com/cci/traffic-engine/internal/agent"
)

// AgentRole is assigned only after an extension has completed REGISTER and
// SUBSCRIBE. Roles are based on Reg/Sub-ready order so the usable pool remains
// balanced even when connection, register, or subscribe failures are uneven.
type AgentRole string

const (
	RoleUAS AgentRole = "uas"
	RoleUAC AgentRole = "uac"
)

// PoolRoleCounts is a read-only snapshot of role-specific pool counts.
type PoolRoleCounts struct {
	UACIdle       int
	UASIdle       int
	NonIdle       int
	RegOnly       int
	RegSubReady   int
	UACAssigned   int
	UASAssigned   int
	RequiredReady int
}

type poolCommand struct {
	op      string
	agent   *agent.ExtensionAgent
	caller  *agent.ExtensionAgent
	callee  *agent.ExtensionAgent
	agents  []*agent.ExtensionAgent
	resp    chan poolResponse
	respAll chan []*agent.ExtensionAgent
}

type poolResponse struct {
	role    AgentRole
	caller  *agent.ExtensionAgent
	callee  *agent.ExtensionAgent
	ok      bool
	stalled bool
	counts  PoolRoleCounts
}

// PoolEngine owns the role-specific ready queues for the traffic model.
// Mutation is serialized through an internal owner goroutine: Reg/Sub workers,
// the call scheduler, and completion handlers communicate by command channels
// instead of concurrently appending to shared slices.
//
// Population rules (set during pre-phase):
//   - Reg OK + Sub OK  → assigned UAC/UAS by ready sequence
//   - Reg OK + Sub fail → reg_only_list (registered but no subscription)
//   - Reg fail          → tracked only as failed count, not in any list
//
// Call pairing rules:
//   - NextPair picks one caller from uac_idle_list and one callee from
//     uas_idle_list.
//   - After BYE/200, ReturnPair appends both back to their role-specific
//     ready queues so users can be reused without re-registering.
type PoolEngine struct {
	cmdCh chan poolCommand
}

// NewPoolEngine creates an empty pool engine.
func NewPoolEngine() *PoolEngine {
	p := &PoolEngine{cmdCh: make(chan poolCommand, 1024)}
	go p.run()
	return p
}

func (p *PoolEngine) run() {
	var (
		uacIdle     []*agent.ExtensionAgent
		uasIdle     []*agent.ExtensionAgent
		nonIdle     []*agent.ExtensionAgent
		regOnly     []*agent.ExtensionAgent
		regSubReady []*agent.ExtensionAgent
		roles       = make(map[*agent.ExtensionAgent]AgentRole)
		readySeq    int
	)

	reorderUsable := func(list []*agent.ExtensionAgent) []*agent.ExtensionAgent {
		if len(list) == 0 {
			return list
		}
		usable := make([]*agent.ExtensionAgent, 0, len(list))
		blocked := make([]*agent.ExtensionAgent, 0)
		for _, ag := range list {
			if ag.IsRegistrationUsable() {
				usable = append(usable, ag)
			} else {
				blocked = append(blocked, ag)
			}
		}
		return append(usable, blocked...)
	}

	snapshot := func() PoolRoleCounts {
		return PoolRoleCounts{
			UACIdle:     len(uacIdle),
			UASIdle:     len(uasIdle),
			NonIdle:     len(nonIdle),
			RegOnly:     len(regOnly),
			RegSubReady: len(regSubReady),
			UACAssigned: countRole(roles, RoleUAC),
			UASAssigned: countRole(roles, RoleUAS),
		}
	}

	for cmd := range p.cmdCh {
		switch cmd.op {
		case "assign_ready":
			role := RoleUAS
			if readySeq%2 == 1 {
				role = RoleUAC
			}
			readySeq++
			roles[cmd.agent] = role
			regSubReady = append(regSubReady, cmd.agent)
			cmd.resp <- poolResponse{role: role, counts: snapshot()}

		case "add_uac_idle":
			cmd.agent.SetAutoAnswer(false)
			uacIdle = append(uacIdle, cmd.agent)

		case "add_uas_idle":
			cmd.agent.SetAutoAnswer(true)
			uasIdle = append(uasIdle, cmd.agent)

		case "add_reg_only":
			regOnly = append(regOnly, cmd.agent)

		case "next_pair":
			uacIdle = reorderUsable(uacIdle)
			uasIdle = reorderUsable(uasIdle)
			if len(uacIdle) < 1 || len(uasIdle) < 1 {
				if len(uacIdle)+len(uasIdle) == 1 && len(nonIdle) == 0 {
					slog.Warn("PoolEngine permanently stalled: only 1 role-ready agent and no active calls")
					cmd.resp <- poolResponse{stalled: true}
					continue
				}
				cmd.resp <- poolResponse{}
				continue
			}
			caller := uacIdle[0]
			callee := uasIdle[0]
			uacIdle = uacIdle[1:]
			uasIdle = uasIdle[1:]
			caller.SetAutoAnswer(false)
			callee.SetAutoAnswer(true)
			nonIdle = append(nonIdle, caller, callee)
			cmd.resp <- poolResponse{caller: caller, callee: callee, ok: true}

		case "return_pair":
			nonIdle = removeAgent(nonIdle, cmd.caller)
			nonIdle = removeAgent(nonIdle, cmd.callee)
			cmd.caller.SetAutoAnswer(false)
			cmd.callee.SetAutoAnswer(true)
			uacIdle = append(uacIdle, cmd.caller)
			uasIdle = append(uasIdle, cmd.callee)

		case "all_cleanup":
			all := make([]*agent.ExtensionAgent, 0, len(uacIdle)+len(uasIdle)+len(nonIdle)+len(regOnly))
			all = append(all, uacIdle...)
			all = append(all, uasIdle...)
			all = append(all, nonIdle...)
			all = append(all, regOnly...)
			cmd.respAll <- all

		case "replace_idle":
			for _, a := range uacIdle {
				a.SetAutoAnswer(false)
			}
			for _, a := range uasIdle {
				a.SetAutoAnswer(false)
			}
			uacIdle = nil
			uasIdle = nil
			nonIdle = nil
			regOnly = nil
			regSubReady = append([]*agent.ExtensionAgent(nil), cmd.agents...)
			roles = make(map[*agent.ExtensionAgent]AgentRole, len(cmd.agents))
			readySeq = 0
			for _, ag := range cmd.agents {
				role := RoleUAS
				if readySeq%2 == 1 {
					role = RoleUAC
					ag.SetAutoAnswer(false)
					uacIdle = append(uacIdle, ag)
				} else {
					ag.SetAutoAnswer(true)
					uasIdle = append(uasIdle, ag)
				}
				roles[ag] = role
				readySeq++
			}

		case "counts":
			cmd.resp <- poolResponse{counts: snapshot()}
		}
	}
}

func countRole(roles map[*agent.ExtensionAgent]AgentRole, role AgentRole) int {
	count := 0
	for _, r := range roles {
		if r == role {
			count++
		}
	}
	return count
}

// AssignRegSubReady records a Reg/Sub-ready agent and assigns its fixed role.
// The caller should start and confirm UAS listener readiness before calling
// AddToUASIdle for UAS agents.
func (p *PoolEngine) AssignRegSubReady(a *agent.ExtensionAgent) AgentRole {
	resp := make(chan poolResponse, 1)
	p.cmdCh <- poolCommand{op: "assign_ready", agent: a, resp: resp}
	return (<-resp).role
}

func (p *PoolEngine) AddToUACIdle(a *agent.ExtensionAgent) {
	p.cmdCh <- poolCommand{op: "add_uac_idle", agent: a}
}

func (p *PoolEngine) AddToUASIdle(a *agent.ExtensionAgent) {
	p.cmdCh <- poolCommand{op: "add_uas_idle", agent: a}
}

// AddToRegOnly adds an agent that registered but failed to subscribe.
func (p *PoolEngine) AddToRegOnly(a *agent.ExtensionAgent) {
	p.cmdCh <- poolCommand{op: "add_reg_only", agent: a}
}

// NextPair picks one UAC caller and one UAS callee.
//
// Returns:
//   - (caller, callee, ok=true, stalled=false)  — pair ready
//   - (nil, nil, ok=false, stalled=false)        — role pool empty; back-pressure
//   - (nil, nil, ok=false, stalled=true)         — permanently stuck (1 total ready, 0 non-idle)
func (p *PoolEngine) NextPair() (caller, callee *agent.ExtensionAgent, ok bool, stalled bool) {
	resp := make(chan poolResponse, 1)
	p.cmdCh <- poolCommand{op: "next_pair", resp: resp}
	r := <-resp
	return r.caller, r.callee, r.ok, r.stalled
}

// ReturnPair moves a completed UAC/UAS pair back to their role queues.
func (p *PoolEngine) ReturnPair(caller, callee *agent.ExtensionAgent) {
	p.cmdCh <- poolCommand{op: "return_pair", caller: caller, callee: callee}
}

// AllForCleanup returns all agents across idle, non-idle, and reg-only lists.
// Used during the cleanup phase (unsubscribe + unregister everyone).
func (p *PoolEngine) AllForCleanup() []*agent.ExtensionAgent {
	resp := make(chan []*agent.ExtensionAgent, 1)
	p.cmdCh <- poolCommand{op: "all_cleanup", respAll: resp}
	return <-resp
}

// ReplaceIdle swaps the ready pool after a controlled HA subscription move.
// It is intentionally conservative: callers must ensure no calls are active.
func (p *PoolEngine) ReplaceIdle(agents []*agent.ExtensionAgent) {
	p.cmdCh <- poolCommand{op: "replace_idle", agents: append([]*agent.ExtensionAgent(nil), agents...)}
}

// Counts returns current list sizes for metrics reporting.
func (p *PoolEngine) Counts() (idle, nonIdle, regOnly int) {
	counts := p.RoleCounts()
	return counts.UACIdle + counts.UASIdle, counts.NonIdle, counts.RegOnly
}

// RoleCounts returns role-specific pool counts for metrics and readiness gates.
func (p *PoolEngine) RoleCounts() PoolRoleCounts {
	resp := make(chan poolResponse, 1)
	p.cmdCh <- poolCommand{op: "counts", resp: resp}
	return (<-resp).counts
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
