// TLS helpers for SIP transport.
//
// BuildTLSConfig returns a *tls.Config matching the VMConfig.TLSMode
// selection, loading PEM cert/key/CA files from disk as needed. Returns
// (nil, nil) when SIPTransport is not "TLS" so callers can pass the result
// straight through to the transport factory.
package config

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"os"
	"strings"
)

// BuildTLSConfig constructs a *tls.Config for the SIP TLS transport based
// on the TLSMode and cert paths in the VMConfig. The returned config has
// MinVersion forced to TLS 1.2.
//
// Mode → behaviour:
//   - "" or "insecure"   → InsecureSkipVerify=true (lab/testing only)
//   - "server_ca"        → RootCAs loaded from TLSCAPath
//   - "client_cert"      → Certificates loaded from TLSCertPath/TLSKeyPath;
//     server verified against system roots
//   - "mutual"           → both RootCAs and Certificates loaded
//
// TLSServerName populates ServerName for SNI / hostname verification when
// the certificate CN/SAN does not match SBCHost.
func BuildTLSConfig(cfg *VMConfig) (*tls.Config, error) {
	if !strings.EqualFold(cfg.SIPTransport, "TLS") {
		return nil, nil
	}

	tlsCfg := &tls.Config{
		MinVersion: mustTLSVersion(cfg.TLSMinVersion),
		MaxVersion: mustTLSMaxVersion(cfg.TLSMaxVersion),
		ServerName: cfg.TLSServerName,
	}

	mode := strings.ToLower(cfg.TLSMode)
	switch mode {
	case "", "insecure":
		tlsCfg.InsecureSkipVerify = true //nolint:gosec — explicit lab/testing mode
		slog.Warn("SIP TLS configured with InsecureSkipVerify — certificate checks disabled",
			"vm_id", cfg.VMID)
		return tlsCfg, nil

	case "server_ca", "mutual":
		pemBytes, err := os.ReadFile(cfg.TLSCAPath)
		if err != nil {
			return nil, fmt.Errorf("tls: read CA %s: %w", cfg.TLSCAPath, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(pemBytes) {
			return nil, fmt.Errorf("tls: no PEM certificates found in %s", cfg.TLSCAPath)
		}
		tlsCfg.RootCAs = pool

	case "client_cert":

	default:
		return nil, fmt.Errorf("tls: unknown tls_mode %q", cfg.TLSMode)
	}

	if mode == "client_cert" || mode == "mutual" {
		cert, err := tls.LoadX509KeyPair(cfg.TLSCertPath, cfg.TLSKeyPath)
		if err != nil {
			return nil, fmt.Errorf("tls: load client cert/key: %w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}

	slog.Info("SIP TLS configured",
		"vm_id", cfg.VMID,
		"tls_mode", mode,
		"tls_min_version", cfg.TLSMinVersion,
		"tls_max_version", cfg.TLSMaxVersion,
		"server_name", tlsCfg.ServerName,
		"has_root_cas", tlsCfg.RootCAs != nil,
		"has_client_cert", len(tlsCfg.Certificates) > 0,
	)
	return tlsCfg, nil
}

func parseTLSVersionName(v string) (uint16, bool) {
	switch strings.TrimSpace(strings.ToLower(v)) {
	case "", "1.2", "tls1.2", "tls 1.2":
		return tls.VersionTLS12, true
	case "1.3", "tls1.3", "tls 1.3":
		return tls.VersionTLS13, true
	default:
		return 0, false
	}
}

func parseTLSMaxVersionName(v string) (uint16, bool) {
	switch strings.TrimSpace(strings.ToLower(v)) {
	case "", "auto":
		return 0, true
	default:
		return parseTLSVersionName(v)
	}
}

func mustTLSVersion(v string) uint16 {
	out, ok := parseTLSVersionName(v)
	if !ok {
		return tls.VersionTLS12
	}
	return out
}

func mustTLSMaxVersion(v string) uint16 {
	out, ok := parseTLSMaxVersionName(v)
	if !ok {
		return 0
	}
	return out
}
