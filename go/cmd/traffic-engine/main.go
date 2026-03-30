package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/engine"
	"github.com/cci/traffic-engine/internal/metrics"
	"github.com/cci/traffic-engine/internal/prephase"
	"github.com/cci/traffic-engine/internal/spine"
)

func main() {
	var (
		configPath      = flag.String("config", envStr("TRAFFIC_CONFIG", ""), "Path to YAML config file")
		logLevel        = flag.String("log-level", envStr("LOG_LEVEL", "INFO"), "Logging verbosity (DEBUG|INFO|WARNING|ERROR)")
		skipSubscribe   = flag.Bool("skip-subscribe", envBool("SKIP_SUBSCRIBE"), "Skip SUBSCRIBE pre-phase")
		dryRun          = flag.Bool("dry-run", false, "Validate config and exit")
		logFile         = flag.String("log-file", envStr("LOG_FILE", ""), "Write logs to this file")
		logDir          = flag.String("log-dir", envStr("LOG_DIR", "logs"), "Directory for auto-generated log files")
		maxCallsFlag    = flag.Int("max-calls", envInt("MAX_CALLS", 0), "Stop after N calls (0 = derive from config)")
		prePhaseOnly    = flag.Bool("pre-phase-only", envBool("PRE_PHASE_ONLY"), "Register+Subscribe only, no calls")
		noUnregister    = flag.Bool("no-unregister", envBool("NO_UNREGISTER"), "Skip unregister on shutdown")
		apiOnly         = flag.Bool("api-only", envBool("API_ONLY"), "Start API server only, no SIP")
		apiPort         = flag.Int("port", envInt("API_PORT", 0), "API server port for api-only mode")
		guiDrainSeconds = flag.Int("gui-drain-seconds", envInt("GUI_DRAIN_SECONDS", 15), "Keep server alive N seconds after cleanup")
	)
	flag.StringVar(configPath, "c", *configPath, "Path to YAML config file (alias for --config)")
	flag.Parse()

	setupLogging(*logLevel)

	slog.Info("============================================================")
	slog.Info("SBC Traffic Engine — Go")
	slog.Info("============================================================")

	// GUI-driven mode: --api-only without --config
	if *apiOnly && *configPath == "" {
		if *apiPort == 0 {
			slog.Error("--api-only without --config requires --port")
			os.Exit(1)
		}
		exitCode := runAPIOnly(*apiPort, *logLevel, *guiDrainSeconds)
		os.Exit(exitCode)
	}

	// Load config
	if *configPath == "" {
		slog.Error("--config is required (or use --api-only --port N)")
		os.Exit(1)
	}
	cfg, err := config.LoadConfig(*configPath)
	if err != nil {
		slog.Error("Config error", "err", err)
		os.Exit(1)
	}

	// Generate run/pair IDs
	ts := time.Now().Format("20060102_150405")
	runID := fmt.Sprintf("run-cli-%s", ts)
	pairID := "pair-1"

	// Setup file logging
	lf := *logFile
	if lf == "" {
		lf = autoLogFile(runID, pairID, cfg.VMID, *logDir)
	}
	setupFileLogging(*logLevel, lf)

	// Dry run
	if *dryRun {
		slog.Info("Dry run — config valid, exiting",
			"uac_ext", fmt.Sprintf("%d–%d (%d)", cfg.UACExtStart, cfg.UACExtEnd, cfg.UACExtCount()),
			"uas_ext", fmt.Sprintf("%d–%d (%d)", cfg.UASExtStart, cfg.UASExtEnd, cfg.UASExtCount()),
			"cps", cfg.CPS, "hold", cfg.HoldTimeSeconds,
			"concurrent", cfg.EffectiveMaxConcurrent(),
		)
		os.Exit(0)
	}

	// Derive max_calls
	maxCalls := *maxCallsFlag
	if maxCalls == 0 && cfg.IsUAC() {
		switch cfg.TrafficMode {
		case "smoke":
			maxCalls = cfg.CallCount
		case "timed":
			maxCalls = int(float64(cfg.CPS) * cfg.DurationHours * 3600)
		}
	}
	if maxCalls > 0 && cfg.PoolWrapCount() > 0 {
		poolWraps := int(math.Ceil(float64(maxCalls) / float64(cfg.PoolWrapCount())))
		slog.Info("Traffic mode resolved",
			"mode", cfg.TrafficMode, "max_calls", maxCalls,
			"pool_wrap_count", cfg.PoolWrapCount(), "pool_wraps", poolWraps,
		)
	} else if maxCalls == 0 {
		slog.Info("Traffic mode: unlimited (run until stopped)", "mode", cfg.TrafficMode)
	}

	// Run the full lifecycle
	exitCode := runLifecycle(cfg, *skipSubscribe, maxCalls, *prePhaseOnly, *noUnregister, *apiOnly, *guiDrainSeconds, runID, pairID, *logDir)
	slog.Info("Process exiting", "pid", os.Getpid(), "code", exitCode)
	os.Exit(exitCode)
}

