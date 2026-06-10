package metrics

import (
	"math"
	"os"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	TopProcessModeOff         = "off"
	TopProcessModeWarningOnly = "warning_only"
	TopProcessModeSlow        = "slow"

	topProcessMinInterval = 15 * time.Second
	topProcessLimit       = 5
)

type HostHealth struct {
	CPUPercent            float64              `json:"cpu_percent"`
	CPUUserPercent        float64              `json:"cpu_user_percent"`
	CPUSystemPercent      float64              `json:"cpu_system_percent"`
	CPUIOWaitPercent      float64              `json:"cpu_iowait_percent"`
	CPUIRQPercent         float64              `json:"cpu_irq_percent"`
	CPUSoftIRQPercent     float64              `json:"cpu_softirq_percent"`
	CPUStealPercent       float64              `json:"cpu_steal_percent"`
	CPUIdlePercent        float64              `json:"cpu_idle_percent"`
	Load1                 float64              `json:"load1"`
	Load5                 float64              `json:"load5"`
	Load15                float64              `json:"load15"`
	MemTotalBytes         uint64               `json:"mem_total_bytes"`
	MemAvailableBytes     uint64               `json:"mem_available_bytes"`
	MemUsedPercent        float64              `json:"mem_used_percent"`
	DiskTotalBytes        uint64               `json:"disk_total_bytes"`
	DiskFreeBytes         uint64               `json:"disk_free_bytes"`
	DiskUsedPercent       float64              `json:"disk_used_percent"`
	UDPInDatagrams        uint64               `json:"udp_in_datagrams"`
	UDPInErrors           uint64               `json:"udp_in_errors"`
	UDPRcvbufErrors       uint64               `json:"udp_rcvbuf_errors"`
	UDPInErrorsDelta      uint64               `json:"udp_in_errors_delta"`
	UDPRcvbufErrorsDelta  uint64               `json:"udp_rcvbuf_errors_delta"`
	NetRXBytes            uint64               `json:"net_rx_bytes"`
	NetTXBytes            uint64               `json:"net_tx_bytes"`
	ProcessCPUPercent     float64              `json:"process_cpu_percent"`
	ProcessCPUPercentVM   float64              `json:"process_cpu_percent_vm"`
	ProcessCPUPercentCore float64              `json:"process_cpu_percent_core"`
	ProcessRSSBytes       uint64               `json:"process_rss_bytes"`
	ProcessVMSBytes       uint64               `json:"process_vms_bytes"`
	ProcessThreads        int                  `json:"process_threads"`
	ProcessReadBytes      uint64               `json:"process_read_bytes"`
	ProcessWriteBytes     uint64               `json:"process_write_bytes"`
	ProcessReadSyscalls   uint64               `json:"process_read_syscalls"`
	ProcessWriteSyscalls  uint64               `json:"process_write_syscalls"`
	Goroutines            int                  `json:"goroutines"`
	OpenFDs               int                  `json:"open_fds"`
	UptimeSeconds         float64              `json:"uptime_seconds"`
	TopProcessMode        string               `json:"top_process_mode"`
	TopProcesses          []TopProcessSnapshot `json:"top_processes,omitempty"`
	TopProcessSampleUnix  float64              `json:"top_process_sample_unix,omitempty"`
	PerformanceWarnings   []string             `json:"performance_warnings,omitempty"`
}

type TopProcessSnapshot struct {
	PID            int     `json:"pid"`
	Name           string  `json:"name"`
	CPUPercentCore float64 `json:"cpu_percent_core"`
	RSSBytes       uint64  `json:"rss_bytes"`
}

type cpuTimes struct {
	User    uint64
	Nice    uint64
	System  uint64
	Idle    uint64
	IOWait  uint64
	IRQ     uint64
	SoftIRQ uint64
	Steal   uint64
	Total   uint64
}

type HostHealthCollector struct {
	start time.Time

	prevCPU     cpuTimes
	hasCPU      bool
	prevProcCPU uint64
	hasProcCPU  bool

	topProcessMode      string
	lastTopProcessScan  time.Time
	lastTopProcesses    []TopProcessSnapshot
	prevTopProcessCPU   map[int]uint64
	prevTopProcessWall  time.Time
	udpBaselineSet      bool
	udpInErrorsBase     uint64
	udpRcvbufErrorsBase uint64
}

func NewHostHealthCollector() *HostHealthCollector {
	return &HostHealthCollector{
		start:             time.Now(),
		topProcessMode:    TopProcessModeWarningOnly,
		prevTopProcessCPU: make(map[int]uint64),
	}
}

