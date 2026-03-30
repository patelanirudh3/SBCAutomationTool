// Package metrics implements a real-time traffic metrics collector and HTTP/WebSocket
// server, porting the Python traffic/metrics.py to Go.
package metrics

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"math"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ---------------------------------------------------------------------------
// TrafficMetrics — JSON snapshot returned by GET /metrics and WS push
// ---------------------------------------------------------------------------

// TrafficMetrics is the snapshot of traffic metrics for one VM at one point in time.
// JSON field names must match the Python version exactly — the Next.js GUI depends on them.
type TrafficMetrics struct {
	Timestamp        float64            `json:"timestamp"`
	VMID             string             `json:"vm_id"`
	Phase            string             `json:"phase"`
	CPSActual        float64            `json:"cps_actual"`
	ConcurrentCalls  int                `json:"concurrent_calls"`
	CallsAttempted   int                `json:"calls_attempted"`
	CallsCompleted   int                `json:"calls_completed"`
	CallsFailed      int                `json:"calls_failed"`
	ASR              float64            `json:"asr"`
	AvgPDDMs         float64            `json:"avg_pdd_ms"`
	MinPDDMs         float64            `json:"min_pdd_ms"`
	MaxPDDMs         float64            `json:"max_pdd_ms"`
	AvgHoldMs        float64            `json:"avg_hold_ms"`
	AvgTotalMs       float64            `json:"avg_total_ms"`
	SocketCount      int                `json:"socket_count"`
	RegisteredCount  int                `json:"registered_count"`
	SubscribedCount  int                `json:"subscribed_count"`
	RunElapsedSec    float64            `json:"run_elapsed_seconds"`
	Running          bool               `json:"running"`
	RTPHealth        map[string]int     `json:"rtp_health"`
}

// ---------------------------------------------------------------------------
// CallResultData — ingestion struct fed by the engine (mirrors engine.CallResult)
// ---------------------------------------------------------------------------

