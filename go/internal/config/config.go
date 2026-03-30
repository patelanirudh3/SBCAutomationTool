// Package config provides VMConfig loading, defaulting, and validation.
// Ported from the Python traffic/config.py module.
package config

import (
	"fmt"
	"log"
	"net"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// VMConfig holds all configuration for one VM's traffic run.
type VMConfig struct {
	VMRole    string `yaml:"vm_role" json:"vm_role"`
	VMID      string `yaml:"vm_id" json:"vm_id"`
	UACExtStart int  `yaml:"uac_ext_start" json:"uac_ext_start"`
	UACExtEnd   int  `yaml:"uac_ext_end" json:"uac_ext_end"`
	UASExtStart int  `yaml:"uas_ext_start" json:"uas_ext_start"`
	UASExtEnd   int  `yaml:"uas_ext_end" json:"uas_ext_end"`
	SBCHost     string `yaml:"sbc_host" json:"sbc_host"`
	SBCPort     int    `yaml:"sbc_port" json:"sbc_port"`
	SIPTransport string `yaml:"sip_transport" json:"sip_transport"`
	Domain       string `yaml:"domain" json:"domain"`
	SIPPassword  string `yaml:"sip_password" json:"sip_password"`
	CPS              int `yaml:"cps" json:"cps"`
	HoldTimeSeconds  int `yaml:"hold_time_seconds" json:"hold_time_seconds"`
	RampUpSeconds    int `yaml:"ramp_up_seconds" json:"ramp_up_seconds"`
	MetricsInterval  int `yaml:"metrics_interval" json:"metrics_interval"`
	MetricsPort      int `yaml:"metrics_port" json:"metrics_port"`
	CoordinatorURL   string `yaml:"coordinator_url" json:"coordinator_url"`
	RegisterRate     int `yaml:"register_rate" json:"register_rate"`
	RegisterExpires  int `yaml:"register_expires" json:"register_expires"`
	RegisterRetry    int `yaml:"register_retry" json:"register_retry"`
	RegisterTimeout  int `yaml:"register_timeout" json:"register_timeout"`
	MaxConcurrentCalls int `yaml:"max_concurrent_calls" json:"max_concurrent_calls"`
	LocalHost  string `yaml:"local_host" json:"local_host"`
	LocalPort  int    `yaml:"local_port" json:"local_port"`
	PeerStopURL string `yaml:"peer_stop_url" json:"peer_stop_url"`
	RTPBurstSeconds      int `yaml:"rtp_burst_seconds" json:"rtp_burst_seconds"`
	RTPBurstPPS          int `yaml:"rtp_burst_pps" json:"rtp_burst_pps"`
	RTPKeepaliveInterval int `yaml:"rtp_keepalive_interval" json:"rtp_keepalive_interval"`
	MediaEnabled bool   `yaml:"media_enabled" json:"media_enabled"`
	RTPMode      string `yaml:"rtp_mode" json:"rtp_mode"`
	RTPPtime     int    `yaml:"rtp_ptime" json:"rtp_ptime"`
	RTPPcap      bool   `yaml:"rtp_pcap" json:"rtp_pcap"`
	PoolWrapDelaySeconds float64 `yaml:"pool_wrap_delay_seconds" json:"pool_wrap_delay_seconds"`
	TrafficMode string  `yaml:"traffic_mode" json:"traffic_mode"`
	CallCount   int     `yaml:"call_count" json:"call_count"`
	DurationHours float64 `yaml:"duration_hours" json:"duration_hours"`
	Scenario                    string  `yaml:"scenario" json:"scenario"`
	ScenarioHoldDurationSeconds float64 `yaml:"scenario_hold_duration_seconds" json:"scenario_hold_duration_seconds"`
	ScenarioPreHoldRTPSeconds   float64 `yaml:"scenario_pre_hold_rtp_seconds" json:"scenario_pre_hold_rtp_seconds"`
	ScenarioPostHoldRTPSeconds  float64 `yaml:"scenario_post_hold_rtp_seconds" json:"scenario_post_hold_rtp_seconds"`
}

// UACExtCount returns the number of UAC extensions in the configured range.
func (c *VMConfig) UACExtCount() int {
	return c.UACExtEnd - c.UACExtStart + 1
}

// UASExtCount returns the number of UAS extensions in the configured range.
func (c *VMConfig) UASExtCount() int {
	return c.UASExtEnd - c.UASExtStart + 1
}

// PoolWrapCount returns total calls per full pool wrap, based on the
// extension count for the VM's role.
func (c *VMConfig) PoolWrapCount() int {
	if c.IsUAC() {
		count := c.UACExtCount()
		if count == 0 {
			return 0
		}
		return c.CallCount / count
	}
	count := c.UASExtCount()
	if count == 0 {
		return 0
	}
	return c.CallCount / count
}

// EffectiveMaxConcurrent returns MaxConcurrentCalls if explicitly set,
// otherwise the extension count for the VM's role.
func (c *VMConfig) EffectiveMaxConcurrent() int {
	if c.MaxConcurrentCalls > 0 {
		return c.MaxConcurrentCalls
	}
	if c.IsUAC() {
		return c.UACExtCount()
	}
	return c.UASExtCount()
}

// IsUAC reports whether the VM is configured as a UAC.
func (c *VMConfig) IsUAC() bool {
	return strings.EqualFold(c.VMRole, "UAC")
}

// IsUAS reports whether the VM is configured as a UAS.
func (c *VMConfig) IsUAS() bool {
	return strings.EqualFold(c.VMRole, "UAS")
}

// LoadConfig reads a YAML file, unmarshals it into a VMConfig, applies
// defaults for zero-valued fields, auto-detects LocalHost if empty, and
// validates the result.
func LoadConfig(path string) (*VMConfig, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: read %s: %w", path, err)
	}

	cfg := &VMConfig{}
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("config: parse %s: %w", path, err)
	}

	ApplyDefaults(cfg)

	if cfg.LocalHost == "" {
		if ip, err := detectLocalIP(); err == nil {
			cfg.LocalHost = ip
		} else {
			log.Printf("config: auto-detect local IP failed: %v", err)
		}
	}

	if err := Validate(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// ConfigFromDict creates a VMConfig from an arbitrary map (e.g. decoded
// JSON API body). It marshals the map to YAML, unmarshals into the struct,
// then applies defaults and validates.
func ConfigFromDict(data map[string]interface{}) (*VMConfig, error) {
	raw, err := yaml.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("config: marshal dict: %w", err)
	}

	cfg := &VMConfig{}
	if err := yaml.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("config: unmarshal dict: %w", err)
	}

	ApplyDefaults(cfg)

	if cfg.LocalHost == "" {
		if ip, err := detectLocalIP(); err == nil {
			cfg.LocalHost = ip
		} else {
			log.Printf("config: auto-detect local IP failed: %v", err)
		}
	}

	if err := Validate(cfg); err != nil {
		return nil, err
	}
	return cfg, nil
}

