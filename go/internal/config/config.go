// Package config provides VMConfig loading, defaulting, and validation.
// Ported from the Python traffic/config.py module.
package config

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// VMConfig holds all configuration for a single-pool traffic run.
// The dual UAC/UAS role model has been replaced with a unified user pool.
type VMConfig struct {
	VMID      string `yaml:"vm_id" json:"vm_id"`
	ExtStart  int    `yaml:"ext_start" json:"ext_start"`
	ExtEnd    int    `yaml:"ext_end" json:"ext_end"`
	SBCHost   string `yaml:"sbc_host" json:"sbc_host"`
	SBCPort   int    `yaml:"sbc_port" json:"sbc_port"`
	// TODO(failover): SecondaryHost/Port are stored and validated but not yet
	// wired into the engine. When failover_enabled is true, the forking model
	// requires: (1) REGISTER on both primary and secondary during pre-phase,
	// (2) SUBSCRIBE only on primary, (3) on primary failure during traffic run
	// re-SUBSCRIBE to secondary (no re-REGISTER needed).
	SecondaryHost   string `yaml:"secondary_host" json:"secondary_host"`
	SecondaryPort   int    `yaml:"secondary_port" json:"secondary_port"`
	FailoverEnabled bool   `yaml:"failover_enabled" json:"failover_enabled"`
	DNSServers      string `yaml:"dns_servers" json:"dns_servers"`
	SIPTransport    string `yaml:"sip_transport" json:"sip_transport"`
	Domain          string `yaml:"domain" json:"domain"`
	SIPPassword     string `yaml:"sip_password" json:"sip_password"`

	// TLS settings — only consulted when SIPTransport == "TLS".
	// TLSMode controls verification policy and which other fields are required:
	//   "insecure"    → InsecureSkipVerify (lab/testing only)
	//   "server_ca"   → verify SBC cert against TLSCAPath (one-way TLS)
	//   "client_cert" → present client cert+key; verify SBC against system roots
	//   "mutual"      → both: TLSCAPath for server, cert+key for client (mTLS)
	// TLSServerName overrides the SNI / hostname-verification name; leave empty
	// to use SBCHost.
	TLSMode       string `yaml:"tls_mode" json:"tls_mode"`
	TLSCAPath     string `yaml:"tls_ca_path" json:"tls_ca_path"`
	TLSCertPath   string `yaml:"tls_cert_path" json:"tls_cert_path"`
	TLSKeyPath    string `yaml:"tls_key_path" json:"tls_key_path"`
	TLSServerName string `yaml:"tls_server_name" json:"tls_server_name"`

	CPS             int `yaml:"cps" json:"cps"`
	HoldTimeSeconds int `yaml:"hold_time_seconds" json:"hold_time_seconds"`
	RampUpSeconds   int `yaml:"ramp_up_seconds" json:"ramp_up_seconds"`
	MetricsInterval int `yaml:"metrics_interval" json:"metrics_interval"`
	MetricsPort     int `yaml:"metrics_port" json:"metrics_port"`

	RegisterBatchSize    int `yaml:"register_batch_size" json:"register_batch_size"`
	RegisterBatchDelayMs int `yaml:"register_batch_delay_ms" json:"register_batch_delay_ms"`
	RegisterExpires      int `yaml:"register_expires" json:"register_expires"`
	RegisterRetry        int `yaml:"register_retry" json:"register_retry"`
	RegisterTimeout      int `yaml:"register_timeout" json:"register_timeout"`
	SubscribeConcurrency int `yaml:"subscribe_concurrency" json:"subscribe_concurrency"`
	SubscribeExpires     int `yaml:"subscribe_expires" json:"subscribe_expires"`

	// SIP timers (RFC 3261 §17.1.1, INVITE client transaction).
	// Zero means use the RFC default. T1Ms drives Timer A (UDP-only INVITE
	// retransmit interval, doubles each fire). TimerBSeconds is the overall
	// INVITE transaction timeout (RFC default = 64*T1 = 32s).
	T1Ms          int `yaml:"t1_ms" json:"t1_ms"`
	TimerBSeconds int `yaml:"timer_b_seconds" json:"timer_b_seconds"`

	MaxConcurrentCalls int    `yaml:"max_concurrent_calls" json:"max_concurrent_calls"`
	LocalHost          string `yaml:"local_host" json:"local_host"`
	LocalPort          int    `yaml:"local_port" json:"local_port"`

	RTPBurstSeconds      int `yaml:"rtp_burst_seconds" json:"rtp_burst_seconds"`
	RTPBurstPPS          int `yaml:"rtp_burst_pps" json:"rtp_burst_pps"`
	RTPKeepaliveInterval int `yaml:"rtp_keepalive_interval" json:"rtp_keepalive_interval"`
	MediaEnabled         bool   `yaml:"media_enabled" json:"media_enabled"`
	RTPMode              string `yaml:"rtp_mode" json:"rtp_mode"`
	RTPPtime             int    `yaml:"rtp_ptime" json:"rtp_ptime"`
	RTPPcap              bool   `yaml:"rtp_pcap" json:"rtp_pcap"`

	TrafficMode   string  `yaml:"traffic_mode" json:"traffic_mode"`
	CallCount     int     `yaml:"call_count" json:"call_count"`
	DurationHours float64 `yaml:"duration_hours" json:"duration_hours"`

	Scenario                    string  `yaml:"scenario" json:"scenario"`
	ScenarioHoldDurationSeconds float64 `yaml:"scenario_hold_duration_seconds" json:"scenario_hold_duration_seconds"`
	ScenarioPreHoldRTPSeconds   float64 `yaml:"scenario_pre_hold_rtp_seconds" json:"scenario_pre_hold_rtp_seconds"`
	ScenarioPostHoldRTPSeconds  float64 `yaml:"scenario_post_hold_rtp_seconds" json:"scenario_post_hold_rtp_seconds"`

	// QoS / Media metrics (Phase 1 — read-only computation).
	// Pointers so the YAML decoder can distinguish "not set" (default-on)
	// from "explicitly false" (admin opt-out). After ApplyDefaults runs both
	// pointers are non-nil; use the IsQoS* helpers in callers.
	QoSEnabled       *bool `yaml:"qos_enabled,omitempty" json:"qos_enabled,omitempty"`
	QoSMOSEstimation *bool `yaml:"qos_mos_estimation,omitempty" json:"qos_mos_estimation,omitempty"`
}