// CallResultData carries the outcome of a single call fed into the collector.
type CallResultData struct {
	CallID           string
	Caller           string
	Callee           string
	Success          bool
	FailureReason    string
	PDDMs            float64
	HoldMs           float64
	TotalMs          float64
	RTPTxPkts        int
	RTPRxPkts        int
	MediaVerified    bool
	RTPLocalPort     int
	PoolWrapIndex    int
	PeerExt          string
	TsUTC            string
	Direction        string
	SBCRTPRelayIP    string
	SBCRTPRelayPort  int
	RTPRxFromSBCPkts int
	RTPRxOtherPkts   int
	RTCPRxPkts       int
	RTPAsymmetryFlag string
	MarkersSent      int
	MarkersReceived  int
	Scenario         string
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

// MetricsCollector accumulates call results and produces TrafficMetrics snapshots.
// It implements the engine.MetricsRecorder interface (IncrementSIPCounter, RecordRawEvent).
type MetricsCollector struct {
	mu sync.Mutex

	vmID     string
	interval time.Duration

	callsAttempted int
	callsCompleted int
	callsFailed    int

	pddSamples   []float64
	holdSamples  []float64
	totalSamples []float64

	windowStart    time.Time
	windowAttempts int

	latest TrafficMetrics

	concurrentCalls int
	socketCount     int
	registeredCount int
	subscribedCount int
	phase           string
	runStart        time.Time
	running         bool
	runStartSet     bool

	callResults        []CallResultData
	rawEvents          []map[string]any
	callSpines         []map[string]any
	concurrentProvider func() int

	rtpHealthCounts map[string]int

	// SIP message counters — UAC side
	invitesSent    int
	acksSent       int
	byesSent       int
	bye200Received int
	// SIP message counters — UAS side
	invitesReceived int
	acksReceived    int
	byesReceived    int
	bye200Sent      int

	// WebSocket subscribers
	wsMu        sync.Mutex
	wsClients   map[*websocket.Conn]struct{}
}

// NewMetricsCollector creates a new collector for the given VM.
func NewMetricsCollector(vmID string, metricsIntervalSec int) *MetricsCollector {
	if metricsIntervalSec <= 0 {
		metricsIntervalSec = 10
	}
	return &MetricsCollector{
		vmID:            vmID,
		interval:        time.Duration(metricsIntervalSec) * time.Second,
		windowStart:     time.Now(),
		phase:           "IDLE",
		latest:          TrafficMetrics{VMID: vmID, Phase: "IDLE", RTPHealth: map[string]int{"OK": 0, "WARNING": 0, "CRITICAL": 0}},
		rtpHealthCounts: map[string]int{"OK": 0, "WARNING": 0, "CRITICAL": 0},
		wsClients:       make(map[*websocket.Conn]struct{}),
	}
}

// ---------------------------------------------------------------------------
// MetricsRecorder interface implementation (engine.MetricsRecorder)
// ---------------------------------------------------------------------------

// IncrementSIPCounter increments one of the 8 named SIP message counters.
func (c *MetricsCollector) IncrementSIPCounter(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch name {
	case "invites_sent":
		c.invitesSent++
	case "acks_sent":
		c.acksSent++
	case "byes_sent":
		c.byesSent++
	case "bye_200_received":
		c.bye200Received++
	case "invites_received":
		c.invitesReceived++
	case "acks_received":
		c.acksReceived++
	case "byes_received":
		c.byesReceived++
	case "bye_200_sent":
		c.bye200Sent++
	}
}

// RecordRawEvent stores a raw call event (capped at 10000).
func (c *MetricsCollector) RecordRawEvent(payload map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.rawEvents = append(c.rawEvents, payload)
	if len(c.rawEvents) > 10000 {
		c.rawEvents = c.rawEvents[len(c.rawEvents)-10000:]
	}
}

// ---------------------------------------------------------------------------
// State setters
// ---------------------------------------------------------------------------

// SetPhase updates the current phase string.
func (c *MetricsCollector) SetPhase(phase string) {
	c.mu.Lock()
	c.phase = phase
	c.mu.Unlock()
}

// SetRunning updates the running flag and records the run start time.
func (c *MetricsCollector) SetRunning(running bool) {
	c.mu.Lock()
	c.running = running
	if running {
		c.runStart = time.Now()
		c.runStartSet = true
	}
	c.mu.Unlock()
}

// UpdateCounts updates the external count gauges.
func (c *MetricsCollector) UpdateCounts(concurrent, sockets, registered, subscribed int) {
	c.mu.Lock()
	c.concurrentCalls = concurrent
	c.socketCount = sockets
	c.registeredCount = registered
	c.subscribedCount = subscribed
	c.mu.Unlock()
}

// SetConcurrentProvider sets a callable that returns the current active call count.
func (c *MetricsCollector) SetConcurrentProvider(fn func() int) {
	c.mu.Lock()
	c.concurrentProvider = fn
	c.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Call result ingestion
// ---------------------------------------------------------------------------

// RecordCall accepts a CallResultData and updates accumulated metrics.
func (c *MetricsCollector) RecordCall(result CallResultData) {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.callResults = append(c.callResults, result)
	c.callsAttempted++

	if result.Success {
		c.callsCompleted++
		if result.PDDMs > 0 {
			c.pddSamples = append(c.pddSamples, result.PDDMs)
		}
		if result.HoldMs > 0 {
			c.holdSamples = append(c.holdSamples, result.HoldMs)
		}
		if result.TotalMs > 0 {
			c.totalSamples = append(c.totalSamples, result.TotalMs)
		}
	} else {
		c.callsFailed++
	}

	if result.RTPAsymmetryFlag != "" {
		if _, ok := c.rtpHealthCounts[result.RTPAsymmetryFlag]; ok {
			c.rtpHealthCounts[result.RTPAsymmetryFlag]++
		}
	}
}

// RecordAttempt increments the windowed attempt counter (for CPS calculation).
func (c *MetricsCollector) RecordAttempt() {
	c.mu.Lock()
	c.windowAttempts++
	c.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Data accessors
// ---------------------------------------------------------------------------

// GetCallResultsAsDicts returns call results as generic maps.
func (c *MetricsCollector) GetCallResultsAsDicts() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()

	out := make([]map[string]any, 0, len(c.callResults))
	for _, r := range c.callResults {
		out = append(out, map[string]any{
			"call_id":              r.CallID,
			"caller":              r.Caller,
			"callee":              r.Callee,
			"success":             r.Success,
			"failure_reason":      r.FailureReason,
			"pdd_ms":             r.PDDMs,
			"hold_ms":            r.HoldMs,
			"total_ms":           r.TotalMs,
			"rtp_tx_pkts":        r.RTPTxPkts,
			"rtp_rx_pkts":        r.RTPRxPkts,
			"media_verified":     r.MediaVerified,
			"rtp_local_port":     r.RTPLocalPort,
			"pool_wrap_index":    r.PoolWrapIndex,
			"peer_ext":           r.PeerExt,
			"ts_utc":             r.TsUTC,
			"direction":          r.Direction,
			"sbc_rtp_relay_ip":   r.SBCRTPRelayIP,
			"sbc_rtp_relay_port": r.SBCRTPRelayPort,
			"rtp_rx_from_sbc_pkts": r.RTPRxFromSBCPkts,
			"rtp_rx_other_pkts":    r.RTPRxOtherPkts,
			"rtcp_rx_pkts":         r.RTCPRxPkts,
			"rtp_asymmetry_flag":   r.RTPAsymmetryFlag,
			"markers_sent":         r.MarkersSent,
			"markers_received":     r.MarkersReceived,
			"scenario":             r.Scenario,
		})
	}
	return out
}

// StoreCallSpines stores correlated call spines built by the spine builder.
func (c *MetricsCollector) StoreCallSpines(spines []map[string]any) {
	c.mu.Lock()
	c.callSpines = make([]map[string]any, len(spines))
	copy(c.callSpines, spines)
	c.mu.Unlock()
}

// GetAllEvents returns a copy of all raw call events.
func (c *MetricsCollector) GetAllEvents() []map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]map[string]any, len(c.rawEvents))
	copy(out, c.rawEvents)
	return out
}

