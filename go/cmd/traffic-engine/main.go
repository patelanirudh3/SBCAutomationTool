package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log/slog"
	"math"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/engine"
	"github.com/cci/traffic-engine/internal/metrics"
	"github.com/cci/traffic-engine/internal/prephase"
	"github.com/cci/traffic-engine/internal/spine"
	"github.com/cci/traffic-engine/internal/version"
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
	slog.Info(version.ProductName,
		"pid", os.Getpid(),
		"version", version.Version,
		"log_level", *logLevel,
	)
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
			"ext_range", fmt.Sprintf("%d-%d (%d)", cfg.ExtStart, cfg.ExtEnd, cfg.ExtCount()),
			"cps", cfg.CPS, "hold", cfg.HoldTimeSeconds,
			"concurrent", cfg.EffectiveMaxConcurrent(),
		)
		os.Exit(0)
	}

	// Derive max_calls
	maxCalls := *maxCallsFlag
	if maxCalls == 0 {
		switch cfg.TrafficMode {
		case "smoke":
			maxCalls = cfg.CallCount
		case "timed":
			maxCalls = int(float64(cfg.CPS) * cfg.DurationHours * 3600)
		}
	}
	if maxCalls == 0 {
		slog.Info("Traffic mode: unlimited (run until stopped)", "mode", cfg.TrafficMode)
	} else {
		slog.Info("Traffic mode resolved", "mode", cfg.TrafficMode, "max_calls", maxCalls)
	}

	exitCode := runLifecycle(cfg, *skipSubscribe, maxCalls, *prePhaseOnly, *noUnregister, *guiDrainSeconds, runID, pairID, *logDir, nil, nil, nil, nil)
	slog.Info("Process exiting", "pid", os.Getpid(), "code", exitCode)
	os.Exit(exitCode)
}

