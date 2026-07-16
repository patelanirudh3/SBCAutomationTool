package main

import (
	"testing"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/engine"
)

func TestBuildMultiZoneRegSubItemsInterleavesGroups(t *testing.T) {
	cfg := &config.VMConfig{Domain: "example.com", SIPTransport: "TCP"}
	groupA := engine.NewAgentGroup(config.AgentGroupAssignment{
		GroupID:             "zone-a-ctrl-1",
		ZoneID:              "zone-a",
		PrimaryController:   config.ZoneController{Host: "a1", Port: 5060},
		SecondaryController: config.ZoneController{Host: "b1", Port: 5060},
		ExtStart:            1000,
		ExtEnd:              1001,
	})
	groupB := engine.NewAgentGroup(config.AgentGroupAssignment{
		GroupID:             "zone-b-ctrl-1",
		ZoneID:              "zone-b",
		PrimaryController:   config.ZoneController{Host: "b1", Port: 5060},
		SecondaryController: config.ZoneController{Host: "a1", Port: 5060},
		ExtStart:            2000,
		ExtEnd:              2001,
	})
	for _, ext := range []string{"1000", "1001"} {
		groupA.PrimaryAgents[ext] = agent.NewExtensionAgent(ext, cfg)
		groupA.SecondaryAgents[ext] = agent.NewExtensionAgent(ext, cfg)
	}
	for _, ext := range []string{"2000", "2001"} {
		groupB.PrimaryAgents[ext] = agent.NewExtensionAgent(ext, cfg)
		groupB.SecondaryAgents[ext] = agent.NewExtensionAgent(ext, cfg)
	}

	items := buildMultiZoneRegSubItems(cfg, []*engine.AgentGroup{groupB, groupA})
	got := make([]string, 0, len(items))
	for _, item := range items {
		got = append(got, item.primary.Ext)
	}
	want := []string{"1000", "2000", "1001", "2001"}
	if len(got) != len(want) {
		t.Fatalf("items=%v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("items=%v, want %v", got, want)
		}
	}
}

func TestBuildMultiZoneRegSubItemsPairsSecondaryEvenWhenPrimaryMayFail(t *testing.T) {
	cfg := &config.VMConfig{Domain: "example.com", SIPTransport: "TCP"}
	group := engine.NewAgentGroup(config.AgentGroupAssignment{
		GroupID:             "zone-a-ctrl-1",
		ZoneID:              "zone-a",
		PrimaryController:   config.ZoneController{Host: "a1", Port: 5060},
		SecondaryController: config.ZoneController{Host: "b1", Port: 5060},
		ExtStart:            1000,
		ExtEnd:              1000,
	})
	primary := agent.NewExtensionAgent("1000", cfg)
	secondary := agent.NewExtensionAgent("1000", cfg)
	group.PrimaryAgents["1000"] = primary
	group.SecondaryAgents["1000"] = secondary

	items := buildMultiZoneRegSubItems(cfg, []*engine.AgentGroup{group})
	if len(items) != 1 {
		t.Fatalf("items=%d, want 1", len(items))
	}
	if items[0].primary != primary || items[0].secondary != secondary {
		t.Fatalf("primary/secondary pairing mismatch: %+v", items[0])
	}
}