// SIPCounters holds SIP message counter values needed by the traffic summary.
type SIPCounters struct {
	InvitesSent     int
	AcksSent        int
	ByesSent        int
	Bye200Received  int
	InvitesReceived int
	AcksReceived    int
	ByesReceived    int
	Bye200Sent      int
}

// GetSIPCounters returns a snapshot of SIP message counters.
func (c *MetricsCollector) GetSIPCounters() SIPCounters {
	c.mu.Lock()
	defer c.mu.Unlock()
	return SIPCounters{
		InvitesSent:     c.invitesSent,
		AcksSent:        c.acksSent,
		ByesSent:        c.byesSent,
		Bye200Received:  c.bye200Received,
		InvitesReceived: c.invitesReceived,
		AcksReceived:    c.acksReceived,
		ByesReceived:    c.byesReceived,
		Bye200Sent:      c.bye200Sent,
	}
}

// GetCallResultsCopy returns a copy of all call results for the summary writer.
func (c *MetricsCollector) GetCallResultsCopy() []CallResultData {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]CallResultData, len(c.callResults))
	copy(out, c.callResults)
	return out
}

// GetRTPHealthSnapshot returns a copy of the RTP health counters.
func (c *MetricsCollector) GetRTPHealthSnapshot() map[string]int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return map[string]int{
		"OK":       c.rtpHealthCounts["OK"],
		"WARNING":  c.rtpHealthCounts["WARNING"],
		"CRITICAL": c.rtpHealthCounts["CRITICAL"],
	}
}

// GetFinalSummary returns an aggregate summary dict with RTP health.
func (c *MetricsCollector) GetFinalSummary() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()

	summary := map[string]any{
		"rtp_health": map[string]int{
			"OK":       c.rtpHealthCounts["OK"],
			"WARNING":  c.rtpHealthCounts["WARNING"],
			"CRITICAL": c.rtpHealthCounts["CRITICAL"],
		},
	}
	return summary
}

// Reset clears all accumulated metrics so a new run starts from zero.
func (c *MetricsCollector) Reset() {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.callsAttempted = 0
	c.callsCompleted = 0
	c.callsFailed = 0
	c.pddSamples = nil
	c.holdSamples = nil
	c.totalSamples = nil
	c.windowStart = time.Now()
	c.windowAttempts = 0
	c.concurrentCalls = 0
	c.socketCount = 0
	c.registeredCount = 0
	c.subscribedCount = 0
	c.phase = "IDLE"
	c.runStart = time.Time{}
	c.runStartSet = false
	c.running = false
	c.callResults = nil
	c.rawEvents = nil
	c.callSpines = nil
	c.concurrentProvider = nil
	c.rtpHealthCounts = map[string]int{"OK": 0, "WARNING": 0, "CRITICAL": 0}
	c.invitesSent = 0
	c.acksSent = 0
	c.byesSent = 0
	c.bye200Received = 0
	c.invitesReceived = 0
	c.acksReceived = 0
	c.byesReceived = 0
	c.bye200Sent = 0
	c.vmID = "unconfigured"
	c.latest = TrafficMetrics{
		VMID:      "unconfigured",
		Phase:     "IDLE",
		RTPHealth: map[string]int{"OK": 0, "WARNING": 0, "CRITICAL": 0},
	}
}

// Latest returns the most recent snapshot without rebuilding.
func (c *MetricsCollector) Latest() TrafficMetrics {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.latest
}

