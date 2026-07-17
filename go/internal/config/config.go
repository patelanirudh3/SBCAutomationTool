// Package config provides VMConfig loading, defaulting, and validation.
// Ported from the Python traffic/config.py module.
package config

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ZoneController identifies a single SBC/controller endpoint within a zone.
type ZoneController struct {
	Host string `yaml:"host" json:"host"`
	Port int    `yaml:"port" json:"port"`
}

// Zone groups one or more controllers that serve a geographic or logical zone.
type Zone struct {
	ZoneID      string           `yaml:"zone_id" json:"zone_id"`
	Controllers []ZoneController `yaml:"controllers" json:"controllers"`
}

// ZoneConfig defines a multi-zone HA topology with cross-zone failover.
// Agents are distributed across zones, and each zone's controllers serve as
// primary for their zone's agents and secondary for the other zone's agents.
type ZoneConfig struct {
	Zones               []Zone `yaml:"zones" json:"zones"`
	ZoneDistributionPct int    `yaml:"zone_distribution_pct" json:"zone_distribution_pct"`
}

// StaticAgentAssignment pins an extension range to explicit primary and
// optional secondary controllers. It is converted into AgentGroupAssignment so
// the existing multi-zone registration/subscription lifecycle remains unchanged.
type StaticAgentAssignment struct {
	ExtStart            int            `yaml:"ext_start" json:"ext_start"`
	ExtEnd              int            `yaml:"ext_end" json:"ext_end"`
	ExtCount            int            `yaml:"ext_count,omitempty" json:"ext_count,omitempty"`
	PrimaryZoneID       string         `yaml:"primary_zone_id" json:"primary_zone_id"`
	PrimaryController   ZoneController `yaml:"primary_controller" json:"primary_controller"`
	SecondaryZoneID     string         `yaml:"secondary_zone_id,omitempty" json:"secondary_zone_id,omitempty"`
	SecondaryController ZoneController `yaml:"secondary_controller,omitempty" json:"secondary_controller,omitempty"`
}