// runLifecycle runs the full single-pool traffic lifecycle.
//
// Phase state machine (GUI mode):
//
//	CONFIGURED → REGSUB_READY → REGSUB_RUNNING → REGSUB_DONE → TRAFFIC → CLEANUP_READY → DONE
//	(Optional async Prep flush is independent — invoked from REGSUB_READY via /api/prep/start.)
//
// In CLI mode (pctx == nil), every phase gate is skipped and the pipeline runs
// straight through.
//
// pctx, if non-nil, provides phase-gate channels (TrafficStartCh,
// CleanupStartCh, GracefulStopCh, InterruptStopCh).
// stopNew, if non-nil, is set to true by interrupted shutdown to halt
// RegisterAll/SubscribeAll from starting new batches.
func runLifecycle(
	cfg *config.VMConfig,
	skipSubscribe bool,
	maxCalls int,
	prePhaseOnly bool,
	noUnregister bool,
	guiDrainSeconds int,
	runID, pairID, logDir string,
	extCollector *metrics.MetricsCollector,
	extCtx context.Context,
	pctx *metrics.ProcessContext,
	stopNew *atomic.Bool,
) int {
	overallStart := time.Now()
	guiMode := extCollector != nil

	var collector *metrics.MetricsCollector
	var ctx context.Context
	var cancel context.CancelFunc

	if guiMode {
		collector = extCollector
		ctx, cancel = context.WithCancel(extCtx)
	} else {
		ctx, cancel = context.WithCancel(context.Background())
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT)
		go func() {
			sig := <-sigCh
			slog.Info("Signal received — initiating shutdown", "signal", sig)
			cancel()
		}()
		collector = metrics.NewMetricsCollector(cfg.VMID, cfg.MetricsInterval)
	}
	defer cancel()

	collector.SetPhase("INIT")

	// Start metrics HTTP server (CLI mode only — in GUI mode the shared server is already running)
	var stopCh chan struct{}
	if !guiMode {
		stopCh = make(chan struct{})
		actualPort, err := metrics.StartServer(collector, cfg.VMID, "", cfg.MetricsPort, stopCh, nil)
		if err != nil {
			slog.Warn("Could not start metrics server", "err", err)
		} else {
			slog.Info("Metrics server started", "port", actualPort)
		}
	}
	defer func() {
		if stopCh != nil {
			close(stopCh)
		}
	}()

	// Create and connect agents
	agents := createAgents(cfg)
	agentSlice := agentsToSlice(agents)
	slog.Info("Connecting transports", "count", len(agents))

	if err := connectTransportsBatched(ctx, agents, cfg); err != nil {
		slog.Error("Transport connection failed", "err", err)
		return 1
	}
	collector.UpdateCounts(0, len(agents), 0, 0)

	// Create pool engine and wire pool counts provider into the metrics collector
	pool := engine.NewPoolEngine()
	collector.SetPoolCountsProvider(func() (idle, nonIdle, regOnly int) {
		return pool.Counts()
	})

	// Create the UAS auto-answer engine (used for all agents in the new single-pool model)
	uasEngine := engine.NewUasAutoAnswer(
		agents, cfg,
		engine.WithUasOnComplete(func(r engine.CallResult) {
			collector.RecordCall(callResultToMetrics(r))
		}),
		engine.WithUasMetrics(collector),
	)

	// Start a per-agent auto-answer loop for every agent added to the idle pool.
	// The loop checks ag.AutoAnswerEnabled() before answering, so callers
	// (agents selected by PoolEngine.NextPair) won't pick up their own INVITE.
	agentAutoAnswerStops := make(map[string]func())

	onIdle := func(ag *agent.ExtensionAgent) {
		pool.AddToIdle(ag)
		stop := uasEngine.StartAutoAnswerForAgent(ctx, ag)
		agentAutoAnswerStops[ag.Ext] = stop
		slog.Debug("Agent added to idle pool", "ext", ag.Ext)
	}

	onRegOnly := func(ag *agent.ExtensionAgent) {
		pool.AddToRegOnly(ag)
		slog.Debug("Agent added to reg-only pool (sub failed)", "ext", ag.Ext)
	}

	if stopNew == nil {
		var sn atomic.Bool
		stopNew = &sn
	}

	// Wire optional async Prep handler (GUI mode only). The metrics server's
	// /api/prep/start handler invokes this in a goroutine and updates
	// collector.PrepStatus() before/after. Reads/writes of OnPrepStart are
	// guarded by pctx.Mu so the handler can poll for it during the brief
	// window between /api/test/start and connectTransportsBatched finishing.
	if pctx != nil {
		pctx.Mu.Lock()
		pctx.OnPrepStart = func() error {
			slog.Info("Prep flush starting via API", "ext_count", len(agentSlice))
			return prephase.RunPrep(ctx, agentSlice, cfg)
		}
		pctx.Mu.Unlock()
	}

	// ── REGSUB phase ─────────────────────────────────────────────────────────
	// GUI mode: wait for the operator to click "Start Reg/Sub" (the optional
	// Prep button is independent — see /api/prep/start handler in metrics.go).
	// CLI mode: run the legacy one-shot RunPrePhase (Phase 0 + 1 + 2).
	var (
		registeredAg    []*agent.ExtensionAgent
		failedRegister  []string
		failedSubscribe []string
		stopRegRefresh  = func() {}
		stopSubRefresh  = func() {}
	)

	if pctx != nil {
		// ── GUI mode: gated REG + SUB with live progress ─────────────────────
		collector.SetPhase("REGSUB_READY")
		slog.Info("REGSUB_READY — waiting for Start Reg/Sub signal", "ext_count", len(agents))

		select {
		case <-pctx.RegSubStartCh:
			slog.Info("Start Reg/Sub signal received via API")
		case <-pctx.PrePhaseStartCh:
			// Legacy alias — older clients still hit /api/prephase/start
			slog.Info("Start Reg/Sub signal received via legacy /api/prephase/start")
		case <-pctx.GracefulStopCh:
			slog.Info("Graceful stop received before Reg/Sub started")
			shutdownCleanup(ctx, agents, pool, nil, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)
			collector.SetPhase("DONE")
			return 0
		case <-pctx.InterruptStopCh:
			slog.Info("Interrupted stop received before Reg/Sub started")
			stopNew.Store(true)
			shutdownCleanup(ctx, agents, pool, nil, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)
			collector.SetPhase("DONE")
			return 0
		case <-ctx.Done():
			return 0
		}

		collector.SetPhase("REGSUB_RUNNING")
		// Wire RegSubAbortCh into stopNew so an Abort click cleanly halts new batches.
		go func() {
			select {
			case <-pctx.RegSubAbortCh:
				slog.Info("RegSub abort received — halting new batches")
				stopNew.Store(true)
			case <-ctx.Done():
			}
		}()

		// Live REG progress
		collector.SetRegisterTotal(len(agentSlice))
		regStart := time.Now()
		registeredAg, failedRegister, stopRegRefresh = prephase.RunRegister(
			ctx, agentSlice, cfg,
			func() { collector.IncrementRegistered() },
			stopNew,
		)
		slog.Info("REGISTER phase complete",
			"registered", len(registeredAg),
			"failed", len(failedRegister),
			"elapsed_s", fmt.Sprintf("%.1f", time.Since(regStart).Seconds()))

		// Live SUB progress (only if any agent registered)
		if len(registeredAg) > 0 {
			collector.SetSubscribeTotal(len(registeredAg) * len(cfg.SubscribeEvents))
			collector.SetSubscribeEventTotals(cfg.SubscribeEvents, len(registeredAg))
			subStart := time.Now()
			failedSubscribe, stopSubRefresh = prephase.RunSubscribe(
				ctx, registeredAg, cfg, skipSubscribe,
				onIdle, onRegOnly,
				func(event string, ok bool, notifyReceived bool) {
					collector.RecordSubscriptionEvent(event, ok, notifyReceived)
				},
				stopNew,
			)
			slog.Info("SUBSCRIBE phase complete",
				"subscribed", len(registeredAg)-len(failedSubscribe),
				"failed", len(failedSubscribe),
				"elapsed_s", fmt.Sprintf("%.1f", time.Since(subStart).Seconds()))
		} else {
			slog.Error("REG/SUB: no extensions registered — skipping SUBSCRIBE")
		}
	} else {
		// ── CLI mode: legacy monolithic pipeline (Phase 0 + 1 + 2) ───────────
		collector.SetPhase("PRE_REGISTER")
		slog.Info("Starting pre-phase (Flush + Register + Subscribe)")
		preResult, stopRefresh := prephase.RunPrePhase(
			ctx, agentSlice, cfg, skipSubscribe,
			onIdle, onRegOnly, stopNew,
		)
		defer stopRefresh()
		registeredAg = make([]*agent.ExtensionAgent, 0, preResult.Registered)
		// In CLI mode the registered/failed lists are not exposed by RunPrePhase
		// in agent form; we only need them for cleanup which iterates `agents`.
		failedRegister = preResult.FailedRegister
		failedSubscribe = preResult.FailedSubscribe
	}

	defer stopRegRefresh()
	defer stopSubRefresh()

	registered := len(registeredAg)
	if pctx == nil {
		// Reconstitute count from CLI-mode RunPrePhase result for the log line below
		registered = len(agents) - len(failedRegister)
	}
	subscribed := registered - len(failedSubscribe)

	collector.UpdateCounts(0, len(agents), registered, subscribed)

	slog.Info("REG/SUB phase complete",
		"total", len(agents),
		"registered", registered,
		"subscribed", subscribed,
		"failed_reg", len(failedRegister),
		"failed_sub", len(failedSubscribe),
	)

	if prePhaseOnly {
		slog.Info("PRE-PHASE-ONLY mode — waiting for signal to exit")
		collector.SetPhase("READY_PRE_PHASE_ONLY")
		<-ctx.Done()
		shutdownCleanup(ctx, agents, pool, nil, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)
		collector.SetPhase("DONE")
		return 0
	}

	// ── Wait for "Start Traffic" gate (GUI mode) ─────────────────────────────
	collector.SetPhase("REGSUB_DONE")
	idle, _, _ := pool.Counts()
	slog.Info("REGSUB_DONE — waiting for Start Traffic signal", "idle_agents", idle)

	if pctx != nil {
		// GUI mode: block until either traffic is started or a stop is requested
		select {
		case <-pctx.TrafficStartCh:
			slog.Info("Start Traffic signal received via API")
		case <-pctx.CleanupStartCh:
			// Operator clicked "Unregister All" from the REGSUB_DONE view —
			// skip traffic entirely and go straight to cleanup.
			slog.Info("Cleanup signal received from REGSUB_DONE — skipping traffic")
			shutdownCleanup(ctx, agents, pool, nil, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)
			collector.SetPhase("DONE")
			return 0
		case <-pctx.GracefulStopCh:
			slog.Info("Graceful stop received before traffic started")
			shutdownCleanup(ctx, agents, pool, nil, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)
			collector.SetPhase("DONE")
			return 0
		case <-pctx.InterruptStopCh:
			slog.Info("Interrupted stop received before traffic started")
			stopNew.Store(true)
			shutdownCleanup(ctx, agents, pool, nil, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)
			collector.SetPhase("DONE")
			return 0
		case <-ctx.Done():
			return 0
		}
	}
	// In CLI mode: proceed immediately to traffic

	// ── Traffic phase (loop, supports Restart Traffic from Complete) ─────────