// BuildSnapshot computes a new TrafficMetrics snapshot with windowed CPS, ASR, and averages.
// Caller must NOT hold mu — this method acquires it internally.
func (c *MetricsCollector) BuildSnapshot() TrafficMetrics {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buildSnapshotLocked()
}

// buildSnapshotLocked is the internal snapshot builder; caller must hold mu.
func (c *MetricsCollector) buildSnapshotLocked() TrafficMetrics {
	now := time.Now()
	windowElapsed := now.Sub(c.windowStart).Seconds()

	var cpsActual float64
	if windowElapsed > 0 {
		cpsActual = float64(c.windowAttempts) / windowElapsed
	}

	c.windowStart = now
	c.windowAttempts = 0

	var asr float64
	if c.callsAttempted > 0 {
		asr = float64(c.callsCompleted) / float64(c.callsAttempted) * 100
	}

	concurrent := c.concurrentCalls
	if c.concurrentProvider != nil {
		concurrent = c.concurrentProvider()
	}

	var runElapsed float64
	if c.runStartSet {
		runElapsed = math.Round(now.Sub(c.runStart).Seconds()*10) / 10
	}

	snap := TrafficMetrics{
		Timestamp:       float64(time.Now().UnixMilli()) / 1000.0,
		VMID:            c.vmID,
		Phase:           c.phase,
		CPSActual:       math.Round(cpsActual*1000) / 1000,
		ConcurrentCalls: concurrent,
		CallsAttempted:  c.callsAttempted,
		CallsCompleted:  c.callsCompleted,
		CallsFailed:     c.callsFailed,
		ASR:             math.Round(asr*100) / 100,
		AvgPDDMs:        roundAvg(c.pddSamples),
		MinPDDMs:        roundMin(c.pddSamples),
		MaxPDDMs:        roundMax(c.pddSamples),
		AvgHoldMs:       roundAvg(c.holdSamples),
		AvgTotalMs:      roundAvg(c.totalSamples),
		SocketCount:     c.socketCount,
		RegisteredCount: c.registeredCount,
		SubscribedCount: c.subscribedCount,
		RunElapsedSec:   runElapsed,
		Running:         c.running,
		RTPHealth: map[string]int{
			"OK":       c.rtpHealthCounts["OK"],
			"WARNING":  c.rtpHealthCounts["WARNING"],
			"CRITICAL": c.rtpHealthCounts["CRITICAL"],
		},
	}
	c.latest = snap
	return snap
}

func roundAvg(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	var sum float64
	for _, v := range samples {
		sum += v
	}
	return math.Round(sum/float64(len(samples))*100) / 100
}

func roundMin(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	m := samples[0]
	for _, v := range samples[1:] {
		if v < m {
			m = v
		}
	}
	return math.Round(m*100) / 100
}

func roundMax(samples []float64) float64 {
	if len(samples) == 0 {
		return 0
	}
	m := samples[0]
	for _, v := range samples[1:] {
		if v > m {
			m = v
		}
	}
	return math.Round(m*100) / 100
}

// ---------------------------------------------------------------------------
// WebSocket push loop
// ---------------------------------------------------------------------------

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (c *MetricsCollector) addWSClient(conn *websocket.Conn) {
	c.wsMu.Lock()
	c.wsClients[conn] = struct{}{}
	c.wsMu.Unlock()
}

func (c *MetricsCollector) removeWSClient(conn *websocket.Conn) {
	c.wsMu.Lock()
	delete(c.wsClients, conn)
	c.wsMu.Unlock()
}

// RunPushLoop sends snapshots to all WebSocket clients at the configured interval.
// It blocks until stopCh is closed.
func (c *MetricsCollector) RunPushLoop(stopCh <-chan struct{}) {
	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	for {
		select {
		case <-stopCh:
			return
		case <-ticker.C:
			snap := c.BuildSnapshot()
			data, err := json.Marshal(snap)
			if err != nil {
				slog.Error("metrics push marshal", "err", err)
				continue
			}

			c.wsMu.Lock()
			var dead []*websocket.Conn
			for conn := range c.wsClients {
				if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
					dead = append(dead, conn)
				}
			}
			for _, conn := range dead {
				delete(c.wsClients, conn)
				conn.Close()
			}
			c.wsMu.Unlock()

			slog.Debug("Metrics push",
				"cps", snap.CPSActual,
				"concurrent", snap.ConcurrentCalls,
				"attempted", snap.CallsAttempted,
				"completed", snap.CallsCompleted,
				"failed", snap.CallsFailed,
				"asr", snap.ASR,
			)
		}
	}
}

