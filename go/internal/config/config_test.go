package config

import (
	"strings"
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

func TestCleanupRateDefaultsAndValidation(t *testing.T) {
	cfg := &VMConfig{}
	ApplyDefaults(cfg)
	if cfg.CleanupUnsubscribeRate != 20 || cfg.CleanupUnregisterRate != 20 {
		t.Fatalf("cleanup rate defaults unsubscribe=%d unregister=%d, want 20/20", cfg.CleanupUnsubscribeRate, cfg.CleanupUnregisterRate)
	}

	bad := &VMConfig{
		VMID:                  "traffic-local",
		ExtStart:              1000,
		ExtEnd:                1001,
		SBCHost:               "10.0.0.1",
		SBCPort:               5060,
		SIPTransport:          "TCP",
		Domain:                "avaya.com",
		CPS:                   1,
		HoldTimeSeconds:       1,
		RTPBurstPPS:           50,
		RTPPtime:              20,
		RTPMode:               "3phase",
		TrafficMode:           "unlimited",
		MediaEnabled:          true,
		MediaSecurity:         "rtp",
		CleanupUnregisterRate: 0,
	}
	ApplyDefaults(bad)
	bad.CleanupUnregisterRate = -1
	if err := Validate(bad); err == nil {
		t.Fatal("Validate succeeded with negative cleanup_unregister_rate_per_sec")
	}
}

func TestMediaSecurityDefaultsAndValidation(t *testing.T) {
	cfg := &VMConfig{}
	ApplyDefaults(cfg)
	if cfg.MediaSecurity != "rtp" || cfg.SRTPKeyMode != "auto" || len(cfg.SRTPCryptoSuites) != 1 || cfg.RTPUnsupportedCodecPolicy != "fallback_g711" {
		t.Fatalf("media security defaults got security=%q key_mode=%q suites=%v codec_policy=%q", cfg.MediaSecurity, cfg.SRTPKeyMode, cfg.SRTPCryptoSuites, cfg.RTPUnsupportedCodecPolicy)
	}

	g729Audio := &VMConfig{
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
		RTPCodec:        "G729_AUDIO",
	}
	ApplyDefaults(g729Audio)
	if err := Validate(g729Audio); err != nil {
		t.Fatalf("Validate failed for G729_AUDIO: %v", err)
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

	bad.SRTPCryptoSuites = []string{"AES_CM_128_HMAC_SHA1_80"}
	bad.RTPUnsupportedCodecPolicy = "bad_policy"
	if err := Validate(bad); err == nil {
		t.Fatal("Validate succeeded with unsupported RTP codec policy")
	}
}

func TestPairingPolicyDefaultsAndValidation(t *testing.T) {
	cfg := &VMConfig{}
	ApplyDefaults(cfg)
	if cfg.PairingPolicy != "random" {
		t.Fatalf("pairing policy default=%q, want random", cfg.PairingPolicy)
	}

	valid := &VMConfig{
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
		PairingPolicy:   "same_controller",
	}
	ApplyDefaults(valid)
	if err := Validate(valid); err != nil {
		t.Fatalf("Validate failed for same_controller pairing policy: %v", err)
	}

	valid.PairingPolicy = "invalid"
	if err := Validate(valid); err == nil {
		t.Fatal("Validate succeeded with unsupported pairing_policy")
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

func TestVIPConfigValidationAndMapping(t *testing.T) {
	cfg := &VMConfig{
		VMID:            "traffic-local",
		ExtStart:        6000000,
		ExtEnd:          6000002,
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
		LocalIPMode:     "unique_vip",
		VIPInterface:    "eth0",
		VIPCIDR:         "10.71.16.0/21",
		VIPFirstIP:      "10.71.17.101",
		VIPCount:        3,
	}
	ApplyDefaults(cfg)
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate failed for VIP config: %v", err)
	}
	if got := cfg.LocalHostForExtension("6000001"); got != "10.71.17.102" {
		t.Fatalf("LocalHostForExtension=%q, want 10.71.17.102", got)
	}

	cfg.LocalIPMode = "vip_pool"
	cfg.VIPCount = 2
	if got := cfg.LocalHostForExtension("6000002"); got != "10.71.17.101" {
		t.Fatalf("pooled LocalHostForExtension=%q, want round-robin first VIP", got)
	}
}

func TestStaticAssignmentsExtCountAndVIPMappingUseAssignmentPosition(t *testing.T) {
	cfg := &VMConfig{
		VMID:            "traffic-local",
		ExtStart:        100,
		ExtEnd:          549,
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
		LocalIPMode:     "unique_vip",
		VIPInterface:    "eth0",
		VIPCIDR:         "10.71.16.0/21",
		VIPFirstIP:      "10.71.17.101",
		VIPCount:        100,
		StaticAgentAssignments: []StaticAgentAssignment{
			{ExtStart: 100, ExtEnd: 149},
			{ExtStart: 500, ExtEnd: 549},
		},
	}
	ApplyDefaults(cfg)
	if got := cfg.ExtCount(); got != 100 {
		t.Fatalf("ExtCount=%d, want 100", got)
	}
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate failed for non-contiguous static VIP config: %v", err)
	}
	tests := map[string]string{
		"100": "10.71.17.101",
		"149": "10.71.17.150",
		"500": "10.71.17.151",
		"549": "10.71.17.200",
	}
	for ext, want := range tests {
		if got := cfg.LocalHostForExtension(ext); got != want {
			t.Fatalf("LocalHostForExtension(%s)=%q, want %q", ext, got, want)
		}
	}
}

func TestStaticAssignmentsDeriveGlobalExtensionBounds(t *testing.T) {
	cfg := &VMConfig{
		VMID:     "traffic-local",
		ExtStart: 0,
		ExtEnd:   0,
		SBCHost:  "10.0.0.1",
		SBCPort:  5060,
		HAMode:   "multi_zone",
		ZoneConfig: twoZoneConfig(50,
			[]ZoneController{{Host: "a1", Port: 5061}},
			[]ZoneController{{Host: "b1", Port: 5061}},
		),
		StaticAgentAssignments: []StaticAgentAssignment{
			{ExtStart: 55000, ExtEnd: 55499, PrimaryController: ZoneController{Host: "a1", Port: 5061}, SecondaryController: ZoneController{Host: "b1", Port: 5061}},
			{ExtStart: 880000, ExtEnd: 880199, PrimaryController: ZoneController{Host: "b1", Port: 5061}, SecondaryController: ZoneController{Host: "a1", Port: 5061}},
		},
		SIPTransport:    "TCP",
		Domain:          "avaya.com",
		CPS:             1,
		HoldTimeSeconds: 1,
		RTPBurstPPS:     50,
		RTPPtime:        20,
		RTPMode:         "3phase",
		TrafficMode:     "unlimited",
	}
	ApplyDefaults(cfg)
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate failed: %v", err)
	}
	if cfg.ExtStart != 55000 || cfg.ExtEnd != 880199 {
		t.Fatalf("derived bounds=%d-%d, want 55000-880199", cfg.ExtStart, cfg.ExtEnd)
	}
	if got := cfg.ExtCount(); got != 700 {
		t.Fatalf("ExtCount=%d, want 700", got)
	}
}

func TestDualRegistrationValidation(t *testing.T) {
	cfg := &VMConfig{
		VMID:                    "traffic-local",
		ExtStart:                1000,
		ExtEnd:                  1001,
		SBCHost:                 "10.0.0.1",
		SBCPort:                 5060,
		SIPTransport:            "TCP",
		Domain:                  "avaya.com",
		CPS:                     1,
		HoldTimeSeconds:         1,
		RTPBurstPPS:             50,
		RTPPtime:                20,
		RTPMode:                 "3phase",
		TrafficMode:             "unlimited",
		DualRegistrationEnabled: true,
		FailoverMode:            "graceful",
	}
	ApplyDefaults(cfg)
	if err := Validate(cfg); err == nil {
		t.Fatal("Validate succeeded with dual registration enabled and no secondary host")
	}
	cfg.SecondaryHost = "10.0.0.2"
	cfg.SecondaryPort = 5060
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate failed with valid dual registration config: %v", err)
	}
	if !cfg.FailoverEnabled {
		t.Fatal("dual registration should enable failover compatibility flag")
	}
}