// ApplyDefaults fills zero-valued fields with sensible defaults.
func ApplyDefaults(cfg *VMConfig) {
	if cfg.CPS == 0 {
		cfg.CPS = 1
	}
	if cfg.HoldTimeSeconds == 0 {
		cfg.HoldTimeSeconds = 5
	}
	if cfg.RampUpSeconds == 0 {
		cfg.RampUpSeconds = 30
	}
	if cfg.MetricsInterval == 0 {
		cfg.MetricsInterval = 3
	}
	if cfg.RegisterRate == 0 {
		cfg.RegisterRate = 10
	}
	if cfg.RegisterExpires == 0 {
		cfg.RegisterExpires = 3600
	}
	if cfg.RegisterRetry == 0 {
		cfg.RegisterRetry = 3
	}
	if cfg.RegisterTimeout == 0 {
		cfg.RegisterTimeout = 8
	}
	if cfg.RTPBurstSeconds == 0 {
		cfg.RTPBurstSeconds = 2
	}
	if cfg.RTPBurstPPS == 0 {
		cfg.RTPBurstPPS = 50
	}
	if cfg.RTPKeepaliveInterval == 0 {
		cfg.RTPKeepaliveInterval = 3
	}
	if cfg.RTPMode == "" {
		cfg.RTPMode = "3phase"
	}
	if cfg.RTPPtime == 0 {
		cfg.RTPPtime = 20
	}
	if cfg.Scenario == "" {
		cfg.Scenario = "basic_call"
	}
	if cfg.SIPTransport == "" {
		cfg.SIPTransport = "TCP"
	}
	if cfg.SBCPort == 0 {
		cfg.SBCPort = 5060
	}
	if cfg.Domain == "" {
		cfg.Domain = "avaya.com"
	}
}