// VMConfig holds all configuration for a single-pool traffic run.
// The dual UAC/UAS role model has been replaced with a unified user pool.
type VMConfig struct {
	VMID     string `yaml:"vm_id" json:"vm_id"`
	ExtStart int    `yaml:"ext_start" json:"ext_start"`
	ExtEnd   int    `yaml:"ext_end" json:"ext_end"`
	SBCHost  string `yaml:"sbc_host" json:"sbc_host"`
	SBCPort  int    `yaml:"sbc_port" json:"sbc_port"`
	// Dual-registration HA: REGISTER on both primary and secondary during
	// pre-phase, SUBSCRIBE only on primary, re-SUBSCRIBE to secondary on
	// primary failure (no re-REGISTER needed). See HAMode for multi-zone.
	SecondaryHost           string                  `yaml:"secondary_host" json:"secondary_host"`
	SecondaryPort           int                     `yaml:"secondary_port" json:"secondary_port"`
	FailoverEnabled         bool                    `yaml:"failover_enabled" json:"failover_enabled"`
	DualRegistrationEnabled bool                    `yaml:"dual_registration_enabled" json:"dual_registration_enabled"`
	FailoverMode            string                  `yaml:"failover_mode" json:"failover_mode"`
	AutoFailbackEnabled     bool                    `yaml:"auto_failback_enabled" json:"auto_failback_enabled"`
	FailbackDelaySeconds    int                     `yaml:"failback_delay_seconds" json:"failback_delay_seconds"`
	FailoverTrigger         string                  `yaml:"failover_trigger" json:"failover_trigger"`
	FailoverTriggerCount    int                     `yaml:"failover_trigger_count" json:"failover_trigger_count"`
	FailoverTriggerPct      int                     `yaml:"failover_trigger_pct" json:"failover_trigger_pct"`
	FailoverTriggerWindowMs int                     `yaml:"failover_trigger_window_ms" json:"failover_trigger_window_ms"`
	HAMode                  string                  `yaml:"ha_mode" json:"ha_mode"`
	ZoneConfig              *ZoneConfig             `yaml:"zone_config,omitempty" json:"zone_config,omitempty"`
	StaticAgentAssignments  []StaticAgentAssignment `yaml:"static_agent_assignments,omitempty" json:"static_agent_assignments,omitempty"`
	DNSServers              string                  `yaml:"dns_servers" json:"dns_servers"`
	SIPTransport            string                  `yaml:"sip_transport" json:"sip_transport"`
	SIPScheme               string                  `yaml:"sip_scheme" json:"sip_scheme"`
	Domain                  string                  `yaml:"domain" json:"domain"`
	SIPPassword             string                  `yaml:"sip_password" json:"sip_password"`

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
	TLSMinVersion string `yaml:"tls_min_version" json:"tls_min_version"`
	TLSMaxVersion string `yaml:"tls_max_version" json:"tls_max_version"`

	CPS             int `yaml:"cps" json:"cps"`
	HoldTimeSeconds int `yaml:"hold_time_seconds" json:"hold_time_seconds"`
	RampUpSeconds   int `yaml:"ramp_up_seconds" json:"ramp_up_seconds"`
	MetricsInterval int `yaml:"metrics_interval" json:"metrics_interval"`
	MetricsPort     int `yaml:"metrics_port" json:"metrics_port"`

	// Deprecated: use AgentConnectionCPS and AgentRegSubCPS. Kept for
	// backward-compatible config parsing only.
	RegisterBatchSize          int      `yaml:"register_batch_size" json:"register_batch_size"`
	AgentConnectionCPS         int      `yaml:"agent_connection_cps" json:"agent_connection_cps"`
	AgentRegSubCPS             int      `yaml:"agent_regsub_cps" json:"agent_regsub_cps"`
	RegisterExpires            int      `yaml:"register_expires" json:"register_expires"`
	RegisterRetry              int      `yaml:"register_retry" json:"register_retry"`
	RegisterTimeout            int      `yaml:"register_timeout" json:"register_timeout"`
	ConnectTimeout             int      `yaml:"connect_timeout" json:"connect_timeout"`
	SubscribeConcurrency       int      `yaml:"subscribe_concurrency" json:"subscribe_concurrency"`
	SubscribeExpires           int      `yaml:"subscribe_expires" json:"subscribe_expires"`
	SubscribeEvent             string   `yaml:"subscribe_event,omitempty" json:"subscribe_event,omitempty"` // legacy single-event alias
	SubscribeEvents            []string `yaml:"subscribe_events" json:"subscribe_events"`
	SubscribeRefreshEvents     []string `yaml:"subscribe_refresh_events" json:"subscribe_refresh_events"`
	SubscribeUnsubscribeEvents []string `yaml:"subscribe_unsubscribe_events" json:"subscribe_unsubscribe_events"`
	// Deprecated: cleanup pacing is controlled by CleanupUnsubscribeRate and
	// CleanupUnregisterRate. Kept for backward-compatible config parsing only.
	CleanupBatchSize           int `yaml:"cleanup_batch_size" json:"cleanup_batch_size"`
	CleanupUnsubscribeRate     int `yaml:"cleanup_unsubscribe_rate_per_sec" json:"cleanup_unsubscribe_rate_per_sec"`
	CleanupUnregisterRate      int `yaml:"cleanup_unregister_rate_per_sec" json:"cleanup_unregister_rate_per_sec"`
	CleanupAuditTimeoutMinutes int `yaml:"cleanup_audit_timeout_minutes" json:"cleanup_audit_timeout_minutes"`

	// SIP timers (RFC 3261 §17.1.1, INVITE client transaction).
	// Zero means use the RFC default. T1Ms drives Timer A (UDP-only INVITE
	// retransmit interval, doubles each fire). TimerBSeconds is the overall
	// INVITE transaction timeout (RFC default = 64*T1 = 32s).
	T1Ms          int `yaml:"t1_ms" json:"t1_ms"`
	TimerBSeconds int `yaml:"timer_b_seconds" json:"timer_b_seconds"`

	MaxConcurrentCalls int    `yaml:"max_concurrent_calls" json:"max_concurrent_calls"`
	LocalHost          string `yaml:"local_host" json:"local_host"`
	LocalPort          int    `yaml:"local_port" json:"local_port"`
	LocalIPMode        string `yaml:"local_ip_mode" json:"local_ip_mode"`
	VIPInterface       string `yaml:"vip_interface" json:"vip_interface"`
	VIPCIDR            string `yaml:"vip_cidr" json:"vip_cidr"`
	VIPFirstIP         string `yaml:"vip_first_ip" json:"vip_first_ip"`
	VIPCount           int    `yaml:"vip_count" json:"vip_count"`

	RTPBurstSeconds             int      `yaml:"rtp_burst_seconds" json:"rtp_burst_seconds"`
	RTPBurstPPS                 int      `yaml:"rtp_burst_pps" json:"rtp_burst_pps"`
	RTPKeepaliveInterval        int      `yaml:"rtp_keepalive_interval" json:"rtp_keepalive_interval"`
	MediaEnabled                bool     `yaml:"media_enabled" json:"media_enabled"`
	MediaSecurity               string   `yaml:"media_security" json:"media_security"` // "rtp" | "srtp_sdes"
	SRTPCryptoSuites            []string `yaml:"srtp_crypto_suites" json:"srtp_crypto_suites"`
	SRTPKeyMode                 string   `yaml:"srtp_key_mode" json:"srtp_key_mode"` // "auto"
	RTPCodec                    string   `yaml:"rtp_codec" json:"rtp_codec"`
	RTPUnsupportedCodecPolicy   string   `yaml:"rtp_unsupported_codec_policy" json:"rtp_unsupported_codec_policy"`
	RTPMode                     string   `yaml:"rtp_mode" json:"rtp_mode"`
	RTPPtime                    int      `yaml:"rtp_ptime" json:"rtp_ptime"`
	RTPPcap                     bool     `yaml:"rtp_pcap" json:"rtp_pcap"`
	RTPMediaCoveragePct         int      `yaml:"rtp_media_coverage_pct" json:"rtp_media_coverage_pct"`
	RTPStartBurstSharePct       int      `yaml:"rtp_start_burst_share_pct" json:"rtp_start_burst_share_pct"`
	RTPEndBurstSharePct         int      `yaml:"rtp_end_burst_share_pct" json:"rtp_end_burst_share_pct"`
	RTPMidBurstSeconds          int      `yaml:"rtp_mid_burst_seconds" json:"rtp_mid_burst_seconds"`
	RTPCoverageKeepaliveEnabled *bool    `yaml:"rtp_coverage_keepalive_enabled,omitempty" json:"rtp_coverage_keepalive_enabled,omitempty"`
	RTPCoverageKeepalivePPS     int      `yaml:"rtp_coverage_keepalive_pps" json:"rtp_coverage_keepalive_pps"`

	TrafficMode   string  `yaml:"traffic_mode" json:"traffic_mode"`
	CallCount     int     `yaml:"call_count" json:"call_count"`
	DurationHours float64 `yaml:"duration_hours" json:"duration_hours"`
	PairingPolicy string  `yaml:"pairing_policy" json:"pairing_policy"`

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

	// RTCP Sender Report transmission (Phase 2 — high risk, default OFF).
	// When RTCPSREnabled is true the RTP endpoint sends RTCP SR packets on
	// the same UDP socket as RTP every RTCPSRIntervalSeconds, and SDP
	// advertises a=rtcp-mux. Enable only when the SBC is known to support
	// RTCP-mux (RFC 5761) — otherwise the SBC may drop the call.
	//
	// RTCPMuxEnabled is auto-coerced to true by ApplyDefaults whenever
	// RTCPSREnabled is true; the combination "SR enabled, mux disabled" is
	// rejected by Validate as an unsafe configuration footgun.
	RTCPSREnabled         *bool `yaml:"rtcp_sr_enabled,omitempty" json:"rtcp_sr_enabled,omitempty"`
	RTCPSRIntervalSeconds int   `yaml:"rtcp_sr_interval_seconds,omitempty" json:"rtcp_sr_interval_seconds,omitempty"`
	RTCPMuxEnabled        *bool `yaml:"rtcp_mux_enabled,omitempty" json:"rtcp_mux_enabled,omitempty"`
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

// IsRTCPSREnabled reports whether the RTP endpoint should transmit RTCP
// Sender Reports. Defaults to FALSE when unset (Phase 2 risky feature must
// be opted-in explicitly).
func (c *VMConfig) IsRTCPSREnabled() bool {
	return c.RTCPSREnabled != nil && *c.RTCPSREnabled
}

// IsRTCPMuxEnabled reports whether SDP should advertise a=rtcp-mux.
// Defaults to FALSE when unset; auto-coerced to true by ApplyDefaults
// whenever IsRTCPSREnabled is true (you cannot safely send RTCP on the
// RTP socket without negotiating mux).
func (c *VMConfig) IsRTCPMuxEnabled() bool {
	return c.RTCPMuxEnabled != nil && *c.RTCPMuxEnabled
}

// IsRTPCoverageKeepaliveEnabled reports whether 3phase_coverage should emit
// low-rate RTP during idle gaps between full-rate coverage bursts.
func (c *VMConfig) IsRTPCoverageKeepaliveEnabled() bool {
	return c.RTPCoverageKeepaliveEnabled == nil || *c.RTPCoverageKeepaliveEnabled
}

func (c *VMConfig) IsSRTPSDESEnabled() bool {
	return strings.EqualFold(c.MediaSecurity, "srtp_sdes")
}

func (c *VMConfig) URIScheme() string {
	if strings.EqualFold(c.SIPScheme, "SIPS") {
		return "sips"
	}
	return "sip"
}

// EffectiveMaxConcurrent returns MaxConcurrentCalls if explicitly set,
// otherwise CPS × HoldTimeSeconds — the theoretical steady-state concurrency.
func (c *VMConfig) EffectiveMaxConcurrent() int {
	if c.MaxConcurrentCalls > 0 {
		return c.MaxConcurrentCalls
	}
	return c.CPS * c.HoldTimeSeconds
}

// ExtCount returns the number of configured extensions in the unified pool.
func (c *VMConfig) ExtCount() int {
	if len(c.StaticAgentAssignments) > 0 {
		total := 0
		for _, row := range c.StaticAgentAssignments {
			start, end := normalizedAssignmentRange(row)
			if start > 0 && end >= start {
				total += end - start + 1
			}
		}
		return total
	}
	if c.ExtEnd < c.ExtStart {
		return 0
	}
	return c.ExtEnd - c.ExtStart + 1
}

// GenerateVIPs returns the configured VIP range as a list of IPv4 strings.
func (c *VMConfig) GenerateVIPs() ([]string, error) {
	if c.LocalIPMode == "" || c.LocalIPMode == "single" {
		return nil, nil
	}
	if c.VIPCount <= 0 {
		return nil, fmt.Errorf("vip_count must be > 0")
	}
	first := net.ParseIP(strings.TrimSpace(c.VIPFirstIP)).To4()
	if first == nil {
		return nil, fmt.Errorf("vip_first_ip must be a valid IPv4 address")
	}
	_, ipNet, err := net.ParseCIDR(strings.TrimSpace(c.VIPCIDR))
	if err != nil {
		return nil, fmt.Errorf("vip_cidr must be a valid CIDR: %w", err)
	}
	out := make([]string, 0, c.VIPCount)
	cur := ipv4ToUint32(first)
	for i := 0; i < c.VIPCount; i++ {
		ip := uint32ToIPv4(cur + uint32(i))
		if !ipNet.Contains(ip) {
			return nil, fmt.Errorf("VIP range exceeds vip_cidr at %s", ip.String())
		}
		out = append(out, ip.String())
	}
	return out, nil
}

// LocalHostForExtension returns the source IP assigned to extension ext.
func (c *VMConfig) LocalHostForExtension(ext string) string {
	mode := strings.TrimSpace(c.LocalIPMode)
	if mode == "" || mode == "single" {
		return c.LocalHost
	}
	vips, err := c.GenerateVIPs()
	if err != nil || len(vips) == 0 {
		return c.LocalHost
	}
	extNum, err := strconv.Atoi(ext)
	if err != nil {
		return vips[0]
	}
	idx := c.extensionPosition(extNum)
	if idx < 0 {
		idx = 0
	}
	if mode == "unique_vip" {
		if idx >= len(vips) {
			return c.LocalHost
		}
		return vips[idx]
	}
	return vips[idx%len(vips)]
}

func (c *VMConfig) extensionPosition(extNum int) int {
	if len(c.StaticAgentAssignments) == 0 {
		return extNum - c.ExtStart
	}
	pos := 0
	for _, row := range c.StaticAgentAssignments {
		start, end := normalizedAssignmentRange(row)
		if start <= 0 || end < start {
			continue
		}
		if extNum >= start && extNum <= end {
			return pos + (extNum - start)
		}
		pos += end - start + 1
	}
	return -1
}

func normalizedAssignmentRange(row StaticAgentAssignment) (int, int) {
	end := row.ExtEnd
	if end == 0 && row.ExtCount > 0 {
		end = row.ExtStart + row.ExtCount - 1
	}
	return row.ExtStart, end
}

func ipv4ToUint32(ip net.IP) uint32 {
	v := ip.To4()
	return uint32(v[0])<<24 | uint32(v[1])<<16 | uint32(v[2])<<8 | uint32(v[3])
}

func uint32ToIPv4(v uint32) net.IP {
	return net.IPv4(byte(v>>24), byte(v>>16), byte(v>>8), byte(v))
}

func (c *VMConfig) EffectiveAgentConnectionCPS() int {
	if c.AgentConnectionCPS > 0 {
		return c.AgentConnectionCPS
	}
	return 30
}

func (c *VMConfig) EffectiveAgentRegSubCPS() int {
	if c.AgentRegSubCPS > 0 {
		return c.AgentRegSubCPS
	}
	return 30
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
	if cfg.PairingPolicy == "" {
		cfg.PairingPolicy = "random"
	}
	if cfg.RegisterBatchSize == 0 {
		cfg.RegisterBatchSize = 10
	}
	if cfg.AgentConnectionCPS == 0 {
		cfg.AgentConnectionCPS = 30
	}
	if cfg.AgentRegSubCPS == 0 {
		cfg.AgentRegSubCPS = 30
	}
	if cfg.SubscribeConcurrency == 0 {
		cfg.SubscribeConcurrency = 10
	}
	if cfg.RegisterExpires == 0 {
		cfg.RegisterExpires = 3600
	}
	if cfg.SubscribeExpires == 0 {
		cfg.SubscribeExpires = 3600
	}
	cfg.SubscribeEvents = normalizeSubscribeEvents(cfg.SubscribeEvents, cfg.SubscribeEvent)
	if cfg.SubscribeRefreshEvents == nil {
		cfg.SubscribeRefreshEvents = defaultSubscribePolicyEvents(cfg.SubscribeEvents, func(p SubscribeEventPolicy) bool { return p.Refresh })
	} else {
		cfg.SubscribeRefreshEvents = normalizeExplicitSubscribeEvents(cfg.SubscribeRefreshEvents)
	}
	if cfg.SubscribeUnsubscribeEvents == nil {
		cfg.SubscribeUnsubscribeEvents = defaultSubscribePolicyEvents(cfg.SubscribeEvents, func(p SubscribeEventPolicy) bool { return p.Unsubscribe })
	} else {
		cfg.SubscribeUnsubscribeEvents = normalizeExplicitSubscribeEvents(cfg.SubscribeUnsubscribeEvents)
	}
	if len(cfg.SubscribeEvents) == 1 {
		cfg.SubscribeEvent = cfg.SubscribeEvents[0]
	}
	if cfg.RegisterRetry == 0 {
		cfg.RegisterRetry = 3
	}
	if cfg.RegisterTimeout == 0 {
		cfg.RegisterTimeout = 5
	}
	if cfg.ConnectTimeout == 0 {
		cfg.ConnectTimeout = 5
	}
	if cfg.CleanupUnsubscribeRate == 0 {
		cfg.CleanupUnsubscribeRate = 20
	}
	if cfg.CleanupUnregisterRate == 0 {
		cfg.CleanupUnregisterRate = 20
	}
	if cfg.CleanupAuditTimeoutMinutes == 0 {
		cfg.CleanupAuditTimeoutMinutes = 30
	}
	if cfg.FailbackDelaySeconds == 0 {
		cfg.FailbackDelaySeconds = 30
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
	if cfg.SIPScheme == "" {
		cfg.SIPScheme = "SIP"
	}
	if cfg.MediaSecurity == "" {
		cfg.MediaSecurity = "rtp"
	}
	if len(cfg.SRTPCryptoSuites) == 0 {
		cfg.SRTPCryptoSuites = []string{"AES_CM_128_HMAC_SHA1_80"}
	}
	if cfg.SRTPKeyMode == "" {
		cfg.SRTPKeyMode = "auto"
	}
	if cfg.RTPCodec == "" {
		cfg.RTPCodec = "G711_ULAW"
	}
	if cfg.RTPUnsupportedCodecPolicy == "" {
		cfg.RTPUnsupportedCodecPolicy = "fallback_g711"
	}
	if cfg.RTPMediaCoveragePct == 0 {
		cfg.RTPMediaCoveragePct = 25
	}
	if cfg.RTPStartBurstSharePct == 0 {
		cfg.RTPStartBurstSharePct = 20
	}
	if cfg.RTPEndBurstSharePct == 0 {
		cfg.RTPEndBurstSharePct = 20
	}
	if cfg.RTPMidBurstSeconds == 0 {
		cfg.RTPMidBurstSeconds = 3
	}
	if cfg.RTPCoverageKeepaliveEnabled == nil {
		t := true
		cfg.RTPCoverageKeepaliveEnabled = &t
	}
	if cfg.RTPCoverageKeepalivePPS == 0 {
		cfg.RTPCoverageKeepalivePPS = 3
	}
	if cfg.Scenario == "" {
		cfg.Scenario = "basic_call"
	}
	if cfg.SIPTransport == "" {
		cfg.SIPTransport = "TCP"
	}
	if cfg.FailoverMode == "" {
		cfg.FailoverMode = "graceful"
	}
	if cfg.FailoverTrigger == "" {
		cfg.FailoverTrigger = "per_agent"
	}
	if cfg.FailoverTriggerCount == 0 {
		cfg.FailoverTriggerCount = 5
	}
	if cfg.FailoverTriggerPct == 0 {
		cfg.FailoverTriggerPct = 20
	}
	if cfg.FailoverTriggerWindowMs == 0 {
		cfg.FailoverTriggerWindowMs = 1000
	}
	if cfg.HAMode == "" {
		if cfg.DualRegistrationEnabled {
			cfg.HAMode = "dual"
		} else if cfg.ZoneConfig != nil && len(cfg.ZoneConfig.Zones) > 0 {
			cfg.HAMode = "multi_zone"
		} else {
			cfg.HAMode = "single"
		}
	}
	if cfg.ZoneConfig != nil && cfg.ZoneConfig.ZoneDistributionPct == 0 {
		cfg.ZoneConfig.ZoneDistributionPct = 50
	}
	if cfg.LocalIPMode == "" {
		cfg.LocalIPMode = "single"
	}
	// When TLS is selected without an explicit mode, default to insecure to
	// preserve backward compatibility with configs that just say sip_transport: TLS.
	if strings.EqualFold(cfg.SIPTransport, "TLS") && cfg.TLSMode == "" {
		cfg.TLSMode = "insecure"
	}
	if cfg.TLSMinVersion == "" {
		cfg.TLSMinVersion = "1.2"
	}
	if cfg.TLSMaxVersion == "" {
		cfg.TLSMaxVersion = "auto"
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
	// RTCP SR transmission defaults to OFF (Phase 2 — risky, opt-in only).
	// Auto-coerce mux to ON when SR is enabled so the SDP correctly
	// advertises a=rtcp-mux for the same-port RTCP traffic.
	if cfg.RTCPSREnabled == nil {
		f := false
		cfg.RTCPSREnabled = &f
	}
	if cfg.RTCPMuxEnabled == nil {
		// Default to whatever SR is set to: enabling SR without mux is
		// always wrong (rejected by Validate); enabling mux without SR
		// is meaningless on its own.
		v := *cfg.RTCPSREnabled
		cfg.RTCPMuxEnabled = &v
	} else if *cfg.RTCPSREnabled && !*cfg.RTCPMuxEnabled {
		// Admin opted into SR but forgot mux — coerce on, with a warning.
		t := true
		cfg.RTCPMuxEnabled = &t
		slog.Warn("rtcp_mux_enabled coerced to true because rtcp_sr_enabled=true",
			"reason", "RTCP SR on the RTP socket requires RFC 5761 mux")
	}
	if cfg.RTCPSRIntervalSeconds == 0 {
		cfg.RTCPSRIntervalSeconds = 5
	}
}

// SubscribeEventPolicy describes the RFC 6665 behavior the engine applies to a
// supported event package. The GUI mirrors this table so operators can see the
// refresh/unsubscribe policy before starting registration.
type SubscribeEventPolicy struct {
	Event       string `json:"event"`
	Label       string `json:"label"`
	ServerGroup string `json:"server_group"`
	Refresh     bool   `json:"refresh"`
	Unsubscribe bool   `json:"unsubscribe"`
	Accept      string `json:"accept,omitempty"`
}

var subscribeEventPolicies = map[string]SubscribeEventPolicy{
	"avaya-cm-feature-status": {
		Event: "avaya-cm-feature-status", Label: "CM Feature Status", ServerGroup: "Avaya CM", Refresh: true, Unsubscribe: true,
	},
	"avaya-cm-cc-info": {
		Event: "avaya-cm-cc-info", Label: "CM CC Info", ServerGroup: "Avaya CM", Refresh: true, Unsubscribe: true,
	},
	"dialog": {
		Event: "dialog", Label: "Dialog", ServerGroup: "RFC", Refresh: true, Unsubscribe: true, Accept: "application/dialog-info+xml",
	},
	"avaya-ccs-profile": {
		Event: "avaya-ccs-profile", Label: "CCS Profile", ServerGroup: "Avaya CCS", Refresh: true, Unsubscribe: true,
	},
	"reg": {
		Event: "reg", Label: "Registration", ServerGroup: "RFC", Refresh: true, Unsubscribe: true,
	},
	"message-summary": {
		Event: "message-summary", Label: "Message Summary", ServerGroup: "RFC", Refresh: true, Unsubscribe: true,
	},
}

// SubscribeEventPolicyFor returns the policy for a normalized event package.
func SubscribeEventPolicyFor(event string) (SubscribeEventPolicy, bool) {
	p, ok := subscribeEventPolicies[strings.ToLower(strings.TrimSpace(event))]
	return p, ok
}

// SubscribeEventPolicies returns policies in the GUI display order.
func SubscribeEventPolicies() []SubscribeEventPolicy {
	events := []string{
		"avaya-cm-feature-status",
		"avaya-cm-cc-info",
		"dialog",
		"avaya-ccs-profile",
		"reg",
		"message-summary",
	}
	out := make([]SubscribeEventPolicy, 0, len(events))
	for _, event := range events {
		out = append(out, subscribeEventPolicies[event])
	}
	return out
}

func normalizeSubscribeEvents(events []string, legacy string) []string {
	if len(events) == 0 && legacy != "" {
		events = []string{legacy}
	}
	if len(events) == 0 {
		events = []string{"dialog"}
	}

	seen := make(map[string]struct{}, len(events))
	out := make([]string, 0, len(events))
	for _, event := range events {
		event = strings.ToLower(strings.TrimSpace(event))
		if event == "" {
			continue
		}
		if _, dup := seen[event]; dup {
			continue
		}
		seen[event] = struct{}{}
		out = append(out, event)
	}
	if len(out) == 0 {
		return []string{"dialog"}
	}
	return out
}

func normalizeExplicitSubscribeEvents(events []string) []string {
	seen := make(map[string]struct{}, len(events))
	out := make([]string, 0, len(events))
	for _, event := range events {
		event = strings.ToLower(strings.TrimSpace(event))
		if event == "" {
			continue
		}
		if _, dup := seen[event]; dup {
			continue
		}
		seen[event] = struct{}{}
		out = append(out, event)
	}
	return out
}

func defaultSubscribePolicyEvents(selected []string, enabled func(SubscribeEventPolicy) bool) []string {
	out := make([]string, 0, len(selected))
	for _, event := range selected {
		policy, ok := SubscribeEventPolicyFor(event)
		if ok && enabled(policy) {
			out = append(out, policy.Event)
		}
	}
	return out
}

func containsSubscribeEvent(events []string, event string) bool {
	event = strings.ToLower(strings.TrimSpace(event))
	for _, candidate := range events {
		if strings.EqualFold(candidate, event) {
			return true
		}
	}
	return false
}

// ShouldRefreshSubscribeEvent reports whether admin policy enables refresh for
// the specified event package.
func (cfg *VMConfig) ShouldRefreshSubscribeEvent(event string) bool {
	return containsSubscribeEvent(cfg.SubscribeRefreshEvents, event)
}

// ShouldUnsubscribeSubscribeEvent reports whether admin policy enables
// SUBSCRIBE Expires:0 cleanup for the specified event package.
func (cfg *VMConfig) ShouldUnsubscribeSubscribeEvent(event string) bool {
	return containsSubscribeEvent(cfg.SubscribeUnsubscribeEvents, event)
}

// NonInviteTransactionTimeout returns the RFC 3261 Timer F duration for
// non-INVITE client transactions (REGISTER/SUBSCRIBE class): 64*T1.
func (cfg *VMConfig) NonInviteTransactionTimeout() time.Duration {
	t1 := cfg.T1Ms
	if t1 <= 0 {
		t1 = 500
	}
	return time.Duration(64*t1) * time.Millisecond
}

// Validate checks that a VMConfig has all required fields set and that
// value ranges are sane. It normalises SIPTransport to upper case.
func Validate(cfg *VMConfig) error {
	var errs []string

	transport := strings.ToUpper(cfg.SIPTransport)
	if transport != "TCP" && transport != "TLS" && transport != "UDP" {
		errs = append(errs, fmt.Sprintf("sip_transport must be TCP/TLS/UDP, got %q", cfg.SIPTransport))
	}
	scheme := strings.ToUpper(cfg.SIPScheme)
	if scheme != "SIP" && scheme != "SIPS" {
		errs = append(errs, fmt.Sprintf("sip_scheme must be SIP or SIPS, got %q", cfg.SIPScheme))
	}
	if scheme == "SIPS" && transport != "TLS" {
		errs = append(errs, "sip_scheme=SIPS requires sip_transport=TLS")
	}

	if transport == "TLS" {
		mode := strings.ToLower(cfg.TLSMode)
		minTLS, minOK := parseTLSVersionName(cfg.TLSMinVersion)
		maxTLS, maxOK := parseTLSMaxVersionName(cfg.TLSMaxVersion)
		if !minOK {
			errs = append(errs, fmt.Sprintf("tls_min_version must be 1.2 or 1.3, got %q", cfg.TLSMinVersion))
		}
		if !maxOK {
			errs = append(errs, fmt.Sprintf("tls_max_version must be auto, 1.2, or 1.3, got %q", cfg.TLSMaxVersion))
		}
		if minOK && maxOK && maxTLS != 0 && maxTLS < minTLS {
			errs = append(errs, "tls_max_version cannot be lower than tls_min_version")
		}
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
	cfg.FailoverMode = strings.ToLower(strings.TrimSpace(cfg.FailoverMode))
	if cfg.FailoverMode == "" {
		cfg.FailoverMode = "graceful"
	}
	if cfg.FailoverMode != "graceful" && cfg.FailoverMode != "force" {
		errs = append(errs, fmt.Sprintf("failover_mode must be 'graceful' or 'force', got %q", cfg.FailoverMode))
	}
	cfg.FailoverTrigger = strings.ToLower(strings.TrimSpace(cfg.FailoverTrigger))
	switch cfg.FailoverTrigger {
	case "per_agent":
	case "min_agents":
		if cfg.FailoverTriggerCount < 2 || cfg.FailoverTriggerCount > 10000 {
			errs = append(errs, fmt.Sprintf("failover_trigger_count must be 2..10000 when trigger=min_agents, got %d", cfg.FailoverTriggerCount))
		}
		if cfg.FailoverTriggerWindowMs < 100 || cfg.FailoverTriggerWindowMs > 60000 {
			errs = append(errs, fmt.Sprintf("failover_trigger_window_ms must be 100..60000 when trigger=min_agents, got %d", cfg.FailoverTriggerWindowMs))
		}
	case "pct_agents":
		if cfg.FailoverTriggerPct < 1 || cfg.FailoverTriggerPct > 100 {
			errs = append(errs, fmt.Sprintf("failover_trigger_pct must be 1..100 when trigger=pct_agents, got %d", cfg.FailoverTriggerPct))
		}
		if cfg.FailoverTriggerWindowMs < 100 || cfg.FailoverTriggerWindowMs > 60000 {
			errs = append(errs, fmt.Sprintf("failover_trigger_window_ms must be 100..60000 when trigger=pct_agents, got %d", cfg.FailoverTriggerWindowMs))
		}
	default:
		errs = append(errs, fmt.Sprintf("failover_trigger must be 'per_agent', 'min_agents', or 'pct_agents', got %q", cfg.FailoverTrigger))
	}
	if cfg.DualRegistrationEnabled {
		cfg.FailoverEnabled = true
		if strings.TrimSpace(cfg.SecondaryHost) == "" {
			errs = append(errs, "secondary_host is required when dual_registration_enabled=true")
		}
		if cfg.SecondaryPort <= 0 || cfg.SecondaryPort > 65535 {
			errs = append(errs, fmt.Sprintf("secondary_port out of range when dual_registration_enabled=true: %d", cfg.SecondaryPort))
		}
	}

	cfg.HAMode = strings.ToLower(strings.TrimSpace(cfg.HAMode))
	switch cfg.HAMode {
	case "single":
	case "dual":
		cfg.DualRegistrationEnabled = true
		cfg.FailoverEnabled = true
	case "multi_zone":
		cfg.FailoverEnabled = true
		if cfg.ZoneConfig == nil || len(cfg.ZoneConfig.Zones) == 0 {
			errs = append(errs, "zone_config with at least one zone is required when ha_mode=multi_zone")
		} else {
			if len(cfg.ZoneConfig.Zones) > 2 {
				errs = append(errs, fmt.Sprintf("multi_zone supports 1 or 2 zones, got %d", len(cfg.ZoneConfig.Zones)))
			}
			for zi, z := range cfg.ZoneConfig.Zones {
				if strings.TrimSpace(z.ZoneID) == "" {
					errs = append(errs, fmt.Sprintf("zone[%d].zone_id is required", zi))
				}
				if len(z.Controllers) == 0 {
					errs = append(errs, fmt.Sprintf("zone[%d] (%s) must have at least 1 controller", zi, z.ZoneID))
				}
				for ci, c := range z.Controllers {
					if strings.TrimSpace(c.Host) == "" {
						errs = append(errs, fmt.Sprintf("zone[%d].controllers[%d].host is required", zi, ci))
					}
					if c.Port <= 0 || c.Port > 65535 {
						errs = append(errs, fmt.Sprintf("zone[%d].controllers[%d].port out of range: %d", zi, ci, c.Port))
					}
				}
			}
			pct := cfg.ZoneConfig.ZoneDistributionPct
			if len(cfg.ZoneConfig.Zones) == 2 && (pct < 1 || pct > 99) {
				errs = append(errs, fmt.Sprintf("zone_distribution_pct must be 1..99, got %d", pct))
			}
			totalAgents := cfg.ExtCount()
			totalControllers := 0
			for _, z := range cfg.ZoneConfig.Zones {
				totalControllers += len(z.Controllers)
			}
			if len(cfg.StaticAgentAssignments) > 0 {
				errs = append(errs, cfg.validateStaticAgentAssignments()...)
			} else if totalAgents < totalControllers*2 {
				errs = append(errs, fmt.Sprintf("need at least %d agents for %d controllers (2 per controller minimum), got %d", totalControllers*2, totalControllers, totalAgents))
			}
		}
	default:
		if cfg.HAMode != "" {
			errs = append(errs, fmt.Sprintf("ha_mode must be 'single', 'dual', or 'multi_zone', got %q", cfg.HAMode))
		}
	}
	if cfg.HAMode == "multi_zone" {
		slog.Warn("multi_zone uses zone_config controllers for agent assignment; flat sbc_host/secondary_host are ignored for primary/secondary pairing",
			"sbc_host", cfg.SBCHost,
			"sbc_port", cfg.SBCPort,
			"secondary_host", cfg.SecondaryHost,
			"secondary_port", cfg.SecondaryPort)
	}
	if len(cfg.StaticAgentAssignments) > 0 {
		cfg.deriveGlobalExtensionBoundsFromStaticAssignments()
	}

	if cfg.ExtStart > cfg.ExtEnd {
		errs = append(errs, fmt.Sprintf("ext_start (%d) > ext_end (%d)", cfg.ExtStart, cfg.ExtEnd))
	}
	if cfg.ExtCount() < 2 {
		errs = append(errs, fmt.Sprintf("ext range must have at least 2 extensions, got %d", cfg.ExtCount()))
	}

	cfg.LocalIPMode = strings.ToLower(strings.TrimSpace(cfg.LocalIPMode))
	if cfg.LocalIPMode == "" {
		cfg.LocalIPMode = "single"
	}
	switch cfg.LocalIPMode {
	case "single":
	case "unique_vip", "vip_pool":
		if strings.TrimSpace(cfg.VIPInterface) == "" {
			errs = append(errs, "vip_interface is required when local_ip_mode uses VIPs")
		}
		if strings.TrimSpace(cfg.VIPCIDR) == "" {
			errs = append(errs, "vip_cidr is required when local_ip_mode uses VIPs")
		}
		if strings.TrimSpace(cfg.VIPFirstIP) == "" {
			errs = append(errs, "vip_first_ip is required when local_ip_mode uses VIPs")
		}
		if cfg.VIPCount <= 0 {
			errs = append(errs, "vip_count must be > 0 when local_ip_mode uses VIPs")
		}
		if cfg.LocalIPMode == "unique_vip" && cfg.VIPCount < cfg.ExtCount() {
			errs = append(errs, fmt.Sprintf("unique_vip requires vip_count >= extension count (%d), got %d", cfg.ExtCount(), cfg.VIPCount))
		}
		if _, err := cfg.GenerateVIPs(); err != nil {
			errs = append(errs, err.Error())
		}
	default:
		errs = append(errs, fmt.Sprintf("local_ip_mode must be 'single', 'unique_vip', or 'vip_pool', got %q", cfg.LocalIPMode))
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
	if cfg.AgentConnectionCPS < 1 || cfg.AgentConnectionCPS > 500 {
		errs = append(errs, fmt.Sprintf("agent_connection_cps must be 1..500, got %d", cfg.AgentConnectionCPS))
	}
	if cfg.AgentRegSubCPS < 1 || cfg.AgentRegSubCPS > 500 {
		errs = append(errs, fmt.Sprintf("agent_regsub_cps must be 1..500, got %d", cfg.AgentRegSubCPS))
	}
	if cfg.CleanupUnsubscribeRate < 1 || cfg.CleanupUnsubscribeRate > 500 {
		errs = append(errs, fmt.Sprintf("cleanup_unsubscribe_rate_per_sec must be 1..500, got %d", cfg.CleanupUnsubscribeRate))
	}
	if cfg.CleanupUnregisterRate < 1 || cfg.CleanupUnregisterRate > 500 {
		errs = append(errs, fmt.Sprintf("cleanup_unregister_rate_per_sec must be 1..500, got %d", cfg.CleanupUnregisterRate))
	}
	if cfg.RegisterBatchSize != 10 {
		slog.Warn("register_batch_size is deprecated and ignored for setup pacing; use agent_connection_cps and agent_regsub_cps",
			"register_batch_size", cfg.RegisterBatchSize,
			"agent_connection_cps", cfg.AgentConnectionCPS,
			"agent_regsub_cps", cfg.AgentRegSubCPS)
	}

	if cfg.T1Ms < 100 || cfg.T1Ms > 5000 {
		errs = append(errs, fmt.Sprintf("t1_ms must be 100..5000 ms, got %d", cfg.T1Ms))
	}
	if cfg.TimerBSeconds < 1 || cfg.TimerBSeconds > 300 {
		errs = append(errs, fmt.Sprintf("timer_b_seconds must be 1..300 s, got %d", cfg.TimerBSeconds))
	}
	if cfg.FailbackDelaySeconds < 1 || cfg.FailbackDelaySeconds > 3600 {
		errs = append(errs, fmt.Sprintf("failback_delay_seconds must be 1..3600 s, got %d", cfg.FailbackDelaySeconds))
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

	if cfg.RTPMode != "3phase" && cfg.RTPMode != "continuous" && cfg.RTPMode != "3phase_coverage" {
		errs = append(errs, fmt.Sprintf("rtp_mode must be '3phase', '3phase_coverage', or 'continuous', got %q", cfg.RTPMode))
	}
	cfg.RTPCodec = strings.ToUpper(strings.TrimSpace(cfg.RTPCodec))
	if cfg.RTPCodec == "" {
		cfg.RTPCodec = "G711_ULAW"
	}
	switch cfg.RTPCodec {
	case "G711_ULAW", "G711_ALAW", "G729", "G729_AUDIO":
	default:
		errs = append(errs, fmt.Sprintf("rtp_codec must be 'G711_ULAW', 'G711_ALAW', 'G729', or 'G729_AUDIO', got %q", cfg.RTPCodec))
	}
	cfg.RTPUnsupportedCodecPolicy = strings.ToLower(strings.TrimSpace(cfg.RTPUnsupportedCodecPolicy))
	if cfg.RTPUnsupportedCodecPolicy == "" {
		cfg.RTPUnsupportedCodecPolicy = "fallback_g711"
	}
	switch cfg.RTPUnsupportedCodecPolicy {
	case "fallback_g711", "reject_488":
	default:
		errs = append(errs, fmt.Sprintf("rtp_unsupported_codec_policy must be 'fallback_g711' or 'reject_488', got %q", cfg.RTPUnsupportedCodecPolicy))
	}
	if cfg.RTPPtime != 20 && cfg.RTPPtime != 40 {
		errs = append(errs, fmt.Sprintf("rtp_ptime must be 20 or 40, got %d", cfg.RTPPtime))
	}
	switch cfg.MediaSecurity {
	case "rtp", "srtp_sdes":
	default:
		errs = append(errs, fmt.Sprintf("media_security must be 'rtp' or 'srtp_sdes', got %q", cfg.MediaSecurity))
	}
	if cfg.IsSRTPSDESEnabled() {
		if !cfg.MediaEnabled {
			errs = append(errs, "media_security='srtp_sdes' requires media_enabled=true")
		}
		if cfg.IsRTCPSREnabled() {
			errs = append(errs, "rtcp_sr_enabled is not supported with SRTP until SRTCP support is implemented")
		}
		if cfg.SRTPKeyMode != "auto" {
			errs = append(errs, fmt.Sprintf("srtp_key_mode must be 'auto', got %q", cfg.SRTPKeyMode))
		}
		if len(cfg.SRTPCryptoSuites) == 0 {
			errs = append(errs, "srtp_crypto_suites must contain at least one suite when SRTP is enabled")
		}
	}
	for _, suite := range cfg.SRTPCryptoSuites {
		switch suite {
		case "AES_CM_128_HMAC_SHA1_80", "AES_CM_128_HMAC_SHA1_32":
		default:
			errs = append(errs, fmt.Sprintf("unsupported srtp_crypto_suite %q", suite))
		}
	}
	if cfg.RTPMode == "3phase_coverage" {
		if cfg.RTPMediaCoveragePct < 1 || cfg.RTPMediaCoveragePct > 100 {
			errs = append(errs, fmt.Sprintf("rtp_media_coverage_pct must be 1..100, got %d", cfg.RTPMediaCoveragePct))
		}
		if cfg.RTPStartBurstSharePct < 0 || cfg.RTPStartBurstSharePct > 100 {
			errs = append(errs, fmt.Sprintf("rtp_start_burst_share_pct must be 0..100, got %d", cfg.RTPStartBurstSharePct))
		}
		if cfg.RTPEndBurstSharePct < 0 || cfg.RTPEndBurstSharePct > 100 {
			errs = append(errs, fmt.Sprintf("rtp_end_burst_share_pct must be 0..100, got %d", cfg.RTPEndBurstSharePct))
		}
		if cfg.RTPStartBurstSharePct+cfg.RTPEndBurstSharePct >= 100 {
			errs = append(errs, "rtp_start_burst_share_pct + rtp_end_burst_share_pct must be less than 100")
		}
		if cfg.RTPMidBurstSeconds <= 0 || cfg.RTPMidBurstSeconds > cfg.HoldTimeSeconds {
			errs = append(errs, fmt.Sprintf("rtp_mid_burst_seconds must be > 0 and <= hold_time_seconds, got %d", cfg.RTPMidBurstSeconds))
		}
		if cfg.IsRTPCoverageKeepaliveEnabled() && (cfg.RTPCoverageKeepalivePPS < 1 || cfg.RTPCoverageKeepalivePPS > 5) {
			errs = append(errs, fmt.Sprintf("rtp_coverage_keepalive_pps must be 1..5 when keepalive is enabled, got %d", cfg.RTPCoverageKeepalivePPS))
		}
	}

	if cfg.TrafficMode != "" && cfg.TrafficMode != "smoke" && cfg.TrafficMode != "timed" && cfg.TrafficMode != "unlimited" {
		errs = append(errs, fmt.Sprintf("traffic_mode must be 'smoke', 'timed', or 'unlimited', got %q", cfg.TrafficMode))
	}
	cfg.PairingPolicy = strings.ToLower(strings.TrimSpace(cfg.PairingPolicy))
	if cfg.PairingPolicy == "" {
		cfg.PairingPolicy = "random"
	}
	switch cfg.PairingPolicy {
	case "random", "cross_zone", "same_zone", "same_controller":
	default:
		errs = append(errs, fmt.Sprintf("pairing_policy must be 'random', 'cross_zone', 'same_zone', or 'same_controller', got %q", cfg.PairingPolicy))
	}

	// RTCP SR safety checks (Phase 2). ApplyDefaults coerces mux to true
	// whenever SR is enabled, but Validate also rejects the combination
	// explicitly so YAML mistakes surface as errors instead of silent
	// behavior changes after coercion.
	if cfg.IsRTCPSREnabled() && !cfg.IsRTCPMuxEnabled() {
		errs = append(errs, "rtcp_sr_enabled=true requires rtcp_mux_enabled=true (a=rtcp-mux must be advertised in SDP)")
	}
	if cfg.RTCPSRIntervalSeconds < 1 || cfg.RTCPSRIntervalSeconds > 60 {
		errs = append(errs, fmt.Sprintf("rtcp_sr_interval_seconds must be 1..60 s, got %d", cfg.RTCPSRIntervalSeconds))
	}
	for _, event := range cfg.SubscribeEvents {
		if _, ok := SubscribeEventPolicyFor(event); !ok {
			errs = append(errs, fmt.Sprintf("subscribe_events contains unsupported event %q", event))
		}
	}
	for _, event := range cfg.SubscribeRefreshEvents {
		if _, ok := SubscribeEventPolicyFor(event); !ok {
			errs = append(errs, fmt.Sprintf("subscribe_refresh_events contains unsupported event %q", event))
		}
		if !containsSubscribeEvent(cfg.SubscribeEvents, event) {
			errs = append(errs, fmt.Sprintf("subscribe_refresh_events contains unselected event %q", event))
		}
	}
	for _, event := range cfg.SubscribeUnsubscribeEvents {
		if _, ok := SubscribeEventPolicyFor(event); !ok {
			errs = append(errs, fmt.Sprintf("subscribe_unsubscribe_events contains unsupported event %q", event))
		}
		if !containsSubscribeEvent(cfg.SubscribeEvents, event) {
			errs = append(errs, fmt.Sprintf("subscribe_unsubscribe_events contains unselected event %q", event))
		}
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
		"sip_scheme", cfg.SIPScheme,
		"cps", cfg.CPS,
		"hold_s", cfg.HoldTimeSeconds,
		"ext_range", fmt.Sprintf("%d-%d (%d)", cfg.ExtStart, cfg.ExtEnd, cfg.ExtCount()),
		"concurrent_estimate", cfg.EffectiveMaxConcurrent(),
		"register_expires", cfg.RegisterExpires,
		"subscribe_expires", cfg.SubscribeExpires,
		"subscribe_events", cfg.SubscribeEvents,
		"subscribe_refresh_events", cfg.SubscribeRefreshEvents,
		"subscribe_unsubscribe_events", cfg.SubscribeUnsubscribeEvents,
		"register_batch_size_deprecated", cfg.RegisterBatchSize,
		"subscribe_concurrency", cfg.SubscribeConcurrency,
		"register_timeout", cfg.RegisterTimeout,
		"connect_timeout", cfg.ConnectTimeout,
		"cleanup_unsubscribe_rate_per_sec", cfg.CleanupUnsubscribeRate,
		"cleanup_unregister_rate_per_sec", cfg.CleanupUnregisterRate,
		"cleanup_audit_timeout_minutes", cfg.CleanupAuditTimeoutMinutes,
		"media_security", cfg.MediaSecurity,
		"srtp_crypto_suites", cfg.SRTPCryptoSuites,
		"rtp_mode", cfg.RTPMode,
		"traffic_mode", cfg.TrafficMode,
		"pairing_policy", cfg.PairingPolicy,
	)

	if cfg.HAMode == "multi_zone" && cfg.ZoneConfig != nil {
		groups := cfg.ComputeAgentGroups()
		for _, g := range groups {
			slog.Info("Agent group assignment",
				"group_id", g.GroupID,
				"zone", g.ZoneID,
				"primary", fmt.Sprintf("%s:%d", g.PrimaryController.Host, g.PrimaryController.Port),
				"secondary", fmt.Sprintf("%s:%d", g.SecondaryController.Host, g.SecondaryController.Port),
				"ext_range", fmt.Sprintf("%d-%d (%d agents)", g.ExtStart, g.ExtEnd, g.ExtEnd-g.ExtStart+1),
			)
		}
	}

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

// AgentGroupAssignment describes the agent range and controller pairing for
// one group within a multi-zone HA topology.
type AgentGroupAssignment struct {
	GroupID             string
	ZoneID              string
	PrimaryController   ZoneController
	SecondaryController ZoneController
	ExtStart            int
	ExtEnd              int
}

// ComputeAgentGroups distributes agents across zones and controllers. With two
// zones, each primary controller is paired with a cross-zone secondary using
// round-robin. With one zone, groups have no secondary and secondary-only work
// is skipped by the multi-zone lifecycle.
// Returns nil for single/dual modes (those use the legacy flat config).
func (cfg *VMConfig) ComputeAgentGroups() []AgentGroupAssignment {
	if cfg.HAMode != "multi_zone" || cfg.ZoneConfig == nil || len(cfg.ZoneConfig.Zones) == 0 {
		return nil
	}
	if len(cfg.StaticAgentAssignments) > 0 {
		return cfg.computeStaticAgentGroups()
	}
	zoneA := cfg.ZoneConfig.Zones[0]
	totalAgents := cfg.ExtCount()
	if len(cfg.ZoneConfig.Zones) == 1 {
		return computeZoneAssignments(zoneA, nil, totalAgents, cfg.ExtStart)
	}
	zoneB := cfg.ZoneConfig.Zones[1]
	zoneACount := totalAgents * cfg.ZoneConfig.ZoneDistributionPct / 100
	zoneBCount := totalAgents - zoneACount

	var groups []AgentGroupAssignment
	extCursor := cfg.ExtStart

	zoneAGroups := computeZoneAssignments(zoneA, zoneB.Controllers, zoneACount, extCursor)
	groups = append(groups, zoneAGroups...)
	if len(zoneAGroups) > 0 {
		extCursor = zoneAGroups[len(zoneAGroups)-1].ExtEnd + 1
	}
	groups = append(groups, computeZoneAssignments(zoneB, zoneA.Controllers, zoneBCount, extCursor)...)

	return groups
}

func (cfg *VMConfig) computeStaticAgentGroups() []AgentGroupAssignment {
	groups := make([]AgentGroupAssignment, 0, len(cfg.StaticAgentAssignments))
	for i, row := range cfg.StaticAgentAssignments {
		if row.ExtEnd == 0 && row.ExtCount > 0 {
			row.ExtEnd = row.ExtStart + row.ExtCount - 1
		}
		groupID := fmt.Sprintf("static-%s-%s-range-%d-%d",
			safeID(row.PrimaryZoneID),
			strings.ReplaceAll(controllerKey(row.PrimaryController), ":", "-"),
			row.ExtStart,
			row.ExtEnd,
		)
		if groupID == "static---range-0-0" {
			groupID = fmt.Sprintf("static-assignment-%d", i+1)
		}
		groups = append(groups, AgentGroupAssignment{
			GroupID:             groupID,
			ZoneID:              row.PrimaryZoneID,
			PrimaryController:   row.PrimaryController,
			SecondaryController: row.SecondaryController,
			ExtStart:            row.ExtStart,
			ExtEnd:              row.ExtEnd,
		})
	}
	return groups
}

func computeZoneAssignments(zone Zone, secondaryControllers []ZoneController, count, extCursor int) []AgentGroupAssignment {
	if count <= 0 || len(zone.Controllers) == 0 {
		return nil
	}
	perCtrl := count / len(zone.Controllers)
	remainder := count % len(zone.Controllers)
	groups := make([]AgentGroupAssignment, 0, len(zone.Controllers))
	for i, ctrl := range zone.Controllers {
		count := perCtrl
		if i < remainder {
			count++
		}
		if count == 0 {
			continue
		}
		var secondary ZoneController
		if len(secondaryControllers) > 0 {
			secondary = secondaryControllers[i%len(secondaryControllers)]
		}
		groups = append(groups, AgentGroupAssignment{
			GroupID:             fmt.Sprintf("%s-ctrl-%d", zone.ZoneID, i+1),
			ZoneID:              zone.ZoneID,
			PrimaryController:   ctrl,
			SecondaryController: secondary,
			ExtStart:            extCursor,
			ExtEnd:              extCursor + count - 1,
		})
		extCursor += count
	}
	return groups
}

func (cfg *VMConfig) validateStaticAgentAssignments() []string {
	var errs []string
	if cfg.ZoneConfig == nil {
		return []string{"static_agent_assignments requires zone_config"}
	}
	controllerZones := make(map[string]string)
	for _, zone := range cfg.ZoneConfig.Zones {
		for _, ctrl := range zone.Controllers {
			controllerZones[controllerKey(ctrl)] = zone.ZoneID
		}
	}

	type extRange struct {
		start int
		end   int
		row   int
	}
	ranges := make([]extRange, 0, len(cfg.StaticAgentAssignments))
	for i := range cfg.StaticAgentAssignments {
		row := &cfg.StaticAgentAssignments[i]
		if row.ExtStart <= 0 {
			errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].ext_start must be > 0", i))
		}
		if row.ExtEnd == 0 && row.ExtCount > 0 {
			row.ExtEnd = row.ExtStart + row.ExtCount - 1
		}
		if row.ExtCount == 0 && row.ExtEnd >= row.ExtStart && row.ExtStart > 0 {
			row.ExtCount = row.ExtEnd - row.ExtStart + 1
		}
		if row.ExtEnd < row.ExtStart {
			errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].ext_end must be >= ext_start", i))
		}
		if row.ExtCount <= 0 {
			errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].ext_count must be > 0", i))
		}
		if strings.TrimSpace(row.PrimaryController.Host) == "" {
			errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].primary_controller.host is required", i))
		}
		if row.PrimaryController.Port <= 0 || row.PrimaryController.Port > 65535 {
			errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].primary_controller.port out of range: %d", i, row.PrimaryController.Port))
		}
		if zoneID, ok := controllerZones[controllerKey(row.PrimaryController)]; ok {
			if strings.TrimSpace(row.PrimaryZoneID) == "" {
				row.PrimaryZoneID = zoneID
			} else if row.PrimaryZoneID != zoneID {
				errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].primary_zone_id=%q does not match controller zone %q", i, row.PrimaryZoneID, zoneID))
			}
		} else if strings.TrimSpace(row.PrimaryController.Host) != "" {
			errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].primary_controller %s is not present in zone_config", i, controllerKey(row.PrimaryController)))
		}
		if strings.TrimSpace(row.SecondaryController.Host) != "" {
			if row.SecondaryController.Port <= 0 || row.SecondaryController.Port > 65535 {
				errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].secondary_controller.port out of range: %d", i, row.SecondaryController.Port))
			}
			if controllerKey(row.SecondaryController) == controllerKey(row.PrimaryController) {
				errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].secondary_controller must differ from primary_controller", i))
			}
			if zoneID, ok := controllerZones[controllerKey(row.SecondaryController)]; ok {
				if strings.TrimSpace(row.SecondaryZoneID) == "" {
					row.SecondaryZoneID = zoneID
				} else if row.SecondaryZoneID != zoneID {
					errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].secondary_zone_id=%q does not match controller zone %q", i, row.SecondaryZoneID, zoneID))
				}
			} else {
				errs = append(errs, fmt.Sprintf("static_agent_assignments[%d].secondary_controller %s is not present in zone_config", i, controllerKey(row.SecondaryController)))
			}
		}
		if row.ExtStart > 0 && row.ExtEnd >= row.ExtStart {
			ranges = append(ranges, extRange{start: row.ExtStart, end: row.ExtEnd, row: i})
		}
	}
	for i := 0; i < len(ranges); i++ {
		for j := i + 1; j < len(ranges); j++ {
			if ranges[i].start <= ranges[j].end && ranges[j].start <= ranges[i].end {
				errs = append(errs, fmt.Sprintf("static_agent_assignments[%d] range overlaps static_agent_assignments[%d]", ranges[i].row, ranges[j].row))
			}
		}
	}
	return errs
}

