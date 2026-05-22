package config

import (
	"testing"
	"time"
)

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

func TestNonInviteTransactionTimeoutDerivesFromT1(t *testing.T) {
	cfg := &VMConfig{}
	ApplyDefaults(cfg)
	if got, want := cfg.NonInviteTransactionTimeout(), 32*time.Second; got != want {
		t.Fatalf("default non-INVITE timeout=%v, want %v", got, want)
	}

	cfg = &VMConfig{T1Ms: 1000}
	ApplyDefaults(cfg)
	if got, want := cfg.NonInviteTransactionTimeout(), 64*time.Second; got != want {
		t.Fatalf("custom T1 non-INVITE timeout=%v, want %v", got, want)
	}
}

func TestMediaSecurityDefaultsAndValidation(t *testing.T) {
	cfg := &VMConfig{}
	ApplyDefaults(cfg)
	if cfg.MediaSecurity != "rtp" || cfg.SRTPKeyMode != "auto" || len(cfg.SRTPCryptoSuites) != 1 {
		t.Fatalf("media security defaults got security=%q key_mode=%q suites=%v", cfg.MediaSecurity, cfg.SRTPKeyMode, cfg.SRTPCryptoSuites)
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
		MediaEnabled:    true,
		MediaSecurity:   "capneg",
	}
	ApplyDefaults(bad)
	if err := Validate(bad); err == nil {
		t.Fatal("Validate succeeded with unsupported media_security")
	}

	bad.MediaSecurity = "srtp_sdes"
	bad.SRTPCryptoSuites = []string{"BAD_SUITE"}
	if err := Validate(bad); err == nil {
		t.Fatal("Validate succeeded with unsupported SRTP crypto suite")
	}
}

func TestTLSVersionValidation(t *testing.T) {
	cfg := &VMConfig{
		VMID:            "traffic-local",
		ExtStart:        1000,
		ExtEnd:          1001,
		SBCHost:         "10.0.0.1",
		SBCPort:         5061,
		SIPTransport:    "TLS",
		TLSMode:         "insecure",
		TLSMinVersion:   "1.3",
		TLSMaxVersion:   "1.2",
		Domain:          "avaya.com",
		CPS:             1,
		HoldTimeSeconds: 1,
		RTPBurstPPS:     50,
		RTPPtime:        20,
		RTPMode:         "3phase",
		TrafficMode:     "unlimited",
	}
	ApplyDefaults(cfg)
	if err := Validate(cfg); err == nil {
		t.Fatal("Validate succeeded with tls_max_version lower than min")
	}
	cfg.TLSMaxVersion = "auto"
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate failed for TLS1.3 min / auto max: %v", err)
	}
}

func TestSIPSRequiresTLSTransport(t *testing.T) {
	cfg := &VMConfig{
		VMID:            "traffic-local",
		ExtStart:        1000,
		ExtEnd:          1001,
		SBCHost:         "10.0.0.1",
		SBCPort:         5060,
		SIPTransport:    "TCP",
		SIPScheme:       "SIPS",
		Domain:          "avaya.com",
		CPS:             1,
		HoldTimeSeconds: 1,
		RTPBurstPPS:     50,
		RTPPtime:        20,
		RTPMode:         "3phase",
		TrafficMode:     "unlimited",
	}
	ApplyDefaults(cfg)
	if err := Validate(cfg); err == nil {
		t.Fatal("Validate succeeded with SIPS over TCP")
	}
	cfg.SIPTransport = "TLS"
	cfg.TLSMode = "insecure"
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate failed with SIPS over TLS: %v", err)
	}
	if got := cfg.URIScheme(); got != "sips" {
		t.Fatalf("URIScheme=%q, want sips", got)
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
