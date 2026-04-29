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
//                          server verified against system roots
//   - "mutual"           → both RootCAs and Certificates loaded
//
// TLSServerName populates ServerName for SNI / hostname verification when
// the certificate CN/SAN does not match SBCHost.
func BuildTLSConfig(cfg *VMConfig) (*tls.Config, error) {
	if !strings.EqualFold(cfg.SIPTransport, "TLS") {
		return nil, nil
	}

	tlsCfg := &tls.Config{
		MinVersion: tls.VersionTLS12,
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
		"server_name", tlsCfg.ServerName,
		"has_root_cas", tlsCfg.RootCAs != nil,
		"has_client_cert", len(tlsCfg.Certificates) > 0,
	)
	return tlsCfg, nil
}