func runLifecycle(
	cfg *config.VMConfig,
	skipSubscribe bool,
	maxCalls int,
	prePhaseOnly bool,
	noUnregister bool,
	apiOnly bool,
	guiDrainSeconds int,
	runID, pairID, logDir string,
) int {
	overallStart := time.Now()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		sig := <-sigCh
		slog.Info("Received signal, initiating graceful shutdown", "signal", sig)
		cancel()
	}()

	// Metrics collector
	collector := metrics.NewMetricsCollector(cfg.VMID, cfg.MetricsInterval)
	collector.SetPhase("INIT")

	// Start metrics HTTP server
	stopCh := make(chan struct{})
	actualPort, err := metrics.StartServer(collector, cfg.VMID, cfg.VMRole, cfg.MetricsPort, stopCh, nil)
	if err != nil {
		slog.Warn("Could not start metrics server", "err", err)
	} else {
		slog.Info("Metrics server started", "port", actualPort)
	}
	defer close(stopCh)

	// API-only mode with config
	if apiOnly {
		slog.Info("API-ONLY mode — server running", "port", cfg.MetricsPort, "role", cfg.VMRole)
		<-ctx.Done()
		return 0
	}

	// Create agents
	agents := createAgents(cfg)
	agentSlice := agentsToSlice(agents)
	slog.Info("Connecting transports", "count", len(agents))

	if err := connectTransportsBatched(ctx, agents, cfg); err != nil {
		slog.Error("Transport connection failed", "err", err)
		return 1
	}
	collector.UpdateCounts(0, len(agents), 0, 0)

	// Pre-phase
	collector.SetPhase("PRE_REGISTER")
	preResult, err := prephase.RunPrePhase(ctx, agentSlice, cfg, skipSubscribe)
	if err != nil {
		slog.Error("Pre-phase failed", "err", err)
		shutdownCleanup(ctx, agents, nil, nil, collector, cfg, runID, pairID, noUnregister)
		return 1
	}
	collector.UpdateCounts(0, len(agents), preResult.Registered, preResult.Subscribed)

	if prePhaseOnly {
		slog.Info("PRE-PHASE-ONLY mode — extensions registered. Waiting for signal to exit.")
		collector.SetPhase("READY_PRE_PHASE_ONLY")
		<-ctx.Done()
		shutdownCleanup(ctx, agents, nil, nil, collector, cfg, runID, pairID, noUnregister)
		return 0
	}

	// Traffic phase
	collector.SetPhase("TRAFFIC")
	collector.SetRunning(true)

	var callEngine *engine.CallEngine
	var uasEngine *engine.UasAutoAnswer

	if cfg.IsUAC() {
		callEngine = engine.NewCallEngine(
			agents, cfg,
			engine.WithOnComplete(func(r engine.CallResult) {
				collector.RecordCall(callResultToMetrics(r))
			}),
			engine.WithOnAttempt(func() {
				collector.RecordAttempt()
			}),
			engine.WithMaxCalls(maxCalls),
			engine.WithMetrics(collector),
		)
		collector.SetConcurrentProvider(func() int { return callEngine.ActiveCallCount() })

		slog.Info("UAC traffic starting",
			"cps", cfg.CPS, "hold_s", cfg.HoldTimeSeconds,
			"max_concurrent", cfg.EffectiveMaxConcurrent(),
			"ramp_s", cfg.RampUpSeconds, "max_calls", maxCalls,
		)

		engineDone := make(chan error, 1)
		go func() {
			engineDone <- callEngine.Run(ctx)
		}()

		select {
		case <-ctx.Done():
			callEngine.Stop()
		case err := <-engineDone:
			if err != nil {
				slog.Warn("Call engine stopped with error", "err", err)
			}
		}
	} else {
		uasEngine = engine.NewUasAutoAnswer(
			agents, cfg,
			engine.WithUasOnComplete(func(r engine.CallResult) {
				collector.RecordCall(callResultToMetrics(r))
			}),
			engine.WithUasMetrics(collector),
		)
		if err := uasEngine.Start(ctx); err != nil {
			slog.Error("UAS start failed", "err", err)
			return 1
		}
		slog.Info("UAS auto-answer active", "extensions", len(agents))
		<-ctx.Done()
	}

	// Call spine correlation (UAC only, before shutdown)
	if cfg.IsUAC() {
		buildAndStoreSpines(cfg, collector)
	}

	// Graceful shutdown
	collector.SetPhase("STOPPING")
	collector.SetRunning(false)
	slog.Info("Initiating graceful shutdown")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer shutdownCancel()
	shutdownCleanup(shutdownCtx, agents, callEngine, uasEngine, collector, cfg, runID, pairID, noUnregister)

	elapsed := time.Since(overallStart).Seconds()
	snap := collector.Latest()
	slog.Info("============================================================")
	slog.Info("RUN COMPLETE",
		"elapsed_s", fmt.Sprintf("%.1f", elapsed),
		"attempted", snap.CallsAttempted,
		"completed", snap.CallsCompleted,
		"failed", snap.CallsFailed,
		"asr", fmt.Sprintf("%.1f%%", snap.ASR),
	)
	slog.Info("============================================================")

	// Write run-*.json
	writeRunJSON(collector, cfg, runID, pairID, logDir)

	// GUI drain
	if guiDrainSeconds > 0 {
		slog.Info("GUI drain: keeping metrics server alive", "seconds", guiDrainSeconds)
		select {
		case <-time.After(time.Duration(guiDrainSeconds) * time.Second):
		case <-ctx.Done():
		}
	}

	return 0
}