trafficLoop:
	for {
		collector.SetPhase("TRAFFIC")
		collector.SetRunning(true)

		// Timed-mode hard deadline (re-derived per iteration so a Restart
		// gets a fresh duration window).
		trafficCtx := ctx
		var trafficCancel context.CancelFunc = func() {}
		callCtx, callCancel := context.WithCancel(ctx)
		if cfg.TrafficMode == "timed" && cfg.DurationHours > 0 {
			deadline := time.Duration(cfg.DurationHours * float64(time.Hour))
			trafficCtx, trafficCancel = context.WithTimeout(ctx, deadline)
			slog.Info("Traffic deadline set",
				"duration_hours", cfg.DurationHours,
				"deadline", time.Now().Add(deadline).Format(time.RFC3339),
			)
		}

		callEngine := engine.NewCallEngine(
			pool, cfg,
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

		slog.Info("Traffic starting",
			"cps", cfg.CPS, "hold_s", cfg.HoldTimeSeconds,
			"max_concurrent", cfg.EffectiveMaxConcurrent(),
			"ramp_s", cfg.RampUpSeconds, "max_calls", maxCalls,
			"idle_agents", idle,
		)

		engineDone := make(chan error, 1)
		go func() {
			engineDone <- callEngine.RunWithCallContext(trafficCtx, callCtx)
		}()

		// Monitor phase-gate channels during traffic
		if pctx != nil {
			for {
				select {
				case <-trafficCtx.Done():
					callEngine.Stop()
					<-engineDone
					goto trafficDone

				case err := <-engineDone:
					if err != nil {
						slog.Warn("Call engine stopped with error", "err", err)
					}
					goto trafficDone

				case <-pctx.GracefulStopCh:
					slog.Info("Graceful stop received — draining in-flight calls")
					callEngine.Stop()
					<-engineDone
					goto trafficDone

				case <-pctx.InterruptStopCh:
					slog.Info("Interrupted stop received — cancelling in-flight calls")
					trafficCancel()
					callCancel()
					callEngine.Stop()
					<-engineDone
					goto trafficDone
				}
			}
		} else {
			// CLI mode: wait for engine or context cancellation
			select {
			case <-trafficCtx.Done():
				callEngine.Stop()
				<-engineDone
			case err := <-engineDone:
				if err != nil {
					slog.Warn("Call engine stopped with error", "err", err)
				}
			}
		}

	trafficDone:
		trafficCancel()
		callCancel()
		collector.SetPhase("STOPPING")
		collector.SetRunning(false)
		slog.Info("Traffic phase complete (this iteration)")

		// ── CLEANUP_READY gate (GUI mode) ────────────────────────────────────
		// Operator can pick Restart Traffic (re-enter loop with same pool)
		// or Cleanup (drop out and unregister all).
		collector.SetPhase("CLEANUP_READY")
		slog.Info("CLEANUP_READY — waiting for Cleanup or Restart Traffic signal")

		if pctx != nil {
			select {
			case <-pctx.RestartTrafficCh:
				slog.Info("Restart Traffic received — re-running traffic with current pool")
				continue trafficLoop
			case <-pctx.CleanupStartCh:
				slog.Info("Cleanup signal received via API")
				break trafficLoop
			case <-ctx.Done():
				break trafficLoop
			}
		}
		// CLI mode: proceed immediately to cleanup
		break trafficLoop
	}

	// Build call spines (using local results split by direction — no remote peer fetch)
	buildAndStoreSpines(collector)

	// ── Cleanup ───────────────────────────────────────────────────────────────
	// callEngine has already been stopped + drained by the traffic loop before
	// breaking out, so we pass nil here (shutdownCleanup tolerates nil eng).
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer shutdownCancel()
	shutdownCleanup(shutdownCtx, agents, pool, nil, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)

	// Stop all per-agent auto-answer loops
	for _, stop := range agentAutoAnswerStops {
		stop()
	}

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

	writeRunJSON(collector, cfg, runID, pairID, logDir)

	collector.SetPhase("DONE")
	slog.Info("Phase set to DONE — all post-run data ready")

	if guiDrainSeconds > 0 {
		slog.Info("GUI drain: keeping metrics server alive", "seconds", guiDrainSeconds)
		select {
		case <-time.After(time.Duration(guiDrainSeconds) * time.Second):
		case <-ctx.Done():
		}
	}

	return 0
}