func TestComputeAgentGroupsTwoZoneHalfSplit(t *testing.T) {
	cfg := &VMConfig{
		HAMode:     "multi_zone",
		ExtStart:   6000000,
		ExtEnd:     6000003,
		ZoneConfig: twoZoneConfig(50, []ZoneController{{Host: "controller-a", Port: 5061}}, []ZoneController{{Host: "controller-b", Port: 5061}}),
	}

	groups := cfg.ComputeAgentGroups()
	if len(groups) != 2 {
		t.Fatalf("groups=%d, want 2: %#v", len(groups), groups)
	}
	assertGroup(t, groups[0], "zone-a-ctrl-1", "zone-a", "controller-a", "controller-b", 6000000, 6000001)
	assertGroup(t, groups[1], "zone-b-ctrl-1", "zone-b", "controller-b", "controller-a", 6000002, 6000003)
}

func TestComputeAgentGroupsUnevenDistributionAndControllerRemainder(t *testing.T) {
	cfg := &VMConfig{
		HAMode:   "multi_zone",
		ExtStart: 1000,
		ExtEnd:   1009,
		ZoneConfig: twoZoneConfig(60,
			[]ZoneController{{Host: "a1", Port: 5060}, {Host: "a2", Port: 5060}},
			[]ZoneController{{Host: "b1", Port: 5060}},
		),
	}

	groups := cfg.ComputeAgentGroups()
	if len(groups) != 3 {
		t.Fatalf("groups=%d, want 3: %#v", len(groups), groups)
	}
	assertGroup(t, groups[0], "zone-a-ctrl-1", "zone-a", "a1", "b1", 1000, 1002)
	assertGroup(t, groups[1], "zone-a-ctrl-2", "zone-a", "a2", "b1", 1003, 1005)
	assertGroup(t, groups[2], "zone-b-ctrl-1", "zone-b", "b1", "a1", 1006, 1009)
}

