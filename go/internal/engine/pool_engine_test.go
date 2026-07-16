package engine

import (
	"testing"

	"github.com/cci/traffic-engine/internal/agent"
)

func placedAgent(ext, group, zone, host string) *agent.ExtensionAgent {
	a := agent.NewExtensionAgent(ext, nil)
	a.SetPlacement(group, zone, host, 5061)
	return a
}

func addReadyPair(t *testing.T, p *PoolEngine, uas, uac *agent.ExtensionAgent) {
	t.Helper()
	if role := p.AssignRegSubReady(uas); role != RoleUAS {
		t.Fatalf("first ready role=%s, want UAS", role)
	}
	p.AddToUASIdle(uas)
	if role := p.AssignRegSubReady(uac); role != RoleUAC {
		t.Fatalf("second ready role=%s, want UAC", role)
	}
	p.AddToUACIdle(uac)
}

func TestPoolPairingSameZone(t *testing.T) {
	p := NewPoolEngine()
	addReadyPair(t, p,
		placedAgent("1000", "g-a", "zone-a", "10.0.0.1"),
		placedAgent("1001", "g-a", "zone-a", "10.0.0.1"))
	p.SetPairingPolicy(PairingSameZone)
	caller, callee, ok, stalled := p.NextPair()
	if !ok || stalled {
		t.Fatalf("NextPair ok=%v stalled=%v", ok, stalled)
	}
	if caller.ZoneID != callee.ZoneID {
		t.Fatalf("zones differ: caller=%s callee=%s", caller.ZoneID, callee.ZoneID)
	}
}

func TestPoolPairingCrossZone(t *testing.T) {
	p := NewPoolEngine()
	addReadyPair(t, p,
		placedAgent("1000", "g-a", "zone-a", "10.0.0.1"),
		placedAgent("2000", "g-b", "zone-b", "10.0.0.2"))
	p.SetPairingPolicy(PairingCrossZone)
	caller, callee, ok, stalled := p.NextPair()
	if !ok || stalled {
		t.Fatalf("NextPair ok=%v stalled=%v", ok, stalled)
	}
	if caller.ZoneID == callee.ZoneID {
		t.Fatalf("zones match: caller=%s callee=%s", caller.ZoneID, callee.ZoneID)
	}
}

func TestPoolPairingSameControllerNoMatchDoesNotStall(t *testing.T) {
	p := NewPoolEngine()
	addReadyPair(t, p,
		placedAgent("1000", "g-a", "zone-a", "10.0.0.1"),
		placedAgent("2000", "g-b", "zone-b", "10.0.0.2"))
	p.SetPairingPolicy(PairingSameController)
	_, _, ok, stalled := p.NextPair()
	if ok || stalled {
		t.Fatalf("NextPair ok=%v stalled=%v, want no match without stall", ok, stalled)
	}
}

func TestPoolSameControllerPolicyBalancesRolesPerController(t *testing.T) {
	p := NewPoolEngine()
	p.SetPairingPolicy(PairingSameController)

	agents := []*agent.ExtensionAgent{
		placedAgent("1000", "g-a", "zone-a", "10.0.0.1"),
		placedAgent("2000", "g-b", "zone-b", "10.0.0.2"),
		placedAgent("1001", "g-a", "zone-a", "10.0.0.1"),
		placedAgent("2001", "g-b", "zone-b", "10.0.0.2"),
	}
	for _, ag := range agents {
		role := p.AssignRegSubReady(ag)
		if role == RoleUAC {
			p.AddToUACIdle(ag)
		} else {
			p.AddToUASIdle(ag)
		}
	}

	firstCaller, firstCallee, ok, stalled := p.NextPair()
	if !ok || stalled {
		t.Fatalf("first NextPair ok=%v stalled=%v", ok, stalled)
	}
	if firstCaller.ControllerHost != firstCallee.ControllerHost {
		t.Fatalf("first controllers differ: caller=%s callee=%s", firstCaller.ControllerHost, firstCallee.ControllerHost)
	}

	secondCaller, secondCallee, ok, stalled := p.NextPair()
	if !ok || stalled {
		t.Fatalf("second NextPair ok=%v stalled=%v", ok, stalled)
	}
	if secondCaller.ControllerHost != secondCallee.ControllerHost {
		t.Fatalf("second controllers differ: caller=%s callee=%s", secondCaller.ControllerHost, secondCallee.ControllerHost)
	}
	if firstCaller.ControllerHost == secondCaller.ControllerHost {
		t.Fatalf("expected pairs from both controllers, got %s and %s", firstCaller.ControllerHost, secondCaller.ControllerHost)
	}
}