// IsQoSEnabled reports whether the agent should compute jitter, packet loss,
// and out-of-order metrics. Defaults to true when unset.
func (c *VMConfig) IsQoSEnabled() bool {
	return c.QoSEnabled == nil || *c.QoSEnabled
}

// IsQoSMOSEnabled reports whether MOS estimation should be computed for each
// call. Defaults to true when unset; gated by IsQoSEnabled (no point computing
// MOS without underlying jitter/loss data).
func (c *VMConfig) IsQoSMOSEnabled() bool {
	if !c.IsQoSEnabled() {
		return false
	}
	return c.QoSMOSEstimation == nil || *c.QoSMOSEstimation
}

// ExtCount returns the total number of extensions in the configured range.
func (c *VMConfig) ExtCount() int {
	return c.ExtEnd - c.ExtStart + 1
}

// EffectiveMaxConcurrent returns MaxConcurrentCalls if explicitly set,
// otherwise CPS × HoldTimeSeconds — the theoretical steady-state concurrency.
func (c *VMConfig) EffectiveMaxConcurrent() int {
	if c.MaxConcurrentCalls > 0 {
		return c.MaxConcurrentCalls
	}
	return c.CPS * c.HoldTimeSeconds
}

// BatchDelay returns the inter-batch delay for TCP socket creation and
// REGISTER batches as a time.Duration.
func (c *VMConfig) BatchDelay() time.Duration {
	if c.RegisterBatchDelayMs > 0 {
		return time.Duration(c.RegisterBatchDelayMs) * time.Millisecond
	}
	return 500 * time.Millisecond
}