// ---------------------------------------------------------------------------
// ProcessContext — shared mutable state for GUI-driven mode
// ---------------------------------------------------------------------------

// ProcessContext holds mutable state shared between HTTP endpoints and the
// traffic lifecycle when running in GUI-driven mode.
type ProcessContext struct {
	Collector   *MetricsCollector
	StopEvent   chan struct{}
	ProcessExit chan struct{}
	Port        int
	Config      any    // parsed *config.VMConfig (stored as any to avoid import cycle)
	RawConfig   map[string]any
	State       string
	VMID        string // set by PUT /api/config; used by effectiveVMID
	Role        string // set by PUT /api/config; used by effectiveRole
	YAMLPath    string
	LogLevel    string
	RunID       string
	PairID      string
	StartFunc   func()
	Mu          sync.Mutex

	// OnConfigReceived is called by PUT /api/config to validate the JSON body,
	// convert it to a VMConfig, and write a YAML file. Returns (vmID, role, yamlPath, err).
	// Injected by main.go to avoid importing the config package from metrics.
	OnConfigReceived func(body map[string]any) (vmID, role, yamlPath string, parsedCfg any, err error)
}

// NewProcessContext creates a ProcessContext in IDLE state.
func NewProcessContext(collector *MetricsCollector, port int) *ProcessContext {
	return &ProcessContext{
		Collector:   collector,
		StopEvent:   make(chan struct{}, 1),
		ProcessExit: make(chan struct{}, 1),
		Port:        port,
		State:       "IDLE",
		LogLevel:    "INFO",
	}
}