// Validate checks that a VMConfig has all required fields set and that
// value ranges are sane. It normalises VMRole and SIPTransport to upper case.
func Validate(cfg *VMConfig) error {
	var errs []string

	role := strings.ToUpper(cfg.VMRole)
	if role != "UAC" && role != "UAS" {
		errs = append(errs, fmt.Sprintf("vm_role must be 'UAC' or 'UAS', got %q", cfg.VMRole))
	}

	transport := strings.ToUpper(cfg.SIPTransport)
	if transport != "TCP" && transport != "TLS" && transport != "UDP" {
		errs = append(errs, fmt.Sprintf("sip_transport must be TCP/TLS/UDP, got %q", cfg.SIPTransport))
	}

	if cfg.SBCHost == "" {
		errs = append(errs, "sbc_host is required")
	}

	if cfg.UACExtStart > cfg.UACExtEnd {
		errs = append(errs, fmt.Sprintf("uac_ext_start (%d) > uac_ext_end (%d)", cfg.UACExtStart, cfg.UACExtEnd))
	}
	if cfg.UASExtStart > cfg.UASExtEnd {
		errs = append(errs, fmt.Sprintf("uas_ext_start (%d) > uas_ext_end (%d)", cfg.UASExtStart, cfg.UASExtEnd))
	}

	if cfg.CPS <= 0 {
		errs = append(errs, fmt.Sprintf("cps must be > 0, got %d", cfg.CPS))
	}
	if cfg.HoldTimeSeconds <= 0 {
		errs = append(errs, fmt.Sprintf("hold_time_seconds must be > 0, got %d", cfg.HoldTimeSeconds))
	}
	if cfg.SBCPort <= 0 || cfg.SBCPort > 65535 {
		errs = append(errs, fmt.Sprintf("sbc_port out of range: %d", cfg.SBCPort))
	}

	if cfg.RTPBurstSeconds < 0 {
		errs = append(errs, fmt.Sprintf("rtp_burst_seconds must be >= 0, got %d", cfg.RTPBurstSeconds))
	}
	if cfg.RTPBurstPPS <= 0 {
		errs = append(errs, fmt.Sprintf("rtp_burst_pps must be > 0, got %d", cfg.RTPBurstPPS))
	}
	if cfg.RTPKeepaliveInterval <= 0 {
		errs = append(errs, fmt.Sprintf("rtp_keepalive_interval must be > 0, got %d", cfg.RTPKeepaliveInterval))
	}

	if cfg.RTPMode != "3phase" && cfg.RTPMode != "continuous" {
		errs = append(errs, fmt.Sprintf("rtp_mode must be '3phase' or 'continuous', got %q", cfg.RTPMode))
	}
	if cfg.RTPPtime != 20 && cfg.RTPPtime != 40 {
		errs = append(errs, fmt.Sprintf("rtp_ptime must be 20 or 40, got %d", cfg.RTPPtime))
	}

	if cfg.TrafficMode != "" && cfg.TrafficMode != "smoke" && cfg.TrafficMode != "timed" && cfg.TrafficMode != "unlimited" {
		errs = append(errs, fmt.Sprintf("traffic_mode must be 'smoke', 'timed', or 'unlimited', got %q", cfg.TrafficMode))
	}
	if cfg.TrafficMode == "smoke" && cfg.CallCount <= 0 {
		errs = append(errs, "traffic_mode='smoke' requires call_count > 0")
	}
	if cfg.TrafficMode == "timed" && cfg.DurationHours <= 0 {
		errs = append(errs, "traffic_mode='timed' requires duration_hours > 0")
	}

	if len(errs) > 0 {
		return fmt.Errorf("config: validation failed:\n  %s", strings.Join(errs, "\n  "))
	}

	cfg.VMRole = role
	cfg.SIPTransport = transport

	log.Printf("VMConfig OK | role=%s vm_id=%s sbc=%s:%d transport=%s cps=%d hold=%ds ext=%d-%d concurrent_estimate=%d",
		cfg.VMRole, cfg.VMID, cfg.SBCHost, cfg.SBCPort,
		cfg.SIPTransport, cfg.CPS, cfg.HoldTimeSeconds,
		cfg.UACExtStart, cfg.UACExtEnd, cfg.EffectiveMaxConcurrent())

	return nil
}

// detectLocalIP discovers the machine's preferred outbound IP address by
// opening a UDP connection to a public DNS resolver and reading the local
// address. No actual traffic is sent.
func detectLocalIP() (string, error) {
	conn, err := net.Dial("udp4", "8.8.8.8:80")
	if err != nil {
		return "", err
	}
	defer conn.Close()

	addr := conn.LocalAddr().(*net.UDPAddr)
	return addr.IP.String(), nil
}