// buildAndStoreSpines builds correlated call spines from locally collected
// call results. In the single-pool model both caller (UAC) and callee (UAS)
// legs are recorded locally; the direction field distinguishes them.
func buildAndStoreSpines(collector *metrics.MetricsCollector) {
	allCalls := collector.GetCallResultsAsDicts()

	var uacCalls, uasCalls []map[string]any
	for _, r := range allCalls {
		dir, _ := r["direction"].(string)
		if dir == "uas" {
			uasCalls = append(uasCalls, r)
		} else {
			uacCalls = append(uacCalls, r)
		}
	}

	callSpines := spine.BuildCallSpines(uacCalls, uasCalls)
	collector.StoreCallSpines(callSpines)

	correlated := 0
	for _, raw := range callSpines {
		if !strings.Contains(string(raw), `"unmatched"`) {
			correlated++
		}
	}
	slog.Info("Built call spines",
		"total", len(callSpines), "correlated", correlated,
		"uac_legs", len(uacCalls), "uas_legs", len(uasCalls),
	)
}

// shutdownCleanup stops the call engine and UAS auto-answer, then
// unregisters/unsubscribes all users and closes transports.
func shutdownCleanup(
	ctx context.Context,
	agents map[string]*agent.ExtensionAgent,
	pool *engine.PoolEngine,
	eng *engine.CallEngine,
	uas *engine.UasAutoAnswer,
	collector *metrics.MetricsCollector,
	cfg *config.VMConfig,
	runID, pairID, logDir string,
	noUnregister bool,
) {
	// Flip phase the instant cleanup starts so the GUI's polling/WS sees
	// CLEANING_UP on the very next tick, before we drain calls or unregister.
	collector.SetPhase("CLEANING_UP")

	// Stop call engine (no-op if already stopped)
	if eng != nil {
		eng.Stop()
		slog.Info("Draining active calls (BYE)")
		eng.DrainActiveCalls(ctx, 15*time.Second, agents)
	}

	// Stop UAS auto-answer engine
	if uas != nil {
		uas.Stop()
	}

	if !noUnregister {
		concurrency := cfg.SubscribeConcurrency
		if concurrency <= 0 {
			concurrency = 10
		}
		perExtTimeout := time.Duration(cfg.RegisterTimeout) * time.Second
		waves := (len(agents) + concurrency - 1) / concurrency
		outerTimeout := time.Duration(waves)*perExtTimeout + 10*time.Second

		var cleanupAgents []*agent.ExtensionAgent
		if pool != nil {
			cleanupAgents = pool.AllForCleanup()
		} else {
			cleanupAgents = agentsToSlice(agents)
		}

		// Seed the cleanup-status counters now that we know the agent set.
		// Phase was already flipped to CLEANING_UP at the top of this fn.
		collector.ResetCleanup(len(cleanupAgents))

		slog.Info("Cleaning up extensions",
			"count", len(cleanupAgents),
			"concurrency", concurrency,
			"waves", waves,
			"outer_timeout_s", outerTimeout.Seconds(),
		)
		unregCtx, unregCancel := context.WithTimeout(ctx, outerTimeout)
		defer unregCancel()

		sem := make(chan struct{}, concurrency)
		var wg sync.WaitGroup
		for _, ag := range cleanupAgents {
			wg.Add(1)
			go func(a *agent.ExtensionAgent) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				unsubSkipped := !a.NeedsUnsubscribe()
				unsubOK := true
				if unsubSkipped {
					slog.Debug("Unsubscribe skipped", "ext", a.Ext, "event", a.SubscriptionEvent())
				} else {
					unsubErr := a.UnsubscribeWithProgress(unregCtx, func(event string, ok bool) {
						collector.RecordCleanupUnsubscribeEvent(event, ok)
					})
					unsubOK = unsubErr == nil
					if unsubErr != nil {
						slog.Debug("Unsubscribe error", "ext", a.Ext, "event", a.SubscriptionEvent(), "err", unsubErr)
					}
				}
				collector.IncrementCleanupUnsubscribe(a.Ext, unsubSkipped, unsubOK)
				unregErr := a.Unregister(unregCtx)
				if unregErr != nil {
					slog.Debug("Unregister error", "ext", a.Ext, "err", unregErr)
				}
				collector.IncrementCleanupUnregister(a.Ext, unregErr == nil)
			}(ag)
		}
		wg.Wait()
	} else {
		slog.Info("--no-unregister: skipping unregistration")
	}

	slog.Info("Closing transports")
	for _, ag := range agents {
		ag.Close()
	}

	snap := collector.Latest()
	snapJSON, _ := json.Marshal(snap)
	slog.Info("Final metrics: " + string(snapJSON))

	writeTrafficSummary(collector, cfg, logDir, runID, pairID, eng, agents)
	slog.Info("SIP cleanup complete — metrics server still serving")
}