func TestComputeAgentGroupsSingleZoneNoSecondary(t *testing.T) {
	cfg := &VMConfig{
		HAMode:   "multi_zone",
		ExtStart: 7000,
		ExtEnd:   7003,
		ZoneConfig: &ZoneConfig{
			ZoneDistributionPct: 50,
			Zones: []Zone{
				{ZoneID: "zone-a", Controllers: []ZoneController{{Host: "a1", Port: 5060}}},
			},
		},
	}

	groups := cfg.ComputeAgentGroups()
	if len(groups) != 1 {
		t.Fatalf("groups=%d, want 1: %#v", len(groups), groups)
	}
	assertGroup(t, groups[0], "zone-a-ctrl-1", "zone-a", "a1", "", 7000, 7003)
	if groups[0].SecondaryController.Port != 0 {
		t.Fatalf("secondary port=%d, want 0", groups[0].SecondaryController.Port)
	}
}

func TestComputeAgentGroupsStaticAssignments(t *testing.T) {
	cfg := &VMConfig{
		HAMode:   "multi_zone",
		ExtStart: 1000,
		ExtEnd:   1099,
		ZoneConfig: twoZoneConfig(50,
			[]ZoneController{{Host: "a1", Port: 5061}, {Host: "a2", Port: 5061}},
			[]ZoneController{{Host: "b1", Port: 5061}, {Host: "b2", Port: 5061}},
		),
		StaticAgentAssignments: []StaticAgentAssignment{
			{
				ExtStart:            1000,
				ExtCount:            50,
				PrimaryController:   ZoneController{Host: "a1", Port: 5061},
				SecondaryController: ZoneController{Host: "b1", Port: 5061},
			},
			{
				ExtStart:            1050,
				ExtEnd:              1099,
				PrimaryZoneID:       "zone-b",
				PrimaryController:   ZoneController{Host: "b2", Port: 5061},
				SecondaryZoneID:     "zone-a",
				SecondaryController: ZoneController{Host: "a2", Port: 5061},
			},
		},
		CPS:             1,
		HoldTimeSeconds: 1,
		RTPBurstPPS:     50,
		RTPPtime:        20,
		RTPMode:         "3phase",
		TrafficMode:     "unlimited",
		SBCHost:         "ignored.example",
		SBCPort:         5060,
		SIPTransport:    "TCP",
		Domain:          "avaya.com",
	}
	ApplyDefaults(cfg)
	if err := Validate(cfg); err != nil {
		t.Fatalf("Validate failed: %v", err)
	}
	groups := cfg.ComputeAgentGroups()
	if len(groups) != 2 {
		t.Fatalf("groups=%d, want 2: %#v", len(groups), groups)
	}
	assertGroup(t, groups[0], "static-zone-a-a1-5061-range-1000-1049", "zone-a", "a1", "b1", 1000, 1049)
	assertGroup(t, groups[1], "static-zone-b-b2-5061-range-1050-1099", "zone-b", "b2", "a2", 1050, 1099)
}

