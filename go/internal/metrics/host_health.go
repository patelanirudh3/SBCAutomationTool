package metrics

import (
	"os"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

type HostHealth struct {
	CPUPercent           float64 `json:"cpu_percent"`
	Load1                float64 `json:"load1"`
	Load5                float64 `json:"load5"`
	Load15               float64 `json:"load15"`
	MemTotalBytes        uint64  `json:"mem_total_bytes"`
	MemAvailableBytes    uint64  `json:"mem_available_bytes"`
	MemUsedPercent       float64 `json:"mem_used_percent"`
	DiskTotalBytes       uint64  `json:"disk_total_bytes"`
	DiskFreeBytes        uint64  `json:"disk_free_bytes"`
	DiskUsedPercent      float64 `json:"disk_used_percent"`
	UDPInDatagrams       uint64  `json:"udp_in_datagrams"`
	UDPInErrors          uint64  `json:"udp_in_errors"`
	UDPRcvbufErrors      uint64  `json:"udp_rcvbuf_errors"`
	NetRXBytes           uint64  `json:"net_rx_bytes"`
	NetTXBytes           uint64  `json:"net_tx_bytes"`
	ProcessCPUPercent    float64 `json:"process_cpu_percent"`
	ProcessRSSBytes      uint64  `json:"process_rss_bytes"`
	ProcessVMSBytes      uint64  `json:"process_vms_bytes"`
	ProcessThreads       int     `json:"process_threads"`
	ProcessReadBytes     uint64  `json:"process_read_bytes"`
	ProcessWriteBytes    uint64  `json:"process_write_bytes"`
	ProcessReadSyscalls  uint64  `json:"process_read_syscalls"`
	ProcessWriteSyscalls uint64  `json:"process_write_syscalls"`
	Goroutines           int     `json:"goroutines"`
	OpenFDs              int     `json:"open_fds"`
	UptimeSeconds        float64 `json:"uptime_seconds"`
}

type HostHealthCollector struct {
	start        time.Time
	prevCPUIdle  uint64
	prevCPUTotal uint64
	hasCPU       bool
	prevProcCPU  uint64
	hasProcCPU   bool
}

func NewHostHealthCollector() *HostHealthCollector {
	return &HostHealthCollector{start: time.Now()}
}

func (c *HostHealthCollector) Snapshot() HostHealth {
	h := HostHealth{
		Goroutines:    runtime.NumGoroutine(),
		OpenFDs:       countOpenFDs(),
		UptimeSeconds: time.Since(c.start).Seconds(),
	}
	h.Load1, h.Load5, h.Load15 = readLoadAvg()
	h.MemTotalBytes, h.MemAvailableBytes, h.MemUsedPercent = readMemInfo()
	h.ProcessRSSBytes, h.ProcessVMSBytes = readProcessMemory()
	h.ProcessThreads = readProcessThreads()
	h.ProcessReadBytes, h.ProcessWriteBytes, h.ProcessReadSyscalls, h.ProcessWriteSyscalls = readProcessIO()
	h.DiskTotalBytes, h.DiskFreeBytes, h.DiskUsedPercent = readDiskUsage(".")
	h.UDPInDatagrams, h.UDPInErrors, h.UDPRcvbufErrors = readUDPStats()
	h.NetRXBytes, h.NetTXBytes = readNetDev()
	if idle, total, ok := readCPUStat(); ok {
		procCPU := readProcessCPUJiffies()
		if c.hasCPU && total > c.prevCPUTotal {
			totalDelta := total - c.prevCPUTotal
			idleDelta := idle - c.prevCPUIdle
			if totalDelta > 0 && idleDelta <= totalDelta {
				h.CPUPercent = round2((1 - float64(idleDelta)/float64(totalDelta)) * 100)
			}
			if c.hasProcCPU && procCPU >= c.prevProcCPU {
				h.ProcessCPUPercent = round2(float64(procCPU-c.prevProcCPU) / float64(totalDelta) * 100)
			}
		}
		c.prevCPUIdle = idle
		c.prevCPUTotal = total
		c.prevProcCPU = procCPU
		c.hasCPU = true
		c.hasProcCPU = true
	}
	return h
}

func readLoadAvg() (float64, float64, float64) {
	fields := readFields("/proc/loadavg")
	if len(fields) < 3 {
		return 0, 0, 0
	}
	return parseFloat(fields[0]), parseFloat(fields[1]), parseFloat(fields[2])
}

func readMemInfo() (total, available uint64, usedPct float64) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		v := parseUint(fields[1]) * 1024
		switch strings.TrimSuffix(fields[0], ":") {
		case "MemTotal":
			total = v
		case "MemAvailable":
			available = v
		}
	}
	if total > 0 && available <= total {
		usedPct = round2(float64(total-available) / float64(total) * 100)
	}
	return
}