func writeRunJSON(collector *metrics.MetricsCollector, cfg *config.VMConfig, runID, pairID, logDir string) {
	os.MkdirAll(logDir, 0755)
	path := fmt.Sprintf("%s/%s_%s_%s.json", logDir, runID, pairID, cfg.VMID)

	snap := collector.Latest()
	callEvents := collector.GetCallEvents()
	callSpines := collector.GetCallSpines()

	asr := 0.0
	if snap.CallsAttempted > 0 {
		asr = math.Round(float64(snap.CallsCompleted)/float64(snap.CallsAttempted)*1000) / 10
	}

	startedAt := ""
	endedAt := time.Now().UTC().Format(time.RFC3339Nano)
	if snap.RunElapsedSec > 0 {
		startTs := time.Now().Add(-time.Duration(snap.RunElapsedSec * float64(time.Second)))
		startedAt = startTs.UTC().Format(time.RFC3339Nano)
	}

	aggregate := map[string]any{
		"run_id":          runID,
		"pair_id":         pairID,
		"started_at":      startedAt,
		"ended_at":        endedAt,
		"total_attempted": snap.CallsAttempted,
		"total_completed": snap.CallsCompleted,
		"total_failed":    snap.CallsFailed,
		"aggregate_asr":   asr,
	}

	cfgMap := map[string]any{
		"vm_id":                        cfg.VMID,
		"ext_start":                    cfg.ExtStart,
		"ext_end":                      cfg.ExtEnd,
		"sbc_host":                     cfg.SBCHost,
		"sbc_port":                     cfg.SBCPort,
		"sip_transport":                cfg.SIPTransport,
		"domain":                       cfg.Domain,
		"cps":                          cfg.CPS,
		"hold_time_seconds":            cfg.HoldTimeSeconds,
		"ramp_up_seconds":              cfg.RampUpSeconds,
		"register_expires":             cfg.RegisterExpires,
		"subscribe_expires":            cfg.SubscribeExpires,
		"subscribe_events":             cfg.SubscribeEvents,
		"subscribe_refresh_events":     cfg.SubscribeRefreshEvents,
		"subscribe_unsubscribe_events": cfg.SubscribeUnsubscribeEvents,
		"media_enabled":                cfg.MediaEnabled,
		"media_security":               cfg.MediaSecurity,
		"srtp_crypto_suites":           cfg.SRTPCryptoSuites,
		"metrics_port":                 cfg.MetricsPort,
		"traffic_mode":                 cfg.TrafficMode,
	}

	cleanupDetails := collector.CleanupDetailsSnapshot()
	cleanup := map[string]any{
		"count":                         cleanupDetails.Count,
		"total":                         cleanupDetails.Total,
		"failed_extensions":             cleanupDetails.Failed,
		"unsubscribe_count":             cleanupDetails.UnsubscribeCount,
		"unsubscribe_skipped":           cleanupDetails.UnsubscribeSkipped,
		"unsubscribe_failed_extensions": cleanupDetails.UnsubscribeFailed,
		"unregister_count":              cleanupDetails.UnregisterCount,
		"unregister_failed_extensions":  cleanupDetails.UnregisterFailed,
	}

	output := map[string]any{
		"generated_at":  time.Now().UTC().Format(time.RFC3339Nano),
		"run_id":        runID,
		"pair_id":       pairID,
		"vm_id":         cfg.VMID,
		"aggregate":     aggregate,
		"final_metrics": snap,
		"config":        cfgMap,
		"call_events":   callEvents,
		"call_spines":   callSpines,
		"cleanup":       cleanup,
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

	sipPortsByExt := make(map[string]int)
	for ext, ag := range agents {
		if port := ag.LocalPort(); port != 0 {
			sipPortsByExt[ext] = port
		}
	}

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

	var mediaVerified, mediaTotal int
	for _, r := range results {
		if r.Success {
			mediaTotal++
			if r.MediaVerified {
				mediaVerified++
			}
		}
	}

	peakConcurrent := 0
	if eng != nil {
		peakConcurrent = eng.PeakActiveCalls()
	}

	var lines []string
	lines = append(lines, strings.Repeat("=", 70))
	lines = append(lines, fmt.Sprintf("TRAFFIC RUN SUMMARY — %s", vmID))
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
	lines = append(lines, "--- SIP message counters ---")
	lines = append(lines, fmt.Sprintf("  invites_sent:       %d", sipC.InvitesSent))
	lines = append(lines, fmt.Sprintf("  acks_sent:          %d", sipC.AcksSent))
	lines = append(lines, fmt.Sprintf("  byes_sent:          %d", sipC.ByesSent))
	lines = append(lines, fmt.Sprintf("  bye_200_received:   %d", sipC.Bye200Received))
	lines = append(lines, fmt.Sprintf("  invites_received:   %d", sipC.InvitesReceived))
	lines = append(lines, fmt.Sprintf("  acks_received:      %d", sipC.AcksReceived))
	lines = append(lines, fmt.Sprintf("  byes_received:      %d", sipC.ByesReceived))
	lines = append(lines, fmt.Sprintf("  bye_200_sent:       %d", sipC.Bye200Sent))
	lines = append(lines, "")
	lines = append(lines, "--- RTP media verification ---")
	lines = append(lines, fmt.Sprintf("  MEDIA_VERIFIED:   %d / %d successful calls", mediaVerified, mediaTotal))
	if mediaFailed := mediaTotal - mediaVerified; mediaFailed > 0 {
		lines = append(lines, fmt.Sprintf("  MEDIA_FAILED:     %d", mediaFailed))
	}
	lines = append(lines, "")
	lines = append(lines, "--- Ephemeral SIP ports ---")
	if len(sipPortsByExt) > 0 {
		for _, ext := range sortedKeys(sipPortsByExt) {
			lines = append(lines, fmt.Sprintf("  ext %s: port %d", ext, sipPortsByExt[ext]))
		}
	} else {
		lines = append(lines, "  (none recorded)")
	}
	lines = append(lines, "")
	lines = append(lines, "--- UDP RTP ports ---")
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
	lines = append(lines, "--- Config ---")
	lines = append(lines, fmt.Sprintf("  cps: %d  hold_time_seconds: %d", cfg.CPS, cfg.HoldTimeSeconds))
	lines = append(lines, fmt.Sprintf("  ext_range: %d-%d (%d)", cfg.ExtStart, cfg.ExtEnd, cfg.ExtCount()))
	lines = append(lines, fmt.Sprintf("  register_expires: %d  subscribe_expires: %d", cfg.RegisterExpires, cfg.SubscribeExpires))
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

func createAgents(cfg *config.VMConfig) map[string]*agent.ExtensionAgent {
	agents := make(map[string]*agent.ExtensionAgent)
	slog.Info("Creating agents",
		"ext_start", cfg.ExtStart, "ext_end", cfg.ExtEnd,
		"count", cfg.ExtCount(),
	)
	for ext := cfg.ExtStart; ext <= cfg.ExtEnd; ext++ {
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
	sort.Slice(out, func(i, j int) bool {
		ni, _ := strconv.Atoi(out[i].Ext)
		nj, _ := strconv.Atoi(out[j].Ext)
		return ni < nj
	})
	return out
}

func connectTransportsBatched(ctx context.Context, agents map[string]*agent.ExtensionAgent, cfg *config.VMConfig) error {
	allAgents := agentsToSlice(agents)
	total := len(allAgents)
	batchSize := cfg.RegisterBatchSize
	if batchSize <= 0 {
		batchSize = 10
	}
	batchDelay := cfg.BatchDelay()

	slog.Info("Connecting transports in batches",
		"total", total,
		"batch_size", batchSize,
		"batch_delay_ms", batchDelay.Milliseconds(),
	)

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
			case <-time.After(batchDelay):
			}
		}
	}
	return nil
}