func buildAndStoreSpines(cfg *config.VMConfig, collector *metrics.MetricsCollector) {
	peerURL := cfg.PeerStopURL
	uasBaseURL := ""
	if peerURL != "" {
		if parsed, err := url.Parse(peerURL); err == nil {
			uasBaseURL = fmt.Sprintf("%s://%s:%s", parsed.Scheme, parsed.Hostname(), parsed.Port())
		}
	}

	var uasCalls []map[string]any
	if uasBaseURL != "" {
		uasCalls = spine.CollectUASCallResults(uasBaseURL, 8.0)
	} else {
		slog.Warn("No peer_stop_url — skipping UAS event collection for spine correlation")
	}

	uacCalls := collector.GetCallResultsAsDicts()
	callSpines := spine.BuildCallSpines(uacCalls, uasCalls)
	collector.StoreCallSpines(callSpines)

	correlated := 0
	for _, s := range callSpines {
		if m, ok := s["correlation_method"].(string); ok && m != "unmatched" {
			correlated++
		}
	}
	slog.Info("Built call spines", "total", len(callSpines), "correlated", correlated)
}

func shutdownCleanup(
	ctx context.Context,
	agents map[string]*agent.ExtensionAgent,
	eng *engine.CallEngine,
	uas *engine.UasAutoAnswer,
	collector *metrics.MetricsCollector,
	cfg *config.VMConfig,
	runID, pairID string,
	noUnregister bool,
) {
	// Signal UAS peer to stop
	if cfg.IsUAC() && cfg.PeerStopURL != "" {
		postPeerStop(cfg.PeerStopURL)
	}

	// Stop call engine
	if eng != nil {
		eng.Stop()
		slog.Info("Draining active calls (BYE)")
		eng.DrainActiveCalls(ctx, 10*time.Second)
	}

	// Stop UAS
	if uas != nil {
		uas.Stop()
	}

	// Unregister
	if !noUnregister {
		slog.Info("Unregistering extensions", "count", len(agents))
		unregCtx, unregCancel := context.WithTimeout(ctx, time.Duration(cfg.RegisterTimeout*2)*time.Second)
		defer unregCancel()
		var wg sync.WaitGroup
		for _, ag := range agents {
			wg.Add(1)
			go func(a *agent.ExtensionAgent) {
				defer wg.Done()
				if err := a.Unregister(unregCtx); err != nil {
					slog.Debug("Unregister error", "ext", a.Ext, "err", err)
				}
			}(ag)
		}
		wg.Wait()
	} else {
		slog.Info("--no-unregister: skipping unregistration")
	}

	// Close transports
	slog.Info("Closing transports")
	for _, ag := range agents {
		ag.Close()
	}

	collector.SetPhase("DONE")

	// Final metrics flush + log (matches Python step 6)
	snap := collector.Latest()
	snapJSON, _ := json.Marshal(snap)
	slog.Info("Final metrics: " + string(snapJSON))

	// Write traffic_summary_*.log (matches Python write_traffic_summary)
	writeTrafficSummary(collector, cfg, "logs", runID, pairID, eng, agents)

	slog.Info("SIP cleanup complete — metrics server still serving")
}