// ---------------------------------------------------------------------------
// CORS middleware
// ---------------------------------------------------------------------------

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func readJSONBody(r *http.Request) (map[string]any, error) {
	body, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// ---------------------------------------------------------------------------
// HTTP handler builder
// ---------------------------------------------------------------------------

// BuildMux creates the http.ServeMux with all endpoints.
func BuildMux(
	collector *MetricsCollector,
	vmID string,
	role string,
	processCtx *ProcessContext,
) *http.ServeMux {
	mux := http.NewServeMux()

	effectiveVMID := func() string {
		if processCtx != nil {
			processCtx.Mu.Lock()
			v := processCtx.VMID
			processCtx.Mu.Unlock()
			if v != "" {
				return v
			}
		}
		if vmID != "" {
			return vmID
		}
		return "unconfigured"
	}

	effectiveRole := func() string {
		if processCtx != nil {
			processCtx.Mu.Lock()
			v := processCtx.Role
			processCtx.Mu.Unlock()
			if v != "" {
				return v
			}
		}
		if role != "" {
			return role
		}
		return "unconfigured"
	}

	stateStr := func() string {
		if processCtx != nil {
			processCtx.Mu.Lock()
			s := processCtx.State
			processCtx.Mu.Unlock()
			return s
		}
		return "CLI"
	}

	// GET /metrics
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		snap := collector.BuildSnapshot()
		writeJSON(w, http.StatusOK, snap)
	})

	// WS /metrics/stream
	mux.HandleFunc("/metrics/stream", func(w http.ResponseWriter, r *http.Request) {
		conn, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			slog.Error("ws upgrade", "err", err)
			return
		}
		collector.addWSClient(conn)
		defer func() {
			collector.removeWSClient(conn)
			conn.Close()
		}()

		// Block until the client disconnects (read pump drains control frames).
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				break
			}
		}
	})

	// GET /api/ping
	mux.HandleFunc("GET /api/ping", func(w http.ResponseWriter, r *http.Request) {
		latest := collector.Latest()
		writeJSON(w, http.StatusOK, map[string]any{
			"reachable": true,
			"vm_id":     effectiveVMID(),
			"role":      effectiveRole(),
			"phase":     latest.Phase,
			"state":     stateStr(),
		})
	})

	// GET /api/test/status
	mux.HandleFunc("GET /api/test/status", func(w http.ResponseWriter, r *http.Request) {
		latest := collector.Latest()
		writeJSON(w, http.StatusOK, map[string]any{
			"phase":           latest.Phase,
			"running":         latest.Running,
			"elapsed_seconds": latest.RunElapsedSec,
			"vm_id":           effectiveVMID(),
			"state":           stateStr(),
		})
	})

	// PUT /api/config
	mux.HandleFunc("PUT /api/config", func(w http.ResponseWriter, r *http.Request) {
		if processCtx == nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "Config push not supported in CLI mode — use YAML files",
			})
			return
		}

		processCtx.Mu.Lock()
		if processCtx.State == "RUNNING" {
			processCtx.Mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "Cannot push config while traffic is running",
			})
			return
		}
		processCtx.Mu.Unlock()

		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error()})
			return
		}

		slog.Info("PUT /api/config received", "keys", len(body))

		// Validate config and write YAML via the callback injected by main.go
		var cfgVMID, cfgRole, yamlPath string
		var parsedCfg any
		if processCtx.OnConfigReceived != nil {
			cfgVMID, cfgRole, yamlPath, parsedCfg, err = processCtx.OnConfigReceived(body)
			if err != nil {
				slog.Error("Config validation failed", "err", err)
				writeJSON(w, http.StatusUnprocessableEntity, map[string]any{"error": err.Error()})
				return
			}
		} else {
			cfgVMID, _ = body["vm_id"].(string)
			cfgRole, _ = body["vm_role"].(string)
			parsedCfg = body
		}

		processCtx.Mu.Lock()
		if processCtx.State == "COMPLETE" || processCtx.State == "FAILED" {
			select {
			case <-processCtx.StopEvent:
			default:
			}
			processCtx.StopEvent = make(chan struct{}, 1)
			collector.Reset()
			slog.Info("Auto-reset from previous state to CONFIGURED", "prev", processCtx.State)
		}

		processCtx.Config = parsedCfg
		processCtx.RawConfig = body
		processCtx.YAMLPath = yamlPath
		processCtx.VMID = cfgVMID
		processCtx.Role = cfgRole
		processCtx.State = "CONFIGURED"
		processCtx.Mu.Unlock()

		if cfgVMID != "" {
			collector.mu.Lock()
			collector.vmID = cfgVMID
			collector.mu.Unlock()
		}

		slog.Info("Config accepted from GUI",
			"vm_id", cfgVMID, "role", cfgRole, "yaml_path", yamlPath,
		)

		writeJSON(w, http.StatusOK, map[string]any{
			"status":    "configured",
			"vm_id":     cfgVMID,
			"role":      cfgRole,
			"yaml_path": yamlPath,
		})
	})

	// POST /api/test/start
	mux.HandleFunc("POST /api/test/start", func(w http.ResponseWriter, r *http.Request) {
		if processCtx == nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"status":  "accepted",
				"message": "Traffic engine controlled via CLI/env vars",
			})
			return
		}

		body, err := readJSONBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
			return
		}

		runID, _ := body["run_id"].(string)
		pairID, _ := body["pair_id"].(string)
		if runID == "" || pairID == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error":   "run_id and pair_id are required in request body",
				"example": map[string]string{"run_id": "run-20260318_113204", "pair_id": "pair-1"},
			})
			return
		}

		processCtx.Mu.Lock()
		if processCtx.State == "RUNNING" {
			processCtx.Mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "Traffic is already running",
			})
			return
		}
		if processCtx.State != "CONFIGURED" {
			st := processCtx.State
			processCtx.Mu.Unlock()
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": fmt.Sprintf("Cannot start: state is '%s', expected 'CONFIGURED'. Push config first via PUT /api/config.", st),
			})
			return
		}
		if processCtx.StartFunc == nil {
			processCtx.Mu.Unlock()
			writeJSON(w, http.StatusInternalServerError, map[string]any{
				"error": "Lifecycle starter not registered — internal error",
			})
			return
		}

		processCtx.RunID = runID
		processCtx.PairID = pairID
		processCtx.State = "RUNNING"
		startFn := processCtx.StartFunc
		processCtx.Mu.Unlock()

		go startFn()

		slog.Info("Traffic lifecycle started via API", "vm_id", effectiveVMID(), "run_id", runID)
		writeJSON(w, http.StatusAccepted, map[string]any{
			"status": "started",
			"vm_id":  effectiveVMID(),
		})
	})

	// POST /api/test/stop
	mux.HandleFunc("POST /api/test/stop", func(w http.ResponseWriter, r *http.Request) {
		if processCtx != nil {
			processCtx.Mu.Lock()
			st := processCtx.State
			processCtx.Mu.Unlock()

			select {
			case processCtx.StopEvent <- struct{}{}:
			default:
			}
			writeJSON(w, http.StatusOK, map[string]any{
				"status": "stopping",
				"state":  st,
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "no_stop_callback_registered"})
	})

	// POST /api/test/reset
	mux.HandleFunc("POST /api/test/reset", func(w http.ResponseWriter, r *http.Request) {
		if processCtx == nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": "Reset not supported in CLI mode",
			})
			return
		}

		processCtx.Mu.Lock()
		if processCtx.State == "RUNNING" {
			processCtx.Mu.Unlock()
			writeJSON(w, http.StatusConflict, map[string]any{
				"error": "Cannot reset while traffic is running — stop first",
			})
			return
		}
		if processCtx.State != "COMPLETE" && processCtx.State != "FAILED" && processCtx.State != "CONFIGURED" {
			st := processCtx.State
			processCtx.Mu.Unlock()
			writeJSON(w, http.StatusBadRequest, map[string]any{
				"error": fmt.Sprintf("Nothing to reset: state is '%s'", st),
			})
			return
		}

		processCtx.State = "IDLE"
		processCtx.Config = nil
		processCtx.VMID = ""
		processCtx.Role = ""
		processCtx.YAMLPath = ""
		processCtx.StopEvent = make(chan struct{}, 1)
		processCtx.Mu.Unlock()

		collector.Reset()

		slog.Info("State reset to IDLE — ready for new config push")
		writeJSON(w, http.StatusOK, map[string]any{
			"status": "reset",
			"state":  "IDLE",
		})
	})

	// POST /api/shutdown
	mux.HandleFunc("POST /api/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if processCtx != nil {
			processCtx.Mu.Lock()
			st := processCtx.State
			processCtx.Mu.Unlock()

			select {
			case processCtx.StopEvent <- struct{}{}:
			default:
			}
			select {
			case processCtx.ProcessExit <- struct{}{}:
			default:
			}

			slog.Info("Shutdown requested via API", "state", st)
			writeJSON(w, http.StatusAccepted, map[string]any{
				"status": "shutting_down",
				"state":  st,
			})
			return
		}
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "Shutdown not supported"})
	})

	// GET /api/calls
	mux.HandleFunc("GET /api/calls", func(w http.ResponseWriter, r *http.Request) {
		collector.mu.Lock()
		results := make([]CallResultData, len(collector.callResults))
		copy(results, collector.callResults)
		collector.mu.Unlock()

		out := make([]map[string]any, 0, len(results))
		for i, cr := range results {
			media := "NO_MEDIA"
			if cr.MediaVerified {
				media = "MEDIA_VERIFIED"
			} else if cr.RTPTxPkts > 0 || cr.RTPRxPkts > 0 {
				media = "MEDIA_PARTIAL"
			}

			ts := cr.TsUTC
			if ts == "" {
				ts = time.Now().UTC().Format(time.RFC3339Nano)
			}

			direction := cr.Direction
			if direction == "" {
				direction = "uac"
			}
			caller := cr.Caller
			callee := cr.Callee

			ext := caller
			if direction == "uas" {
				ext = callee
			}

			callID := cr.CallID
			if callID == "" {
				callID = fmt.Sprintf("call-%04d", i)
			}

			out = append(out, map[string]any{
				"call_id":              callID,
				"uac_ext":             caller,
				"uas_ext":             callee,
				"ext":                 ext,
				"peer_ext":            cr.PeerExt,
				"direction":           direction,
				"result":              ternaryStr(cr.Success, "COMPLETED", "FAILED"),
				"failure_reason":      nilIfEmpty(cr.FailureReason),
				"pdd_ms":             cr.PDDMs,
				"hold_ms":            cr.HoldMs,
				"media_status":       media,
				"rtp_tx_pkts":        cr.RTPTxPkts,
				"rtp_rx_pkts":        cr.RTPRxPkts,
				"rtp_rx_from_sbc_pkts": cr.RTPRxFromSBCPkts,
				"rtp_rx_other_pkts":    cr.RTPRxOtherPkts,
				"rtp_asymmetry_flag":   cr.RTPAsymmetryFlag,
				"rtcp_rx_pkts":         cr.RTCPRxPkts,
				"markers_sent":         cr.MarkersSent,
				"markers_received":     cr.MarkersReceived,
				"sbc_rtp_relay_ip":     cr.SBCRTPRelayIP,
				"sbc_rtp_relay_port":   cr.SBCRTPRelayPort,
				"ts_utc":              ts,
				"timestamp":           ts,
			})
		}
		writeJSON(w, http.StatusOK, out)
	})

	// GET /api/calls/{call_id}
	mux.HandleFunc("GET /api/calls/{call_id}", func(w http.ResponseWriter, r *http.Request) {
		callID := r.PathValue("call_id")
		events := collector.GetAllEvents()
		for i := len(events) - 1; i >= 0; i-- {
			if cid, _ := events[i]["call_id"].(string); cid == callID {
				writeJSON(w, http.StatusOK, events[i])
				return
			}
		}
		writeJSON(w, http.StatusNotFound, map[string]any{
			"detail": fmt.Sprintf("Call-ID %s not found", callID),
		})
	})

	// GET /api/call-results
	mux.HandleFunc("GET /api/call-results", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, collector.GetCallResultsAsDicts())
	})

	// GET /api/call-spines
	mux.HandleFunc("GET /api/call-spines", func(w http.ResponseWriter, r *http.Request) {
		collector.mu.Lock()
		spines := make([]map[string]any, len(collector.callSpines))
		copy(spines, collector.callSpines)
		collector.mu.Unlock()
		writeJSON(w, http.StatusOK, spines)
	})

	// GET /api/scenarios
	mux.HandleFunc("GET /api/scenarios", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"scenarios": []map[string]any{
				{
					"id":          "basic_call",
					"name":        "Basic Call",
					"description": "Standard INVITE → RTP → BYE call flow",
					"status":      "available",
					"assertions":  []any{},
				},
				{
					"id":          "hold_unhold",
					"name":        "Hold / Unhold",
					"description": "Call with re-INVITE hold and resume (a=inactive / a=sendrecv)",
					"status":      "coming_soon",
					"assertions": []map[string]any{
						{"key": "re_invite_count", "expected": 2},
						{"key": "media_state_sequence", "expected": []string{"ACTIVE", "HELD", "ACTIVE"}},
						{"key": "asr", "expected": 100},
					},
				},
			},
		})
	})

	// GET /api/vms
	mux.HandleFunc("GET /api/vms", func(w http.ResponseWriter, r *http.Request) {
		snap := collector.Latest()
		writeJSON(w, http.StatusOK, []map[string]any{
			{
				"vm_id":      effectiveVMID(),
				"role":       effectiveRole(),
				"status":     snap.Phase,
				"cps":        snap.CPSActual,
				"concurrent": snap.ConcurrentCalls,
				"registered": snap.RegisteredCount,
				"asr":        snap.ASR,
			},
		})
	})

	return mux
}