func (cfg *VMConfig) deriveGlobalExtensionBoundsFromStaticAssignments() {
	minExt, maxExt := 0, 0
	for _, row := range cfg.StaticAgentAssignments {
		start, end := normalizedAssignmentRange(row)
		if start <= 0 || end < start {
			continue
		}
		if minExt == 0 || start < minExt {
			minExt = start
		}
		if end > maxExt {
			maxExt = end
		}
	}
	if minExt > 0 && maxExt >= minExt {
		cfg.ExtStart = minExt
		cfg.ExtEnd = maxExt
	}
}

func controllerKey(c ZoneController) string {
	if strings.TrimSpace(c.Host) == "" {
		return ""
	}
	return fmt.Sprintf("%s:%d", strings.TrimSpace(c.Host), c.Port)
}

func safeID(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return "unknown"
	}
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-' {
			b.WriteRune(r)
		} else {
			b.WriteByte('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// EffectiveHAMode returns the resolved HA mode. When ha_mode is empty,
// it infers from other fields for backward compatibility.
func (cfg *VMConfig) EffectiveHAMode() string {
	if cfg.HAMode != "" {
		return cfg.HAMode
	}
	if cfg.ZoneConfig != nil && len(cfg.ZoneConfig.Zones) > 0 {
		return "multi_zone"
	}
	if cfg.DualRegistrationEnabled {
		return "dual"
	}
	return "single"
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