func runAPIOnly(port int, logLevel string, guiDrainSeconds int) int {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	processExitCh := make(chan struct{}, 1)

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

	lifecycleDone := make(chan struct{}, 1)
	var lifecycleRunning sync.Mutex

	// Wire config validation callback
	pctx.OnConfigReceived = func(body map[string]any) (string, string, string, any, error) {
		cfg, err := config.ConfigFromDict(body)
		if err != nil {
			return "", "", "", nil, err
		}
		yamlFilename := fmt.Sprintf("config_%s.yaml", cfg.VMID)
		yamlPath, err := config.WriteConfigYAML(cfg, yamlFilename)
		if err != nil {
			return "", "", "", nil, fmt.Errorf("failed to write YAML: %w", err)
		}
		return cfg.VMID, "", yamlPath, cfg, nil
	}

	// Wire the lifecycle start callback — triggered by POST /api/test/start
	// In the new model, this starts the goroutine which runs pre-phase immediately
	// (the operator gating is: pre-phase starts, then waits for TrafficStartCh)
	pctx.StartFunc = func() {
		pctx.Mu.Lock()
		cfg, ok := pctx.Config.(*config.VMConfig)
		runID := pctx.RunID
		pairID := pctx.PairID
		stopEvent := pctx.StopEvent
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
		switch cfg.TrafficMode {
		case "smoke":
			maxCalls = cfg.CallCount
		case "timed":
			maxCalls = int(float64(cfg.CPS) * cfg.DurationHours * 3600)
		}

		logFile := autoLogFile(runID, pairID, cfg.VMID, "logs")
		setupFileLogging(logLevel, logFile)

		slog.Info("Traffic lifecycle starting via API",
			"vm_id", cfg.VMID,
			"run_id", runID, "pair_id", pairID,
			"max_calls", maxCalls,
		)

		var stopNew atomic.Bool

		// Create context cancelled by StopEvent, GracefulStopCh, or InterruptStopCh
		stopCtx, stopCancel := context.WithCancel(ctx)
		go func() {
			select {
			case <-stopEvent:
				stopCancel()
			case <-stopCtx.Done():
			}
		}()

		lifecycleRunning.Lock()
		exitCode := runLifecycle(cfg, false, maxCalls, false, false, 0, runID, pairID, "logs", collector, stopCtx, pctx, &stopNew)
		lifecycleRunning.Unlock()

		stopCancel()

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
	actualPort, err := metrics.StartServer(collector, "unconfigured", "", port, stopCh, pctx)
	if err != nil {
		slog.Error("Could not start API server", "err", err)
		return 1
	}
	slog.Info("API server started", "port", actualPort, "pid", os.Getpid())

	slog.Info("============================================================")
	slog.Info("GUI-DRIVEN mode — server running", "port", actualPort, "pid", os.Getpid())
	slog.Info("------------------------------------------------------------")
	slog.Info("  PUT  /api/config            — push VM configuration")
	slog.Info("  POST /api/test/start        — start pre-phase (Reg/Sub) lifecycle")
	slog.Info("  POST /api/traffic/start     — start traffic (after pre-phase)")
	slog.Info("  POST /api/cleanup/start     — run cleanup (unsubscribe + unregister)")
	slog.Info("  POST /api/shutdown/graceful — drain in-flight calls and cleanup")
	slog.Info("  POST /api/shutdown/interrupt — cancel in-flight calls and cleanup")
	slog.Info("  POST /api/test/stop         — stop traffic")
	slog.Info("  POST /api/test/reset        — reset state to IDLE")
	slog.Info("  POST /api/shutdown          — graceful process shutdown")
	slog.Info("  GET  /api/ping              — health check")
	slog.Info("  GET  /api/test/status       — current phase/state")
	slog.Info("  GET  /api/calls             — call events (formatted)")
	slog.Info("  GET  /api/call-results      — raw call results")
	slog.Info("  GET  /api/call-spines       — correlated call spines")
	slog.Info("  GET  /api/scenarios         — available test scenarios")
	slog.Info("  GET  /metrics               — latest TrafficMetrics snapshot")
	slog.Info("  WS   /metrics/stream        — real-time metrics WebSocket")
	slog.Info("------------------------------------------------------------")
	slog.Info("Press Ctrl+C to initiate graceful shutdown")
	slog.Info("============================================================")

	select {
	case <-ctx.Done():
	case <-processExitCh:
	}

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

	if guiDrainSeconds > 0 {
		slog.Info("GUI drain: keeping server alive", "seconds", guiDrainSeconds)
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
	d := metrics.CallResultData{
		CallID:  r.CallID,
		Caller:  r.Caller,
		Callee:  r.Callee,
		Success: r.Success,
		// Answered = full INV/200/ACK three-way handshake completed.
		// UAC leg: ACK was sent after receiving 200 OK (AckSentMs > 0).
		// UAS leg: ACK was received from the caller (AckReceivedMs > 0).
		// Either side indicates the call was answered by the called party.
		Answered:            r.SipMilestones.AckSentMs > 0 || r.SipMilestones.AckReceivedMs > 0,
		FailureReason:       r.FailureReason,
		PDDMs:               r.PDDMs,
		HoldMs:              r.HoldMs,
		TotalMs:             r.TotalMs,
		RTPTxPkts:           r.RTPTxPkts,
		RTPRxPkts:           r.RTPRxPkts,
		MediaVerified:       r.MediaVerified,
		RTPLocalPort:        r.RTPLocalPort,
		MediaSecurity:       r.MediaSecurity,
		SRTPCryptoSuite:     r.SRTPCryptoSuite,
		SRTPDecryptFailures: r.SRTPDecryptFailures,
		SRTPAuthFailures:    r.SRTPAuthFailures,
		SRTPReplayFailures:  r.SRTPReplayFailures,
		PoolWrapIndex:       r.PoolWrapIndex,
		PeerExt:             r.PeerExt,
		TsUTC:               r.TsUTC,
		Direction:           r.Direction,
		SBCRTPRelayIP:       r.SBCRTPRelayIP,
		SBCRTPRelayPort:     r.SBCRTPRelayPort,
		RTPRxFromSBCPkts:    r.RTPRxFromSBCPkts,
		RTPRxOtherPkts:      r.RTPRxOtherPkts,
		RTCPRxPkts:          r.RTCPRxPkts,
		RTPAsymmetryFlag:    r.RTPAsymmetryFlag,
		MarkersSent:         r.MarkersSent,
		MarkersReceived:     r.MarkersReceived,
		RTPExpectedPkts:     r.RTPExpectedPkts,
		RTPSSRCCount:        r.RTPSSRCCount,
		Scenario:            r.Scenario,

		// Phase-1 QoS metrics
		JitterMs:            r.JitterMs,
		PacketLossPct:       r.PacketLossPct,
		LostPackets:         r.LostPackets,
		OOOPackets:          r.OOOPackets,
		RTTMs:               r.RTTMs,
		RemoteJitterMs:      r.RemoteJitterMs,
		RemoteLossPct:       r.RemoteLossPct,
		MOSScore:            r.MOSScore,
		MediaQualityFlag:    r.MediaQualityFlag,
		CallSetupMs:         r.CallSetupMs,
		PrackRTTMs:          r.PrackRTTMs,
		SipTransactionRTTMs: r.SipTransactionRTTMs,
		ByeCompletionMs:     r.ByeCompletionMs,
	}
	if raw, err := json.Marshal(r.SipMilestones); err == nil {
		d.SipMilestones = raw
	}
	return d
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

func parseLogLevel(level string) slog.Level {
	switch strings.ToUpper(level) {
	case "DEBUG":
		return slog.LevelDebug
	case "WARNING", "WARN":
		return slog.LevelWarn
	case "ERROR":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func setupLogging(level string) {
	lvl := parseLogLevel(level)
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

	consoleLvl := parseLogLevel(level)
	consoleHandler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: consoleLvl})
	fileHandler := slog.NewTextHandler(f, &slog.HandlerOptions{Level: slog.LevelDebug})
	slog.SetDefault(slog.New(newMultiHandler(consoleHandler, fileHandler)))
	slog.Info("Log file opened (dual: console+file)", "path", path, "console_level", level, "file_level", "DEBUG")
}

type multiHandler struct{ handlers []slog.Handler }

func newMultiHandler(handlers ...slog.Handler) *multiHandler {
	return &multiHandler{handlers: handlers}
}

func (m *multiHandler) Enabled(_ context.Context, level slog.Level) bool {
	for _, h := range m.handlers {
		if h.Enabled(context.Background(), level) {
			return true
		}
	}
	return false
}

func (m *multiHandler) Handle(ctx context.Context, r slog.Record) error {
	for _, h := range m.handlers {
		if h.Enabled(ctx, r.Level) {
			if err := h.Handle(ctx, r.Clone()); err != nil {
				return err
			}
		}
	}
	return nil
}

func (m *multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	handlers := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		handlers[i] = h.WithAttrs(attrs)
	}
	return &multiHandler{handlers: handlers}
}

func (m *multiHandler) WithGroup(name string) slog.Handler {
	handlers := make([]slog.Handler, len(m.handlers))
	for i, h := range m.handlers {
		handlers[i] = h.WithGroup(name)
	}
	return &multiHandler{handlers: handlers}
}

func autoLogFile(runID, pairID, vmID, logDir string) string {
	return fmt.Sprintf("%s/traffic_%s_%s_%s.log", logDir, runID, pairID, vmID)
}

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

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