func postPeerStop(peerURL string) {
	parsed, err := url.Parse(peerURL)
	if err != nil {
		return
	}
	hostname := parsed.Hostname()
	if hostname == "" {
		hostname = "localhost"
	}
	portStr := parsed.Port()
	port := 8081
	if portStr != "" {
		if p, err := strconv.Atoi(portStr); err == nil {
			port = p
		}
	}
	portsToTry := []int{port}
	for _, p := range []int{8081, 8082, 8083} {
		found := false
		for _, existing := range portsToTry {
			if existing == p {
				found = true
				break
			}
		}
		if !found {
			portsToTry = append(portsToTry, p)
		}
	}

	client := &http.Client{Timeout: 3 * time.Second}
	for _, p := range portsToTry {
		u := fmt.Sprintf("%s://%s:%d%s", parsed.Scheme, hostname, p, parsed.Path)
		slog.Info("Signaling UAS shutdown", "url", u)
		resp, err := client.Post(u, "application/json", nil)
		if err == nil {
			resp.Body.Close()
			return
		}
		slog.Debug("POST peer_stop failed", "url", u, "err", err)
	}
	slog.Warn("POST to peer_stop_url failed on all ports")
}

func writeRunJSON(collector *metrics.MetricsCollector, cfg *config.VMConfig, runID, pairID, logDir string) {
	os.MkdirAll(logDir, 0755)
	path := fmt.Sprintf("%s/run-%s_%s_%s.json", logDir, runID, pairID, cfg.VMID)

	results := collector.GetCallResultsAsDicts()
	spines := collector.GetAllEvents()
	summary := collector.GetFinalSummary()
	snap := collector.Latest()

	summary["calls_attempted"] = snap.CallsAttempted
	summary["calls_completed"] = snap.CallsCompleted
	summary["calls_failed"] = snap.CallsFailed
	summary["asr"] = snap.ASR

	output := map[string]any{
		"run_id":       runID,
		"pair_id":      pairID,
		"vm_id":        cfg.VMID,
		"vm_role":      cfg.VMRole,
		"call_results": results,
		"call_spines":  spines,
		"summary":      summary,
	}

	data, err := json.MarshalIndent(output, "", "  ")
	if err != nil {
		slog.Error("Failed to marshal run JSON", "err", err)
		return
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		slog.Error("Failed to write run JSON", "path", path, "err", err)
		return
	}
	slog.Info("Run JSON written", "path", path)
}

