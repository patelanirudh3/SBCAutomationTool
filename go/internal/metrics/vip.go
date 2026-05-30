package metrics

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/cci/traffic-engine/internal/config"
)

type VIPRequest struct {
	Interface string `json:"vip_interface"`
	CIDR      string `json:"vip_cidr"`
	FirstIP   string `json:"vip_first_ip"`
	Count     int    `json:"vip_count"`
	GatewayIP string `json:"vip_gateway_ip,omitempty"`
	TargetIP  string `json:"vip_sanity_target_ip,omitempty"`
}

type VIPResult struct {
	Interface      string           `json:"vip_interface"`
	CIDR           string           `json:"vip_cidr"`
	Requested      int              `json:"requested"`
	AlreadyPresent int              `json:"already_present"`
	NewlyAdded     int              `json:"newly_added"`
	Missing        int              `json:"missing"`
	Failed         int              `json:"failed"`
	IPs            []string         `json:"ips,omitempty"`
	SanityChecks   []VIPSanityCheck `json:"sanity_checks,omitempty"`
	Errors         []string         `json:"errors,omitempty"`
}

type VIPSanityCheck struct {
	Name     string `json:"name"`
	SourceIP string `json:"source_ip"`
	TargetIP string `json:"target_ip"`
	OK       bool   `json:"ok"`
	Output   string `json:"output,omitempty"`
	Error    string `json:"error,omitempty"`
}

func decodeVIPRequest(r *http.Request) (VIPRequest, error) {
	defer r.Body.Close()
	var req VIPRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return req, err
	}
	req.Interface = strings.TrimSpace(req.Interface)
	req.CIDR = strings.TrimSpace(req.CIDR)
	req.FirstIP = strings.TrimSpace(req.FirstIP)
	req.GatewayIP = strings.TrimSpace(req.GatewayIP)
	req.TargetIP = strings.TrimSpace(req.TargetIP)
	return req, nil
}

func vipConfigFromRequest(req VIPRequest) *config.VMConfig {
	return &config.VMConfig{
		LocalIPMode:  "vip_pool",
		VIPInterface: req.Interface,
		VIPCIDR:      req.CIDR,
		VIPFirstIP:   req.FirstIP,
		VIPCount:     req.Count,
		ExtStart:     1000,
		ExtEnd:       1001,
	}
}

func verifyVIPs(req VIPRequest) (VIPResult, error) {
	result := VIPResult{Interface: req.Interface, CIDR: req.CIDR, Requested: req.Count}
	if req.Interface == "" {
		return result, fmt.Errorf("vip_interface is required")
	}
	if _, err := net.InterfaceByName(req.Interface); err != nil {
		return result, fmt.Errorf("interface %q not found: %w", req.Interface, err)
	}
	cfg := vipConfigFromRequest(req)
	ips, err := cfg.GenerateVIPs()
	if err != nil {
		return result, err
	}
	result.IPs = ips
	for _, ip := range ips {
		present, err := interfaceHasIP(req.Interface, ip)
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %v", ip, err))
			continue
		}
		if present {
			result.AlreadyPresent++
		} else {
			result.Missing++
		}
	}
	result.SanityChecks = runVIPSanityChecks(req, ips, false)
	return result, nil
}

func applyVIPs(req VIPRequest) (VIPResult, error) {
	result, err := verifyVIPs(req)
	if err != nil {
		return result, err
	}
	for _, ip := range result.IPs {
		present, err := interfaceHasIP(req.Interface, ip)
		if err != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %v", ip, err))
			continue
		}
		if present {
			continue
		}
		if err := addVIP(req.Interface, ip); err != nil {
			result.Failed++
			result.Errors = append(result.Errors, fmt.Sprintf("%s: %v", ip, err))
			continue
		}
		result.NewlyAdded++
	}
	result.Missing = result.Requested - result.AlreadyPresent - result.NewlyAdded - result.Failed
	if result.Missing < 0 {
		result.Missing = 0
	}
	result.SanityChecks = runVIPSanityChecks(req, result.IPs, true)
	if result.Failed > 0 {
		return result, nil
	}
	return result, nil
}

func interfaceHasIP(ifaceName, ip string) (bool, error) {
	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		return false, err
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return false, err
	}
	target := net.ParseIP(ip)
	for _, addr := range addrs {
		switch v := addr.(type) {
		case *net.IPNet:
			if v.IP.Equal(target) {
				return true, nil
			}
		case *net.IPAddr:
			if v.IP.Equal(target) {
				return true, nil
			}
		}
	}
	return false, nil
}

func addVIP(ifaceName, ip string) error {
	cmd := exec.Command("ip", "addr", "add", ip+"/32", "dev", ifaceName)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("ip addr add failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func runVIPSanityChecks(req VIPRequest, ips []string, requirePresent bool) []VIPSanityCheck {
	if len(ips) == 0 {
		return nil
	}
	sourceIP := ips[0]
	if requirePresent {
		present, err := interfaceHasIP(req.Interface, sourceIP)
		if err != nil || !present {
			return []VIPSanityCheck{{
				Name:     "source_vip_present",
				SourceIP: sourceIP,
				OK:       false,
				Error:    "source VIP is not present on interface; skipping ping checks",
			}}
		}
	}
	checks := []VIPSanityCheck{}
	if req.GatewayIP != "" {
		checks = append(checks, pingFromSource("gateway", sourceIP, req.GatewayIP))
	}
	if req.TargetIP != "" {
		checks = append(checks, pingFromSource("target", sourceIP, req.TargetIP))
	}
	return checks
}

func pingFromSource(name, sourceIP, targetIP string) VIPSanityCheck {
	check := VIPSanityCheck{Name: name, SourceIP: sourceIP, TargetIP: targetIP}
	if net.ParseIP(targetIP) == nil {
		check.Error = "target is not an IP address; source ping supports IP targets only"
		return check
	}
	cmd := exec.Command("ping", "-c", "1", "-W", "2", "-I", sourceIP, targetIP)
	timer := time.AfterFunc(3*time.Second, func() {
		_ = cmd.Process.Kill()
	})
	out, err := cmd.CombinedOutput()
	timer.Stop()
	check.Output = strings.TrimSpace(string(out))
	if err != nil {
		check.Error = err.Error()
		return check
	}
	check.OK = true
	return check
}