func ternaryStr(cond bool, t, f string) string {
	if cond {
		return t
	}
	return f
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

// StartServer starts the HTTP/WebSocket server on the given port.
// It auto-increments the port up to 10 times if the initial port is in use.
// The push loop goroutine is started automatically.
// Returns the actual port used and any error. The server runs until stopCh is closed.
func StartServer(
	collector *MetricsCollector,
	vmID string,
	role string,
	port int,
	stopCh chan struct{},
	processCtx *ProcessContext,
) (int, error) {
	actualPort := port
	var listener net.Listener
	var err error

	for i := 0; i < 10; i++ {
		listener, err = net.Listen("tcp", fmt.Sprintf("0.0.0.0:%d", actualPort))
		if err == nil {
			break
		}
		slog.Warn("Metrics port in use, trying next",
			"port", actualPort, "next", actualPort+1)
		actualPort++
	}
	if err != nil {
		return 0, fmt.Errorf("could not find a free metrics port near %d: %w", port, err)
	}

	if processCtx != nil {
		processCtx.Mu.Lock()
		processCtx.Port = actualPort
		processCtx.Mu.Unlock()
	}

	mux := BuildMux(collector, vmID, role, processCtx)
	handler := corsMiddleware(mux)

	server := &http.Server{Handler: handler}

	go collector.RunPushLoop(stopCh)

	go func() {
		slog.Info("Metrics server starting",
			"addr", fmt.Sprintf("http://0.0.0.0:%d", actualPort),
			"endpoints", "GET /metrics | GET /api/ping | WS /metrics/stream",
		)
		if sErr := server.Serve(listener); sErr != nil && sErr != http.ErrServerClosed {
			slog.Error("Metrics HTTP server stopped unexpectedly", "err", sErr)
		}
	}()

	go func() {
		<-stopCh
		server.Close()
	}()

	return actualPort, nil
}

// ---------------------------------------------------------------------------
// Path helpers for ServeMux pattern matching (Go 1.22+)
// ---------------------------------------------------------------------------

// extractPathSuffix extracts a trailing path segment after a known prefix.
// Used as a fallback if PathValue is unavailable.
func extractPathSuffix(path, prefix string) string {
	if strings.HasPrefix(path, prefix) {
		return strings.TrimPrefix(path, prefix)
	}
	return ""
}