// writeTrafficSummary writes a human-readable summary log matching the Python
// write_traffic_summary format: traffic_summary_<runID>_<pairID>_<vmID>.log
func writeTrafficSummary(
	collector *metrics.MetricsCollector,
	cfg *config.VMConfig,
	logDir string,
	runID, pairID string,
	eng *engine.CallEngine,
	agents map[string]*agent.ExtensionAgent,
) {
	vmID := cfg.VMID
	path := fmt.Sprintf("%s/traffic_summary_%s_%s_%s.log", logDir, runID, pairID, vmID)
	os.MkdirAll(logDir, 0755)

	results := collector.GetCallResultsCopy()
	snap := collector.Latest()
	sipC := collector.GetSIPCounters()

	// SIP ephemeral ports
	sipPortsByExt := make(map[string]int)
	for ext, ag := range agents {
		port := ag.LocalPort()
		if port != 0 {
			sipPortsByExt[ext] = port
		}
	}

	// RTP UDP ports
	type rtpEntry struct {
		caller, callee string
		port           int
	}
	var rtpPorts []rtpEntry
	for _, r := range results {
		if r.RTPLocalPort > 0 && r.RTPLocalPort != 9 {
			rtpPorts = append(rtpPorts, rtpEntry{r.Caller, r.Callee, r.RTPLocalPort})
		}
	}

	// Media verification
	var mediaVerified, mediaTotal int
	for _, r := range results {
		if r.Success {
			mediaTotal++
			if r.MediaVerified {
				mediaVerified++
			}
		}
	}

	// Peak concurrent (UAC only)
	peakConcurrent := 0
	if eng != nil {
		peakConcurrent = eng.PeakActiveCalls()
	}

	// Pool wrap pairings
	pairingsByWrap := make(map[int][]struct{ caller, callee string })
	for _, r := range results {
		if r.Caller != "remote" {
			pairingsByWrap[r.PoolWrapIndex] = append(pairingsByWrap[r.PoolWrapIndex], struct{ caller, callee string }{r.Caller, r.Callee})
		}
	}

	var lines []string
	lines = append(lines, strings.Repeat("=", 70))
	lines = append(lines, fmt.Sprintf("TRAFFIC RUN SUMMARY — %s — %s", vmID, cfg.VMRole))
	lines = append(lines, fmt.Sprintf("Timestamp: %s", time.Now().Format("2006-01-02T15:04:05.000000")))
	lines = append(lines, strings.Repeat("=", 70))
	lines = append(lines, "")
	lines = append(lines, "--- Overall metrics ---")
	lines = append(lines, fmt.Sprintf("  calls_attempted:  %d", snap.CallsAttempted))
	lines = append(lines, fmt.Sprintf("  calls_completed:  %d", snap.CallsCompleted))
	lines = append(lines, fmt.Sprintf("  calls_failed:     %d", snap.CallsFailed))
	lines = append(lines, fmt.Sprintf("  ASR:              %.1f%%", snap.ASR))
	lines = append(lines, fmt.Sprintf("  avg_pdd_ms:       %.2f", snap.AvgPDDMs))
	lines = append(lines, fmt.Sprintf("  avg_hold_ms:      %.2f", snap.AvgHoldMs))
	lines = append(lines, fmt.Sprintf("  avg_total_ms:     %.2f", snap.AvgTotalMs))
	if peakConcurrent > 0 {
		lines = append(lines, fmt.Sprintf("  peak_concurrent:  %d", peakConcurrent))
	}
	lines = append(lines, "")

	if cfg.IsUAC() {
		lines = append(lines, "--- SIP message counters (UAC) ---")
		lines = append(lines, fmt.Sprintf("  invites_sent:       %d", sipC.InvitesSent))
		lines = append(lines, fmt.Sprintf("  acks_sent:          %d", sipC.AcksSent))
		lines = append(lines, fmt.Sprintf("  byes_sent:          %d", sipC.ByesSent))
		lines = append(lines, fmt.Sprintf("  bye_200_received:   %d", sipC.Bye200Received))
	} else {
		lines = append(lines, "--- SIP message counters (UAS) ---")
		lines = append(lines, fmt.Sprintf("  invites_received:   %d", sipC.InvitesReceived))
		lines = append(lines, fmt.Sprintf("  acks_received:      %d", sipC.AcksReceived))
		lines = append(lines, fmt.Sprintf("  byes_received:      %d", sipC.ByesReceived))
		lines = append(lines, fmt.Sprintf("  bye_200_sent:       %d", sipC.Bye200Sent))
	}
	lines = append(lines, "")

	lines = append(lines, "--- RTP media verification ---")
	lines = append(lines, fmt.Sprintf("  MEDIA_VERIFIED:   %d / %d successful calls", mediaVerified, mediaTotal))
	mediaFailed := mediaTotal - mediaVerified
	if mediaFailed > 0 {
		lines = append(lines, fmt.Sprintf("  MEDIA_FAILED:     %d", mediaFailed))
	}
	lines = append(lines, "")

	lines = append(lines, "--- Ephemeral SIP ports (used and closed by extensions) ---")
	if len(sipPortsByExt) > 0 {
		sortedExts := sortedKeys(sipPortsByExt)
		for _, ext := range sortedExts {
			lines = append(lines, fmt.Sprintf("  ext %s: port %d", ext, sipPortsByExt[ext]))
		}
	} else {
		lines = append(lines, "  (none recorded)")
	}
	lines = append(lines, "")

	lines = append(lines, "--- UDP RTP ports (created and closed per call) ---")
	if len(rtpPorts) > 0 {
		limit := 50
		for i, rp := range rtpPorts {
			if i >= limit {
				break
			}
			lines = append(lines, fmt.Sprintf("  %s -> %s: port %d", rp.caller, rp.callee, rp.port))
		}
		if len(rtpPorts) > limit {
			lines = append(lines, fmt.Sprintf("  ... and %d more", len(rtpPorts)-limit))
		}
	} else {
		lines = append(lines, "  (none recorded)")
	}
	lines = append(lines, "")

	if len(pairingsByWrap) > 0 {
		lines = append(lines, "--- UAC-to-UAS call pairings by pool wrap ---")
		sortedWraps := sortedIntKeys(pairingsByWrap)
		for _, wrap := range sortedWraps {
			lines = append(lines, fmt.Sprintf("  Wrap %d:", wrap+1))
			for _, pair := range pairingsByWrap[wrap] {
				lines = append(lines, fmt.Sprintf("    %s -> %s", pair.caller, pair.callee))
			}
		}
	}
	lines = append(lines, "")

	lines = append(lines, "--- Config ---")
	lines = append(lines, fmt.Sprintf("  cps: %d  hold_time_seconds: %d", cfg.CPS, cfg.HoldTimeSeconds))
	lines = append(lines, fmt.Sprintf("  uac_ext: %d-%d", cfg.UACExtStart, cfg.UACExtEnd))
	lines = append(lines, fmt.Sprintf("  uas_ext: %d-%d", cfg.UASExtStart, cfg.UASExtEnd))
	lines = append(lines, strings.Repeat("=", 70))

	content := strings.Join(lines, "\n")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		slog.Warn("Could not write traffic summary", "err", err)
	} else {
		slog.Info("Traffic summary written", "path", path)
	}
}