// BuildResolver returns a custom *net.Resolver using the configured DNS
// servers for FQDN resolution. Returns nil when DNSServers is empty,
// which causes Go to fall back to the system resolver.
func (c *VMConfig) BuildResolver() *net.Resolver {
	if c.DNSServers == "" {
		return nil
	}
	parts := strings.Split(c.DNSServers, ",")
	var servers []string
	for _, s := range parts {
		s = strings.TrimSpace(s)
		if s != "" {
			servers = append(servers, s)
		}
	}
	if len(servers) == 0 {
		return nil
	}
	slog.Info("Using custom DNS resolver", "servers", servers)
	return &net.Resolver{
		PreferGo: true,
		Dial: func(ctx context.Context, network, address string) (net.Conn, error) {
			d := net.Dialer{Timeout: 5 * time.Second}
			for _, srv := range servers {
				addr := net.JoinHostPort(srv, "53")
				conn, err := d.DialContext(ctx, "udp", addr)
				if err == nil {
					return conn, nil
				}
				slog.Debug("DNS server unreachable, trying next", "server", srv, "err", err)
			}
			return nil, fmt.Errorf("all configured DNS servers unreachable: %v", servers)
		},
	}
}

// LoadConfig reads a YAML file, unmarshals it into a VMConfig, applies
// defaults for zero-valued fields, auto-detects LocalHost if empty, and
// validates the result.
func LoadConfig(path string) (*VMConfig, error) {
	slog.Info("Loading config from YAML", "path", path)

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
			slog.Info("Auto-detected local IP", "ip", ip)
		} else {
			slog.Warn("Auto-detect local IP failed", "err", err)
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
	slog.Info("Parsing config from GUI JSON body")

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
			slog.Info("Auto-detected local IP", "ip", ip)
		} else {
			slog.Warn("Auto-detect local IP failed", "err", err)
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
	if cfg.RegisterBatchSize == 0 {
		cfg.RegisterBatchSize = 10
	}
	if cfg.SubscribeConcurrency == 0 {
		cfg.SubscribeConcurrency = 10
	}
	if cfg.RegisterBatchDelayMs == 0 {
		cfg.RegisterBatchDelayMs = 500
	}
	if cfg.RegisterExpires == 0 {
		cfg.RegisterExpires = 3600
	}
	if cfg.SubscribeExpires == 0 {
		cfg.SubscribeExpires = 3600
	}
	if cfg.RegisterRetry == 0 {
		cfg.RegisterRetry = 3
	}
	if cfg.RegisterTimeout == 0 {
		cfg.RegisterTimeout = 5
	}
	if cfg.T1Ms <= 0 {
		cfg.T1Ms = 500
	}
	if cfg.TimerBSeconds <= 0 {
		cfg.TimerBSeconds = 32
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
	// When TLS is selected without an explicit mode, default to insecure to
	// preserve backward compatibility with configs that just say sip_transport: TLS.
	if strings.EqualFold(cfg.SIPTransport, "TLS") && cfg.TLSMode == "" {
		cfg.TLSMode = "insecure"
	}
	if cfg.SBCPort == 0 {
		cfg.SBCPort = 5060
	}
	if cfg.Domain == "" {
		cfg.Domain = "avaya.com"
	}
	// QoS / media metrics default to ON (Phase 1 is zero-risk read-only).
	// Admins can opt out via qos_enabled: false in YAML or via the GUI.
	if cfg.QoSEnabled == nil {
		t := true
		cfg.QoSEnabled = &t
	}
	if cfg.QoSMOSEstimation == nil {
		t := true
		cfg.QoSMOSEstimation = &t
	}
}

// Validate checks that a VMConfig has all required fields set and that
// value ranges are sane. It normalises SIPTransport to upper case.
func Validate(cfg *VMConfig) error {
	var errs []string

	transport := strings.ToUpper(cfg.SIPTransport)
	if transport != "TCP" && transport != "TLS" && transport != "UDP" {
		errs = append(errs, fmt.Sprintf("sip_transport must be TCP/TLS/UDP, got %q", cfg.SIPTransport))
	}

	if transport == "TLS" {
		mode := strings.ToLower(cfg.TLSMode)
		switch mode {
		case "", "insecure":
		case "server_ca":
			if cfg.TLSCAPath == "" {
				errs = append(errs, "tls_ca_path is required when tls_mode=server_ca")
			}
		case "client_cert":
			if cfg.TLSCertPath == "" || cfg.TLSKeyPath == "" {
				errs = append(errs, "tls_cert_path and tls_key_path are required when tls_mode=client_cert")
			}
		case "mutual":
			if cfg.TLSCAPath == "" || cfg.TLSCertPath == "" || cfg.TLSKeyPath == "" {
				errs = append(errs, "tls_ca_path, tls_cert_path and tls_key_path are all required when tls_mode=mutual")
			}
		default:
			errs = append(errs, fmt.Sprintf("tls_mode must be insecure|server_ca|client_cert|mutual, got %q", cfg.TLSMode))
		}
		// File-existence check for any path that was provided
		for _, pathField := range []struct{ name, value string }{
			{"tls_ca_path", cfg.TLSCAPath},
			{"tls_cert_path", cfg.TLSCertPath},
			{"tls_key_path", cfg.TLSKeyPath},
		} {
			if pathField.value == "" {
				continue
			}
			if _, err := os.Stat(pathField.value); err != nil {
				errs = append(errs, fmt.Sprintf("%s %q: %v", pathField.name, pathField.value, err))
			}
		}
	}

	if cfg.SBCHost == "" {
		errs = append(errs, "sbc_host is required")
	}

	if cfg.ExtStart > cfg.ExtEnd {
		errs = append(errs, fmt.Sprintf("ext_start (%d) > ext_end (%d)", cfg.ExtStart, cfg.ExtEnd))
	}
	if cfg.ExtCount() < 2 {
		errs = append(errs, fmt.Sprintf("ext range must have at least 2 extensions, got %d", cfg.ExtCount()))
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

	if cfg.T1Ms < 100 || cfg.T1Ms > 5000 {
		errs = append(errs, fmt.Sprintf("t1_ms must be 100..5000 ms, got %d", cfg.T1Ms))
	}
	if cfg.TimerBSeconds < 1 || cfg.TimerBSeconds > 300 {
		errs = append(errs, fmt.Sprintf("timer_b_seconds must be 1..300 s, got %d", cfg.TimerBSeconds))
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

	cfg.SIPTransport = transport

	slog.Info("VMConfig validated",
		"vm_id", cfg.VMID,
		"primary_host", fmt.Sprintf("%s:%d", cfg.SBCHost, cfg.SBCPort),
		"failover_enabled", cfg.FailoverEnabled,
		"secondary_host", fmt.Sprintf("%s:%d", cfg.SecondaryHost, cfg.SecondaryPort),
		"dns_servers", cfg.DNSServers,
		"transport", cfg.SIPTransport,
		"cps", cfg.CPS,
		"hold_s", cfg.HoldTimeSeconds,
		"ext_range", fmt.Sprintf("%d-%d (%d)", cfg.ExtStart, cfg.ExtEnd, cfg.ExtCount()),
		"concurrent_estimate", cfg.EffectiveMaxConcurrent(),
		"register_expires", cfg.RegisterExpires,
		"subscribe_expires", cfg.SubscribeExpires,
		"register_batch_size", cfg.RegisterBatchSize,
		"subscribe_concurrency", cfg.SubscribeConcurrency,
		"register_batch_delay_ms", cfg.RegisterBatchDelayMs,
		"register_timeout", cfg.RegisterTimeout,
		"rtp_mode", cfg.RTPMode,
		"traffic_mode", cfg.TrafficMode,
	)

	return nil
}

// WriteConfigYAML serialises a VMConfig to a YAML file and returns the
// absolute path written. Directories are created as needed.
func WriteConfigYAML(cfg *VMConfig, path string) (string, error) {
	dir := ""
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		dir = path[:idx]
	}
	if dir != "" {
		os.MkdirAll(dir, 0755)
	}

	data, err := yaml.Marshal(cfg)
	if err != nil {
		return "", fmt.Errorf("config: yaml marshal: %w", err)
	}

	header := fmt.Sprintf("# Auto-generated by GUI\n# %s\n\n",
		time.Now().Format(time.RFC3339))

	f, err := os.Create(path)
	if err != nil {
		return "", fmt.Errorf("config: create %s: %w", path, err)
	}
	defer f.Close()

	f.WriteString(header)
	f.Write(data)

	abs := path
	if !strings.HasPrefix(path, "/") {
		if wd, err := os.Getwd(); err == nil {
			abs = wd + "/" + path
		}
	}
	slog.Info("Config YAML written", "path", abs, "vm_id", cfg.VMID)
	return abs, nil
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
