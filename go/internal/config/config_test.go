package config

import "testing"

func TestSubscribeEventsDefaultAndLegacyAlias(t *testing.T) {
	cfg := &VMConfig{}
	ApplyDefaults(cfg)
	if len(cfg.SubscribeEvents) != 1 || cfg.SubscribeEvents[0] != "dialog" {
		t.Fatalf("default subscribe_events=%v, want [dialog]", cfg.SubscribeEvents)
	}
	if !cfg.ShouldRefreshSubscribeEvent("dialog") || !cfg.ShouldUnsubscribeSubscribeEvent("dialog") {
		t.Fatalf("default dialog refresh/unsubscribe not enabled: refresh=%v unsubscribe=%v", cfg.SubscribeRefreshEvents, cfg.SubscribeUnsubscribeEvents)
	}

	cfg = &VMConfig{SubscribeEvent: "reg"}
	ApplyDefaults(cfg)
	if len(cfg.SubscribeEvents) != 1 || cfg.SubscribeEvents[0] != "reg" {
		t.Fatalf("legacy subscribe_event mapped to %v, want [reg]", cfg.SubscribeEvents)
	}
}

func TestSubscribePolicyEventsCanBeDisabled(t *testing.T) {
	cfg := &VMConfig{
		SubscribeEvents:            []string{"dialog", "reg"},
		SubscribeRefreshEvents:     []string{},
		SubscribeUnsubscribeEvents: []string{"reg"},
	}
	ApplyDefaults(cfg)
	if cfg.ShouldRefreshSubscribeEvent("dialog") || cfg.ShouldRefreshSubscribeEvent("reg") {
		t.Fatalf("refresh should be disabled, got %v", cfg.SubscribeRefreshEvents)
	}
	if cfg.ShouldUnsubscribeSubscribeEvent("dialog") || !cfg.ShouldUnsubscribeSubscribeEvent("reg") {
		t.Fatalf("unsubscribe policy mismatch: %v", cfg.SubscribeUnsubscribeEvents)
	}
}

func TestSubscribeEventsNormalizeAndValidate(t *testing.T) {
	cfg := &VMConfig{SubscribeEvents: []string{"dialog", "reg", "dialog", "avaya-cm-cc-info"}}
	ApplyDefaults(cfg)
	want := []string{"dialog", "reg", "avaya-cm-cc-info"}
	if len(cfg.SubscribeEvents) != len(want) {
		t.Fatalf("subscribe_events=%v, want %v", cfg.SubscribeEvents, want)
	}
	for i := range want {
		if cfg.SubscribeEvents[i] != want[i] {
			t.Fatalf("subscribe_events=%v, want %v", cfg.SubscribeEvents, want)
		}
	}

	bad := &VMConfig{
		VMID:            "traffic-local",
		ExtStart:        1000,
		ExtEnd:          1001,
		SBCHost:         "10.0.0.1",
		SBCPort:         5060,
		SIPTransport:    "TCP",
		Domain:          "avaya.com",
		CPS:             1,
		HoldTimeSeconds: 1,
		RTPBurstPPS:     50,
		RTPPtime:        20,
		RTPMode:         "3phase",
		TrafficMode:     "unlimited",
		SubscribeEvents: []string{"dialog", "presence"},
	}
	ApplyDefaults(bad)
	if err := Validate(bad); err == nil {
		t.Fatal("Validate succeeded with unsupported subscribe event")
	}

	badPolicy := *bad
	badPolicy.SubscribeEvents = []string{"dialog"}
	badPolicy.SubscribeRefreshEvents = []string{"reg"}
	ApplyDefaults(&badPolicy)
	if err := Validate(&badPolicy); err == nil {
		t.Fatal("Validate succeeded with refresh for unselected event")
	}
}