func (c *HostHealthCollector) SetTopProcessMode(mode string) string {
	switch mode {
	case TopProcessModeOff, TopProcessModeWarningOnly, TopProcessModeSlow:
		c.topProcessMode = mode
	default:
		c.topProcessMode = TopProcessModeWarningOnly
	}
	return c.topProcessMode
}

func (c *HostHealthCollector) TopProcessMode() string {
	if c.topProcessMode == "" {
		return TopProcessModeWarningOnly
	}
	return c.topProcessMode
}

func (c *HostHealthCollector) ResetUDPBaseline() {
	_, inErrors, rcvbufErrors := readUDPStats()
	c.udpInErrorsBase = inErrors
	c.udpRcvbufErrorsBase = rcvbufErrors
	c.udpBaselineSet = true
}

func (c *HostHealthCollector) Snapshot() HostHealth {
	h := HostHealth{
		Goroutines:     runtime.NumGoroutine(),
		OpenFDs:        countOpenFDs(),
		UptimeSeconds:  time.Since(c.start).Seconds(),
		TopProcessMode: c.TopProcessMode(),
	}
	h.Load1, h.Load5, h.Load15 = readLoadAvg()
	h.MemTotalBytes, h.MemAvailableBytes, h.MemUsedPercent = readMemInfo()
	h.ProcessRSSBytes, h.ProcessVMSBytes = readProcessMemory()
	h.ProcessThreads = readProcessThreads()
	h.ProcessReadBytes, h.ProcessWriteBytes, h.ProcessReadSyscalls, h.ProcessWriteSyscalls = readProcessIO()
	h.DiskTotalBytes, h.DiskFreeBytes, h.DiskUsedPercent = readDiskUsage(".")
	h.UDPInDatagrams, h.UDPInErrors, h.UDPRcvbufErrors = readUDPStats()
	if c.udpBaselineSet {
		h.UDPInErrorsDelta = safeDelta(h.UDPInErrors, c.udpInErrorsBase)
		h.UDPRcvbufErrorsDelta = safeDelta(h.UDPRcvbufErrors, c.udpRcvbufErrorsBase)
	}
	h.NetRXBytes, h.NetTXBytes = readNetDev()
	if cpu, ok := readCPUStat(); ok {
		procCPU := readProcessCPUJiffies()
		if c.hasCPU && cpu.Total > c.prevCPU.Total {
			fillCPUPercentages(&h, cpu, c.prevCPU)
			totalDelta := cpu.Total - c.prevCPU.Total
			if c.hasProcCPU && procCPU >= c.prevProcCPU {
				h.ProcessCPUPercentVM = round2(float64(procCPU-c.prevProcCPU) / float64(totalDelta) * 100)
				h.ProcessCPUPercent = h.ProcessCPUPercentVM
				h.ProcessCPUPercentCore = round2(math.Min(h.ProcessCPUPercentVM*float64(runtime.NumCPU()), float64(runtime.NumCPU()*100)))
			}
		}
		c.prevCPU = cpu
		c.prevProcCPU = procCPU
		c.hasCPU = true
		c.hasProcCPU = true
	}
	h.PerformanceWarnings = performanceWarnings(h)
	if c.shouldScanTopProcesses(h) {
		c.lastTopProcesses = c.scanTopProcesses()
		c.lastTopProcessScan = time.Now()
	}
	if len(c.lastTopProcesses) > 0 {
		h.TopProcesses = append([]TopProcessSnapshot(nil), c.lastTopProcesses...)
		h.TopProcessSampleUnix = float64(c.lastTopProcessScan.UnixMilli()) / 1000.0
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

func fillCPUPercentages(h *HostHealth, cur, prev cpuTimes) {
	totalDelta := cur.Total - prev.Total
	if totalDelta == 0 {
		return
	}
	pct := func(delta uint64) float64 {
		return round2(float64(delta) / float64(totalDelta) * 100)
	}
	idleDelta := safeDelta(cur.Idle+cur.IOWait, prev.Idle+prev.IOWait)
	if idleDelta <= totalDelta {
		h.CPUPercent = round2((1 - float64(idleDelta)/float64(totalDelta)) * 100)
		h.CPUIdlePercent = round2(float64(idleDelta) / float64(totalDelta) * 100)
	}
	h.CPUUserPercent = pct(safeDelta(cur.User+cur.Nice, prev.User+prev.Nice))
	h.CPUSystemPercent = pct(safeDelta(cur.System, prev.System))
	h.CPUIOWaitPercent = pct(safeDelta(cur.IOWait, prev.IOWait))
	h.CPUIRQPercent = pct(safeDelta(cur.IRQ, prev.IRQ))
	h.CPUSoftIRQPercent = pct(safeDelta(cur.SoftIRQ, prev.SoftIRQ))
	h.CPUStealPercent = pct(safeDelta(cur.Steal, prev.Steal))
}

func safeDelta(cur, prev uint64) uint64 {
	if cur < prev {
		return 0
	}
	return cur - prev
}

func readCPUStat() (cpuTimes, bool) {
	fields := readFields("/proc/stat")
	if len(fields) < 8 || fields[0] != "cpu" {
		return cpuTimes{}, false
	}
	cpu := cpuTimes{
		User:    parseUint(fields[1]),
		Nice:    parseUint(fields[2]),
		System:  parseUint(fields[3]),
		Idle:    parseUint(fields[4]),
		IOWait:  parseUint(fields[5]),
		IRQ:     parseUint(fields[6]),
		SoftIRQ: parseUint(fields[7]),
	}
	if len(fields) > 8 {
		cpu.Steal = parseUint(fields[8])
	}
	cpu.Total = cpu.User + cpu.Nice + cpu.System + cpu.Idle + cpu.IOWait + cpu.IRQ + cpu.SoftIRQ + cpu.Steal
	return cpu, cpu.Total > 0
}

func performanceWarnings(h HostHealth) []string {
	warnings := []string{}
	if h.CPUPercent > 80 && h.ProcessCPUPercentCore < 5 {
		warnings = append(warnings, "Host CPU high while engine CPU is low; check kernel network processing, tcpdump, GUI runtime, or other VM processes.")
	}
	if h.CPUSoftIRQPercent > 10 {
		warnings = append(warnings, "SoftIRQ CPU is elevated; kernel network processing is significant.")
	}
	if h.UDPInErrorsDelta > 0 || h.UDPRcvbufErrorsDelta > 0 {
		warnings = append(warnings, "UDP errors increased during this run; packet receive buffers or host networking may be stressed.")
	}
	return warnings
}

func (c *HostHealthCollector) shouldScanTopProcesses(h HostHealth) bool {
	mode := c.TopProcessMode()
	if mode == TopProcessModeOff {
		return false
	}
	if !c.lastTopProcessScan.IsZero() && time.Since(c.lastTopProcessScan) < topProcessMinInterval {
		return false
	}
	if mode == TopProcessModeSlow {
		return true
	}
	return len(h.PerformanceWarnings) > 0
}

func (c *HostHealthCollector) scanTopProcesses() []TopProcessSnapshot {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	now := time.Now()
	elapsed := now.Sub(c.prevTopProcessWall).Seconds()
	nextCPU := make(map[int]uint64)
	snapshots := make([]TopProcessSnapshot, 0, topProcessLimit)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(entry.Name())
		if err != nil {
			continue
		}
		name, procCPU, rss, ok := readProcessSnapshot(pid)
		if !ok {
			continue
		}
		nextCPU[pid] = procCPU
		cpuPct := 0.0
		if prev, exists := c.prevTopProcessCPU[pid]; exists && procCPU >= prev && elapsed > 0 {
			cpuPct = round2(float64(procCPU-prev) / elapsed)
		}
		snapshots = append(snapshots, TopProcessSnapshot{
			PID:            pid,
			Name:           name,
			CPUPercentCore: cpuPct,
			RSSBytes:       rss,
		})
	}
	c.prevTopProcessCPU = nextCPU
	c.prevTopProcessWall = now
	sort.Slice(snapshots, func(i, j int) bool {
		if snapshots[i].CPUPercentCore == snapshots[j].CPUPercentCore {
			return snapshots[i].RSSBytes > snapshots[j].RSSBytes
		}
		return snapshots[i].CPUPercentCore > snapshots[j].CPUPercentCore
	})
	if len(snapshots) > topProcessLimit {
		snapshots = snapshots[:topProcessLimit]
	}
	return snapshots
}

func readProcessSnapshot(pid int) (name string, cpuJiffies uint64, rssBytes uint64, ok bool) {
	statPath := "/proc/" + strconv.Itoa(pid) + "/stat"
	data, err := os.ReadFile(statPath)
	if err != nil {
		return "", 0, 0, false
	}
	raw := string(data)
	open := strings.Index(raw, "(")
	close := strings.LastIndex(raw, ")")
	if open < 0 || close <= open {
		return "", 0, 0, false
	}
	name = raw[open+1 : close]
	fields := strings.Fields(strings.TrimSpace(raw[close+1:]))
	if len(fields) < 22 {
		return "", 0, 0, false
	}
	cpuJiffies = parseUint(fields[11]) + parseUint(fields[12])
	rssPages := parseUint(fields[21])
	rssBytes = rssPages * uint64(os.Getpagesize())
	if comm, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/comm"); err == nil {
		if s := strings.TrimSpace(string(comm)); s != "" {
			name = s
		}
	}
	return name, cpuJiffies, rssBytes, true
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