func TestStaticAgentAssignmentsRejectOverlapAndUnknownController(t *testing.T) {
	cfg := &VMConfig{
		HAMode:   "multi_zone",
		ExtStart: 1000,
		ExtEnd:   1009,
		ZoneConfig: twoZoneConfig(50,
			[]ZoneController{{Host: "a1", Port: 5061}},
			[]ZoneController{{Host: "b1", Port: 5061}},
		),
		StaticAgentAssignments: []StaticAgentAssignment{
			{ExtStart: 1000, ExtEnd: 1005, PrimaryController: ZoneController{Host: "a1", Port: 5061}},
			{ExtStart: 1004, ExtEnd: 1009, PrimaryController: ZoneController{Host: "missing", Port: 5061}},
		},
		CPS:             1,
		HoldTimeSeconds: 1,
		RTPBurstPPS:     50,
		RTPPtime:        20,
		RTPMode:         "3phase",
		TrafficMode:     "unlimited",
		SBCHost:         "ignored.example",
		SBCPort:         5060,
		SIPTransport:    "TCP",
		Domain:          "avaya.com",
	}
	ApplyDefaults(cfg)
	err := Validate(cfg)
	if err == nil {
		t.Fatal("Validate succeeded with overlap and unknown controller")
	}
	msg := err.Error()
	if !strings.Contains(msg, "overlaps") || !strings.Contains(msg, "not present in zone_config") {
		t.Fatalf("Validate error=%q, want overlap and unknown controller", msg)
	}
}

func twoZoneConfig(distribution int, zoneA, zoneB []ZoneController) *ZoneConfig {
	return &ZoneConfig{
		ZoneDistributionPct: distribution,
		Zones: []Zone{
			{ZoneID: "zone-a", Controllers: zoneA},
			{ZoneID: "zone-b", Controllers: zoneB},
		},
	}
}

func assertGroup(t *testing.T, got AgentGroupAssignment, groupID, zoneID, primaryHost, secondaryHost string, extStart, extEnd int) {
	t.Helper()
	if got.GroupID != groupID ||
		got.ZoneID != zoneID ||
		got.PrimaryController.Host != primaryHost ||
		got.SecondaryController.Host != secondaryHost ||
		got.ExtStart != extStart ||
		got.ExtEnd != extEnd {
		t.Fatalf("group mismatch:\n got=%+v\nwant group=%s zone=%s primary=%s secondary=%s range=%d-%d",
			got, groupID, zoneID, primaryHost, secondaryHost, extStart, extEnd)
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