func readProcessMemory() (rss, vms uint64) {
	fields := readFields("/proc/self/statm")
	if len(fields) < 2 {
		return 0, 0
	}
	page := uint64(os.Getpagesize())
	return parseUint(fields[1]) * page, parseUint(fields[0]) * page
}

func readProcessThreads() int {
	data, err := os.ReadFile("/proc/self/status")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(data), "\n") {
		if strings.HasPrefix(line, "Threads:") {
			fields := strings.Fields(line)
			if len(fields) == 2 {
				return int(parseUint(fields[1]))
			}
		}
	}
	return 0
}

func readProcessCPUJiffies() uint64 {
	data, err := os.ReadFile("/proc/self/stat")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(data))
	if len(fields) < 15 {
		return 0
	}
	return parseUint(fields[13]) + parseUint(fields[14])
}

func readProcessIO() (readBytes, writeBytes, readSyscalls, writeSyscalls uint64) {
	data, err := os.ReadFile("/proc/self/io")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		v := parseUint(strings.TrimSpace(parts[1]))
		switch strings.TrimSpace(parts[0]) {
		case "read_bytes":
			readBytes = v
		case "write_bytes":
			writeBytes = v
		case "syscr":
			readSyscalls = v
		case "syscw":
			writeSyscalls = v
		}
	}
	return
}

func readDiskUsage(path string) (total, free uint64, usedPct float64) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return
	}
	total = st.Blocks * uint64(st.Bsize)
	free = st.Bavail * uint64(st.Bsize)
	if total > 0 && free <= total {
		usedPct = round2(float64(total-free) / float64(total) * 100)
	}
	return
}

func readUDPStats() (inDatagrams, inErrors, rcvbufErrors uint64) {
	data, err := os.ReadFile("/proc/net/snmp")
	if err != nil {
		return
	}
	lines := strings.Split(string(data), "\n")
	for i := 0; i+1 < len(lines); i++ {
		if !strings.HasPrefix(lines[i], "Udp:") || !strings.HasPrefix(lines[i+1], "Udp:") {
			continue
		}
		keys := strings.Fields(lines[i])[1:]
		vals := strings.Fields(lines[i+1])[1:]
		for j, k := range keys {
			if j >= len(vals) {
				continue
			}
			switch k {
			case "InDatagrams":
				inDatagrams = parseUint(vals[j])
			case "InErrors":
				inErrors = parseUint(vals[j])
			case "RcvbufErrors":
				rcvbufErrors = parseUint(vals[j])
			}
		}
	}
	return
}

func readNetDev() (rx, tx uint64) {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(data), "\n") {
		parts := strings.Split(line, ":")
		if len(parts) != 2 {
			continue
		}
		if strings.TrimSpace(parts[0]) == "lo" {
			continue
		}
		fields := strings.Fields(parts[1])
		if len(fields) >= 16 {
			rx += parseUint(fields[0])
			tx += parseUint(fields[8])
		}
	}
	return
}

func readCPUStat() (idle, total uint64, ok bool) {
	fields := readFields("/proc/stat")
	if len(fields) < 8 || fields[0] != "cpu" {
		return 0, 0, false
	}
	for i, f := range fields[1:] {
		v := parseUint(f)
		total += v
		if i == 3 || i == 4 {
			idle += v
		}
	}
	return idle, total, total > 0
}

func countOpenFDs() int {
	entries, err := os.ReadDir("/proc/self/fd")
	if err != nil {
		return 0
	}
	return len(entries)
}

func readFields(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return strings.Fields(string(data))
}

func parseUint(s string) uint64 {
	v, _ := strconv.ParseUint(s, 10, 64)
	return v
}

func parseFloat(s string) float64 {
	v, _ := strconv.ParseFloat(s, 64)
	return v
}

func round2(v float64) float64 {
	return float64(int(v*100+0.5)) / 100
}