func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	// Sort numerically by converting to int, fall back to string sort
	sort.Slice(keys, func(i, j int) bool {
		ni, ei := strconv.Atoi(keys[i])
		nj, ej := strconv.Atoi(keys[j])
		if ei == nil && ej == nil {
			return ni < nj
		}
		return keys[i] < keys[j]
	})
	return keys
}

func sortedIntKeys[V any](m map[int]V) []int {
	keys := make([]int, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Ints(keys)
	return keys
}

func createAgents(cfg *config.VMConfig) map[string]*agent.ExtensionAgent {
	agents := make(map[string]*agent.ExtensionAgent)
	var extStart, extEnd int
	if cfg.IsUAC() {
		extStart = cfg.UACExtStart
		extEnd = cfg.UACExtEnd
	} else {
		extStart = cfg.UASExtStart
		extEnd = cfg.UASExtEnd
	}
	slog.Info("Creating agents", "start", extStart, "end", extEnd, "count", extEnd-extStart+1)
	for ext := extStart; ext <= extEnd; ext++ {
		extStr := strconv.Itoa(ext)
		agents[extStr] = agent.NewExtensionAgent(extStr, cfg)
	}
	return agents
}

func agentsToSlice(agents map[string]*agent.ExtensionAgent) []*agent.ExtensionAgent {
	out := make([]*agent.ExtensionAgent, 0, len(agents))
	for _, a := range agents {
		out = append(out, a)
	}
	return out
}

func connectTransportsBatched(ctx context.Context, agents map[string]*agent.ExtensionAgent, cfg *config.VMConfig) error {
	allAgents := agentsToSlice(agents)
	total := len(allAgents)
	batchSize := cfg.RegisterRate
	if batchSize <= 0 {
		batchSize = 10
	}

	slog.Info("Connecting transports in batches", "total", total, "batch_size", batchSize)

	for batchStart := 0; batchStart < total; batchStart += batchSize {
		batchEnd := batchStart + batchSize
		if batchEnd > total {
			batchEnd = total
		}
		batch := allAgents[batchStart:batchEnd]
		batchNum := batchStart/batchSize + 1

		slog.Info("Transport batch connecting",
			"batch", batchNum, "count", len(batch),
			"from", batch[0].Ext, "to", batch[len(batch)-1].Ext,
		)

		var wg sync.WaitGroup
		var firstErr error
		var errOnce sync.Once
		for _, ag := range batch {
			wg.Add(1)
			go func(a *agent.ExtensionAgent) {
				defer wg.Done()
				if err := a.Start(ctx); err != nil {
					errOnce.Do(func() { firstErr = err })
					slog.Error("Agent start failed", "ext", a.Ext, "err", err)
				}
			}(ag)
		}
		wg.Wait()

		if firstErr != nil {
			return firstErr
		}

		slog.Info("Transport batch connected", "batch", batchNum, "count", len(batch))

		if batchEnd < total {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	return nil
}

func runAPIOnly(port int, logLevel string, guiDrainSeconds int) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	processExitCh := make(chan struct{}, 1)

	// Second Ctrl+C triggers immediate exit (interruptible GUI drain)
	secondSigCh := make(chan struct{}, 1)
	sigCount := 0
	var sigMu sync.Mutex

	sigCh := make(chan os.Signal, 2)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		for sig := range sigCh {
			sigMu.Lock()
			sigCount++
			n := sigCount
			sigMu.Unlock()

			if n == 1 {
				slog.Info("Signal received, initiating shutdown", "signal", sig)
				cancel()
				select {
				case processExitCh <- struct{}{}:
				default:
				}
			} else {
				slog.Info("Second signal received, forcing immediate exit", "signal", sig)
				select {
				case secondSigCh <- struct{}{}:
				default:
				}
			}
		}
	}()

	collector := metrics.NewMetricsCollector("unconfigured", 3)
	collector.SetPhase("IDLE")

	pctx := metrics.NewProcessContext(collector, port)
	pctx.ProcessExit = processExitCh
	pctx.LogLevel = logLevel

	// Channel signalled when lifecycle goroutine finishes
	lifecycleDone := make(chan struct{}, 1)
	var lifecycleRunning sync.Mutex

	// Wire the config validation callback — called by PUT /api/config.
	pctx.OnConfigReceived = func(body map[string]any) (string, string, string, any, error) {
		cfg, err := config.ConfigFromDict(body)
		if err != nil {
			return "", "", "", nil, err
		}
		yamlFilename := strings.ToLower(cfg.VMRole) + ".yaml"
		yamlPath, err := config.WriteConfigYAML(cfg, yamlFilename)
		if err != nil {
			return "", "", "", nil, fmt.Errorf("failed to write YAML: %w", err)
		}
		return cfg.VMID, cfg.VMRole, yamlPath, cfg, nil
	}

	// Wire the lifecycle start callback — called by POST /api/test/start.
	pctx.StartFunc = func() {
		pctx.Mu.Lock()
		cfg, ok := pctx.Config.(*config.VMConfig)
		runID := pctx.RunID
		pairID := pctx.PairID
		pctx.Mu.Unlock()

		if !ok || cfg == nil {
			slog.Error("StartFunc: no valid VMConfig on ProcessContext")
			pctx.Mu.Lock()
			pctx.State = "FAILED"
			pctx.Mu.Unlock()
			collector.SetPhase("FAILED")
			return
		}

		maxCalls := 0
		if cfg.IsUAC() {
			switch cfg.TrafficMode {
			case "smoke":
				maxCalls = cfg.CallCount
			case "timed":
				maxCalls = int(float64(cfg.CPS) * cfg.DurationHours * 3600)
			}
		}

		logFile := autoLogFile(runID, pairID, cfg.VMID, "logs")
		setupFileLogging(logLevel, logFile)

		slog.Info("Traffic lifecycle starting via API",
			"vm_id", cfg.VMID, "role", cfg.VMRole,
			"run_id", runID, "pair_id", pairID,
			"max_calls", maxCalls,
		)

		lifecycleRunning.Lock()
		exitCode := runLifecycle(cfg, false, maxCalls, false, false, false, 0, runID, pairID, "logs")
		lifecycleRunning.Unlock()

		pctx.Mu.Lock()
		if exitCode == 0 {
			pctx.State = "COMPLETE"
		} else {
			pctx.State = "FAILED"
		}
		pctx.Mu.Unlock()

		setupLogging(logLevel)
		slog.Info("Traffic lifecycle finished", "exit_code", exitCode)

		select {
		case lifecycleDone <- struct{}{}:
		default:
		}
	}

	stopCh := make(chan struct{})
	actualPort, err := metrics.StartServer(collector, "unconfigured", "unconfigured", port, stopCh, pctx)
	if err != nil {
		slog.Error("Could not start API server", "err", err)
		return 1
	}
	slog.Info("API server started", "port", actualPort)

	slog.Info("============================================================")
	slog.Info("GUI-DRIVEN mode — server running", "port", actualPort)
	slog.Info("  PUT /api/config | POST /api/test/start | GET /api/ping")
	slog.Info("============================================================")

	// Wait for process exit (Ctrl+C, SIGTERM, or POST /api/shutdown)
	select {
	case <-ctx.Done():
	case <-processExitCh:
	}

	// If lifecycle is still running, wait for it to complete (up to 60s)
	// This matches Python: await asyncio.wait_for(ctx._lifecycle_task, timeout=60.0)
	if lifecycleRunning.TryLock() {
		lifecycleRunning.Unlock()
	} else {
		slog.Info("Waiting for traffic lifecycle to complete shutdown (up to 60s)")
		select {
		case <-lifecycleDone:
			slog.Info("Traffic lifecycle shutdown complete")
		case <-time.After(60 * time.Second):
			slog.Warn("Lifecycle task did not finish in 60s")
		case <-secondSigCh:
			slog.Info("GUI drain interrupted — exiting immediately")
			close(stopCh)
			return 0
		}
	}

	// Brief drain so GUI can fetch last data before process dies
	// Interruptible by second Ctrl+C (matches Python asyncio.CancelledError)
	if guiDrainSeconds > 0 {
		slog.Info("GUI drain: keeping server alive",
			"seconds", guiDrainSeconds,
			"phase", "DONE, all endpoints serving final data",
		)
		select {
		case <-time.After(time.Duration(guiDrainSeconds) * time.Second):
		case <-secondSigCh:
			slog.Info("GUI drain interrupted — exiting immediately")
		}
	}

	close(stopCh)
	slog.Info("API-only shutdown complete")
	return 0
}

func callResultToMetrics(r engine.CallResult) metrics.CallResultData {
	return metrics.CallResultData{
		CallID:           r.CallID,
		Caller:           r.Caller,
		Callee:           r.Callee,
		Success:          r.Success,
		FailureReason:    r.FailureReason,
		PDDMs:            r.PDDMs,
		HoldMs:           r.HoldMs,
		TotalMs:          r.TotalMs,
		RTPTxPkts:        r.RTPTxPkts,
		RTPRxPkts:        r.RTPRxPkts,
		MediaVerified:    r.MediaVerified,
		RTPLocalPort:     r.RTPLocalPort,
		PoolWrapIndex:    r.PoolWrapIndex,
		PeerExt:          r.PeerExt,
		TsUTC:            r.TsUTC,
		Direction:        r.Direction,
		SBCRTPRelayIP:    r.SBCRTPRelayIP,
		SBCRTPRelayPort:  r.SBCRTPRelayPort,
		RTPRxFromSBCPkts: r.RTPRxFromSBCPkts,
		RTPRxOtherPkts:   r.RTPRxOtherPkts,
		RTCPRxPkts:       r.RTCPRxPkts,
		RTPAsymmetryFlag: r.RTPAsymmetryFlag,
		MarkersSent:      r.MarkersSent,
		MarkersReceived:  r.MarkersReceived,
		Scenario:         r.Scenario,
	}
}

// Logging setup

func setupLogging(level string) {
	lvl := slog.LevelInfo
	switch strings.ToUpper(level) {
	case "DEBUG":
		lvl = slog.LevelDebug
	case "WARNING", "WARN":
		lvl = slog.LevelWarn
	case "ERROR":
		lvl = slog.LevelError
	}
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: lvl})))
}

func setupFileLogging(level, path string) {
	dir := ""
	if idx := strings.LastIndex(path, "/"); idx >= 0 {
		dir = path[:idx]
	}
	if dir != "" {
		os.MkdirAll(dir, 0755)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		slog.Warn("Could not open log file", "path", path, "err", err)
		return
	}

	lvl := slog.LevelInfo
	switch strings.ToUpper(level) {
	case "DEBUG":
		lvl = slog.LevelDebug
	case "WARNING", "WARN":
		lvl = slog.LevelWarn
	case "ERROR":
		lvl = slog.LevelError
	}

	slog.SetDefault(slog.New(slog.NewTextHandler(f, &slog.HandlerOptions{Level: lvl})))
	slog.Info("Log file opened", "path", path)
}

func autoLogFile(runID, pairID, vmID, logDir string) string {
	return fmt.Sprintf("%s/traffic_%s_%s_%s.log", logDir, runID, pairID, vmID)
}

// Env helpers

func envStr(key, defaultVal string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return defaultVal
}

func envBool(key string) bool {
	v := strings.ToLower(os.Getenv(key))
	return v == "1" || v == "true" || v == "yes"
}

func envInt(key string, defaultVal int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return defaultVal
}
