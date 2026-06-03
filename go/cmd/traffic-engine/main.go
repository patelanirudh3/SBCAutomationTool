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

	collector.SetPhase("CONNECTING_TRANSPORTS")

	// Create and connect agents
	agents := createAgents(cfg)
	agentSlice := agentsToSlice(agents)
	var secondaryCfg *config.VMConfig
	var secondaryAgents map[string]*agent.ExtensionAgent
	var secondaryAgentSlice []*agent.ExtensionAgent
	var secondaryRegisteredAg []*agent.ExtensionAgent
	var activeSubscribedAg []*agent.ExtensionAgent
	activeController := "primary"
	var haMoveMu sync.Mutex
	primaryDownCh := make(chan string, 1)
	var primaryRecoveredAt string
	slog.Info("Connecting transports", "count", len(agents))
	if cfg.DualRegistrationEnabled {
		for _, ag := range agents {
			ag.SetTransportDownHandler(func(ext string, err error) {
				select {
				case primaryDownCh <- ext:
				default:
				}
				collector.SetHAPrimaryRecovery(false, "")
				collector.RecordHAEvent("primary_down", "primary", fmt.Sprintf("ext=%s err=%v", ext, err))
				slog.Warn("Primary controller transport down", "ext", ext, "err", err)
			})
		}
	}

	connectedAgents, err := connectTransportsBatched(ctx, agents, cfg, collector)
	if err != nil {
		slog.Error("Transport connection failed", "err", err)
		collector.SetPhase("FAILED")
		if pctx != nil {
			pctx.Mu.Lock()
			pctx.State = "FAILED"
			pctx.Mu.Unlock()
		}
		return 1
	}
	if len(connectedAgents) < len(agents) {
		slog.Warn("Continuing with partial transport connectivity",
			"configured", len(agents),
			"connected", len(connectedAgents),
			"failed", len(agents)-len(connectedAgents),
		)
	}
	agents = connectedAgents
	agentSlice = agentsToSlice(agents)
	collector.UpdateCounts(0, len(agents), 0, 0)

	if cfg.DualRegistrationEnabled {
		secondaryCopy := *cfg
		secondaryCopy.SBCHost = cfg.SecondaryHost
		secondaryCopy.SBCPort = cfg.SecondaryPort
		secondaryCfg = &secondaryCopy
		secondaryAgents = createAgents(secondaryCfg)
		secondaryAgentSlice = agentsToSlice(secondaryAgents)
		slog.Info("Connecting secondary controller transports", "count", len(secondaryAgents), "host", cfg.SecondaryHost, "port", cfg.SecondaryPort)
		connectedSecondaryAgents, err := connectTransportsBatched(ctx, secondaryAgents, secondaryCfg, nil)
		if err != nil {
			slog.Error("Secondary transport connection failed", "err", err)
			collector.SetPhase("FAILED")
			if pctx != nil {
				pctx.Mu.Lock()
				pctx.State = "FAILED"
				pctx.Mu.Unlock()
			}
			return 1
		}
		if len(connectedSecondaryAgents) < len(secondaryAgents) {
			slog.Warn("Continuing with partial secondary transport connectivity",
				"configured", len(secondaryAgents),
				"connected", len(connectedSecondaryAgents),
				"failed", len(secondaryAgents)-len(connectedSecondaryAgents),
			)
		}
		secondaryAgents = connectedSecondaryAgents
		secondaryAgentSlice = agentsToSlice(secondaryAgents)
	}
	collector.SetHAStatus(cfg.DualRegistrationEnabled, activeController, 0, 0, 0, 0)
	if cfg.DualRegistrationEnabled {
		collector.SetHAPrimaryRecovery(true, "")
	}

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
	var agentAutoAnswerStopsMu sync.Mutex
	agentAutoAnswerStops := make(map[string]func())

	onIdle := func(ag *agent.ExtensionAgent) {
		pool.AddToIdle(ag)
		stop := uasEngine.StartAutoAnswerForAgent(ctx, ag)
		agentAutoAnswerStopsMu.Lock()
		agentAutoAnswerStops[ag.Ext] = stop
		agentAutoAnswerStopsMu.Unlock()
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
		pctx.OnHAMoveSubscription = func(target string) error {
			return fmt.Errorf("HA move is not ready until Reg/Sub completes")
		}
		pctx.Mu.Unlock()
	}

	// ── REGSUB phase ─────────────────────────────────────────────────────────
	// GUI mode: wait for the operator to click "Start Reg/Sub" (the optional
	// Prep button is independent — see /api/prep/start handler in metrics.go).
	// CLI mode: run the legacy one-shot RunPrePhase (Phase 0 + 1 + 2).
	var (
		registeredAg            []*agent.ExtensionAgent
		failedRegister          []string
		failedSubscribe         []string
		stopRegRefresh          = func() {}
		stopSubRefresh          = func() {}
		stopSecondaryRegRefresh = func() {}
	)

	cleanupAll := func(cleanupCtx context.Context, activeEngine *engine.CallEngine) {
		shutdownCleanup(cleanupCtx, agents, pool, activeEngine, uasEngine, collector, cfg, runID, pairID, logDir, noUnregister)
		if secondaryAgents != nil && secondaryCfg != nil && !noUnregister {
			stopSecondaryRegRefresh()
			stopSecondaryRegRefresh = func() {}
			unregisterSecondaryRegistrations(cleanupCtx, secondaryAgents, secondaryCfg)
		}
	}

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
			cleanupAll(ctx, nil)
			collector.SetPhase("DONE")
			return 0
		case <-pctx.InterruptStopCh:
			slog.Info("Interrupted stop received before Reg/Sub started")
			stopNew.Store(true)
			cleanupAll(ctx, nil)
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

		if cfg.DualRegistrationEnabled && len(secondaryAgentSlice) > 0 {
			secondaryRegStart := time.Now()
			var secondaryFailed []string
			secondaryRegisteredAg, secondaryFailed, stopSecondaryRegRefresh = prephase.RunRegister(
				ctx, secondaryAgentSlice, secondaryCfg,
				nil,
				stopNew,
			)
			slog.Info("SECONDARY REGISTER phase complete",
				"registered", len(secondaryRegisteredAg),
				"failed", len(secondaryFailed),
				"elapsed_s", fmt.Sprintf("%.1f", time.Since(secondaryRegStart).Seconds()))
			collector.SetHAStatus(true, activeController, len(registeredAg), len(secondaryRegisteredAg), 0, 0)
		}

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
			if cfg.DualRegistrationEnabled {
				collector.SetHAStatus(true, activeController, len(registeredAg), len(secondaryRegisteredAg), len(registeredAg)-len(failedSubscribe), 0)
			}
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

	for _, ext := range failedRegister {
		collector.RecordRegisterFailure(ext, fmt.Errorf("REGISTER failed after retry attempts"))
	}
	subscribeEvents := strings.Join(cfg.SubscribeEvents, ",")
	for _, ext := range failedSubscribe {
		collector.RecordSubscribeFailure(ext, subscribeEvents, fmt.Errorf("SUBSCRIBE failed after retry attempts"))
	}

	defer stopRegRefresh()
	defer stopSubRefresh()
	defer stopSecondaryRegRefresh()

	registered := len(registeredAg)
	if pctx == nil {
		// Reconstitute count from CLI-mode RunPrePhase result for the log line below
		registered = len(agents) - len(failedRegister)
	}
	subscribed := registered - len(failedSubscribe)
	activeSubscribedAg = agentsExceptExts(registeredAg, failedSubscribe)

	collector.UpdateCounts(0, len(agents), registered, subscribed)
	if cfg.DualRegistrationEnabled {
		collector.SetHAStatus(true, activeController, registered, len(secondaryRegisteredAg), len(activeSubscribedAg), 0)
		protected, degraded, notUsable := haReadinessCounts(activeSubscribedAg, secondaryRegisteredAg, len(agents))
		collector.SetHAReadiness(protected, degraded, notUsable)
	}

	slog.Info("REG/SUB phase complete",
		"total", len(agents),
		"registered", registered,
		"subscribed", subscribed,
		"failed_reg", len(failedRegister),
		"failed_sub", len(failedSubscribe),
	)

	readyIdle, _, regOnly := pool.Counts()
	if readyIdle < 2 {
		slog.Error("REG/SUB complete but not enough fully subscribed agents are ready for traffic",
			"ready_idle", readyIdle,
			"reg_only", regOnly,
			"registered", registered,
			"subscribed", subscribed,
			"failed_reg", len(failedRegister),
			"failed_sub", len(failedSubscribe),
		)
		collector.SetPhase("FAILED")
		if pctx != nil {
			pctx.Mu.Lock()
			pctx.State = "FAILED"
			pctx.Mu.Unlock()
		}
		return 1
	}

	if prePhaseOnly {
		slog.Info("PRE-PHASE-ONLY mode — waiting for signal to exit")
		collector.SetPhase("READY_PRE_PHASE_ONLY")
		<-ctx.Done()
		cleanupAll(ctx, nil)
		collector.SetPhase("DONE")
		return 0
	}

	if pctx != nil && cfg.DualRegistrationEnabled && secondaryCfg != nil && len(secondaryRegisteredAg) > 0 {
		moveToController := func(target string, automatic bool) error {
			haMoveMu.Lock()
			defer haMoveMu.Unlock()
			idle, nonIdle, _ := pool.Counts()
			if nonIdle > 0 {
				if automatic {
					collector.RecordHAFailover(true)
					collector.RecordHAEvent("move_deferred", target, fmt.Sprintf("%d agents in active/in-progress calls", nonIdle))
				}
				return fmt.Errorf("cannot move subscriptions while %d agents are in active/in-progress calls", nonIdle)
			}
			if target == activeController {
				return nil
			}
			if target == "primary" && activeController == "secondary" {
				recovered := countConnectedAgents(activeSubscribedAg, registeredAg)
				if recovered < 2 {
					err := fmt.Errorf("primary controller has only %d recovered ready transports; need at least 2 for failback", recovered)
					collector.SetHAPrimaryRecovery(false, "")
					return err
				}
			}
			collector.SetHAMove(true, target, "")
			defer collector.SetHAMove(false, target, "")
			moveCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.RegisterTimeout*len(cfg.SubscribeEvents)+30)*time.Second)
			defer cancel()
			if target == "secondary" {
				movedAgents, err := moveSubscriptions(moveCtx, activeSubscribedAg, secondaryRegisteredAg, secondaryCfg, cfg, true)
				if err != nil {
					collector.SetHAMove(false, target, err.Error())
					collector.RecordHAEvent("move_failed", target, err.Error())
					return err
				}
				activeController = "secondary"
				activeSubscribedAg = movedAgents
				pool.ReplaceIdle(movedAgents)
				agentAutoAnswerStopsMu.Lock()
				for _, stop := range agentAutoAnswerStops {
					stop()
				}
				agentAutoAnswerStops = make(map[string]func())
				for _, ag := range movedAgents {
					agentAutoAnswerStops[ag.Ext] = uasEngine.StartAutoAnswerForAgent(ctx, ag)
				}
				agentAutoAnswerStopsMu.Unlock()
				collector.SetHAStatus(true, activeController, registered, len(secondaryRegisteredAg), 0, len(movedAgents))
				protected, degraded, notUsable := haReadinessCounts(movedAgents, registeredAg, len(agents))
				collector.SetHAReadiness(protected, degraded, notUsable)
				if automatic {
					collector.RecordHAFailover(false)
				}
				collector.RecordHAEvent("move_complete", target, fmt.Sprintf("%d agents subscribed on target", len(movedAgents)))
				slog.Info("HA subscription move complete", "target", target, "automatic", automatic, "agents", len(movedAgents), "idle_before", idle)
				return nil
			}
			movedAgents, err := moveSubscriptions(moveCtx, activeSubscribedAg, registeredAg, cfg, secondaryCfg, false)
			if err != nil {
				collector.SetHAMove(false, target, err.Error())
				collector.RecordHAEvent("move_failed", target, err.Error())
				return err
			}
			activeController = "primary"
			activeSubscribedAg = movedAgents
			primaryRecoveredAt = ""
			pool.ReplaceIdle(movedAgents)
			agentAutoAnswerStopsMu.Lock()
			for _, stop := range agentAutoAnswerStops {
				stop()
			}
			agentAutoAnswerStops = make(map[string]func())
			for _, ag := range movedAgents {
				agentAutoAnswerStops[ag.Ext] = uasEngine.StartAutoAnswerForAgent(ctx, ag)
			}
			agentAutoAnswerStopsMu.Unlock()
			collector.SetHAStatus(true, activeController, registered, len(secondaryRegisteredAg), len(movedAgents), 0)
			protected, degraded, notUsable := haReadinessCounts(movedAgents, secondaryRegisteredAg, len(agents))
			collector.SetHAReadiness(protected, degraded, notUsable)
			collector.SetHAPrimaryRecovery(true, "")
			collector.RecordHAEvent("move_complete", target, fmt.Sprintf("%d agents subscribed on target", len(movedAgents)))
			slog.Info("HA subscription move complete", "target", target, "automatic", automatic, "agents", len(movedAgents), "idle_before", idle)
			return nil
		}
		pctx.Mu.Lock()
		pctx.OnHAMoveSubscription = func(target string) error {
			return moveToController(target, false)
		}
		pctx.Mu.Unlock()
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					shouldAutoFailback := false
					haMoveMu.Lock()
					primaryReachable := countConnectedAgents(activeSubscribedAg, registeredAg) >= 2
					if activeController == "primary" {
						primaryReachable = true
					}
					if primaryReachable && activeController == "secondary" && primaryRecoveredAt == "" {
						primaryRecoveredAt = time.Now().UTC().Format(time.RFC3339)
						slog.Info("HA primary controller recovered", "recovered_at", primaryRecoveredAt)
						collector.RecordHAEvent("primary_recovered", "primary", "primary transports recovered for manual failback")
					}
					if !primaryReachable {
						primaryRecoveredAt = ""
					}
					collector.SetHAPrimaryRecovery(primaryReachable, primaryRecoveredAt)
					if cfg.AutoFailbackEnabled && primaryReachable && activeController == "secondary" && primaryRecoveredAt != "" {
						if recoveredAt, err := time.Parse(time.RFC3339, primaryRecoveredAt); err == nil && time.Since(recoveredAt) >= time.Duration(cfg.FailbackDelaySeconds)*time.Second {
							shouldAutoFailback = true
						}
					}
					haMoveMu.Unlock()
					if shouldAutoFailback {
						collector.RecordHAEvent("auto_failback_start", "primary", fmt.Sprintf("delay_s=%d", cfg.FailbackDelaySeconds))
						if err := moveToController("primary", true); err != nil {
							collector.RecordHAEvent("auto_failback_failed", "primary", err.Error())
							slog.Warn("Automatic failback failed/deferred", "err", err)
						}
					}
				}
			}
		}()
		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case ext := <-primaryDownCh:
					if activeController != "primary" {
						continue
					}
					slog.Warn("Automatic graceful failover triggered by primary transport down", "ext", ext)
					collector.RecordHAEvent("auto_failover_start", "secondary", fmt.Sprintf("trigger_ext=%s", ext))
					if err := moveToController("secondary", true); err != nil {
						collector.SetHAMove(false, "secondary", err.Error())
						collector.RecordHAEvent("auto_failover_failed", "secondary", err.Error())
						slog.Warn("Automatic graceful failover deferred/failed", "ext", ext, "err", err)
					}
				}
			}
		}()
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
			cleanupAll(ctx, nil)
			collector.SetPhase("DONE")
			return 0
		case <-pctx.GracefulStopCh:
			slog.Info("Graceful stop received before traffic started")
			cleanupAll(ctx, nil)
			collector.SetPhase("DONE")
			return 0
		case <-pctx.InterruptStopCh:
			slog.Info("Interrupted stop received before traffic started")
			stopNew.Store(true)
			cleanupAll(ctx, nil)
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
	cleanupAll(context.Background(), nil)

	// Stop all per-agent auto-answer loops
	agentAutoAnswerStopsMu.Lock()
	for _, stop := range agentAutoAnswerStops {
		stop()
	}
	agentAutoAnswerStopsMu.Unlock()

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
		var cleanupAgents []*agent.ExtensionAgent
		if pool != nil {
			cleanupAgents = pool.AllForCleanup()
		} else {
			cleanupAgents = agentsToSlice(agents)
		}
		batchSize := cleanupBatchSize(cfg)
		batches := cleanupBatchCount(len(cleanupAgents), batchSize)

		// Seed the cleanup-status counters now that we know the agent set.
		// Phase was already flipped to CLEANING_UP at the top of this fn.
		collector.ResetCleanup(len(cleanupAgents))
		collector.SetCleanupUnsubscribeTotal(cleanupUnsubscribeTotal(cleanupAgents, cfg))

		slog.Info("Cleaning up extensions",
			"count", len(cleanupAgents),
			"batch_size", batchSize,
			"batches", batches,
		)

		runCleanupBatches(ctx, cleanupAgents, batchSize, "unsubscribe", func(a *agent.ExtensionAgent) {
			unsubSkipped := !a.NeedsUnsubscribe()
			unsubOK := true
			if unsubSkipped {
				slog.Debug("Unsubscribe skipped", "ext", a.Ext, "event", a.SubscriptionEvent())
			} else {
				unsubErr := cleanupUnsubscribeWithRetry(ctx, a, cfg, collector)
				unsubOK = unsubErr == nil
				if unsubErr != nil {
					slog.Debug("Unsubscribe error", "ext", a.Ext, "event", a.SubscriptionEvent(), "err", unsubErr)
				}
			}
			collector.IncrementCleanupUnsubscribe(a.Ext, unsubSkipped, unsubOK)
		})

		runCleanupBatches(ctx, cleanupAgents, batchSize, "unregister", func(a *agent.ExtensionAgent) {
			unregErr := cleanupUnregisterWithRetry(ctx, a, cfg)
			if unregErr != nil {
				slog.Debug("Unregister error", "ext", a.Ext, "err", unregErr)
			}
			collector.IncrementCleanupUnregister(a.Ext, unregErr == nil)
		})
	} else {
		slog.Info("--no-unregister: skipping unregistration")
	}

	slog.Info("Closing transports")
	for _, ag := range agents {
		ag.Close()
	}

	snap := collector.BuildSnapshot()
	snapJSON, _ := json.Marshal(snap)
	slog.Info("Final metrics: " + string(snapJSON))

	writeTrafficSummary(collector, cfg, logDir, runID, pairID, eng, agents)
	slog.Info("SIP cleanup complete — metrics server still serving")
}

func cleanupRetryCount(cfg *config.VMConfig) int {
	maxRetries := cfg.RegisterRetry
	if maxRetries <= 0 {
		maxRetries = 3
	}
	return maxRetries
}

func cleanupBackoff(attempt int) time.Duration {
	return time.Duration(float64(time.Second) * 0.5 * float64(attempt))
}

func cleanupBatchSize(cfg *config.VMConfig) int {
	if cfg.CleanupBatchSize > 0 {
		return cfg.CleanupBatchSize
	}
	return 10
}

func cleanupBatchCount(total, batchSize int) int {
	if total <= 0 {
		return 0
	}
	if batchSize <= 0 {
		batchSize = 10
	}
	return (total + batchSize - 1) / batchSize
}

func batchMinExt(batch []*agent.ExtensionAgent) string {
	min := math.MaxInt
	minExt := ""
	for _, a := range batch {
		if n, err := strconv.Atoi(a.Ext); err == nil && n < min {
			min = n
			minExt = a.Ext
		}
	}
	return minExt
}

func batchMaxExt(batch []*agent.ExtensionAgent) string {
	max := math.MinInt
	maxExt := ""
	for _, a := range batch {
		if n, err := strconv.Atoi(a.Ext); err == nil && n > max {
			max = n
			maxExt = a.Ext
		}
	}
	return maxExt
}

func runCleanupBatches(ctx context.Context, agents []*agent.ExtensionAgent, batchSize int, phase string, fn func(*agent.ExtensionAgent)) {
	if batchSize <= 0 {
		batchSize = 10
	}
	total := len(agents)
	for batchStart := 0; batchStart < total; batchStart += batchSize {
		if ctx.Err() != nil {
			slog.Warn("Cleanup phase stopped by context", "phase", phase, "completed", batchStart, "total", total, "err", ctx.Err())
			return
		}
		batchEnd := batchStart + batchSize
		if batchEnd > total {
			batchEnd = total
		}
		batch := agents[batchStart:batchEnd]
		batchNum := batchStart/batchSize + 1
		slog.Info("Cleanup batch starting",
			"phase", phase,
			"batch", batchNum,
			"from", batchMinExt(batch),
			"to", batchMaxExt(batch),
			"count", len(batch),
		)

		var wg sync.WaitGroup
		wg.Add(len(batch))
		for _, ag := range batch {
			go func(a *agent.ExtensionAgent) {
				defer wg.Done()
				fn(a)
			}(ag)
		}
		wg.Wait()

		slog.Info("Cleanup batch complete",
			"phase", phase,
			"batch", batchNum,
			"count", len(batch),
		)
	}
}

func cleanupUnsubscribeWithRetry(ctx context.Context, ag *agent.ExtensionAgent, cfg *config.VMConfig, collector *metrics.MetricsCollector) error {
	maxRetries := cleanupRetryCount(cfg)
	eventResults := make(map[string]bool)
	var lastErr error

retryUnsubscribe:
	for attempt := 1; attempt <= maxRetries; attempt++ {
		err := ag.UnsubscribeWithProgress(ctx, func(event string, ok bool) {
			eventResults[event] = ok
		})
		if err == nil {
			for event, ok := range eventResults {
				collector.RecordCleanupUnsubscribeEvent(event, ok)
			}
			return nil
		}
		lastErr = err
		slog.Warn("UNSUBSCRIBE cleanup attempt failed",
			"ext", ag.Ext,
			"attempt", attempt,
			"max", maxRetries,
			"err", err)
		if ctx.Err() != nil || attempt == maxRetries {
			break
		}
		select {
		case <-ctx.Done():
			break retryUnsubscribe
		case <-time.After(cleanupBackoff(attempt)):
		}
	}

	for event, ok := range eventResults {
		collector.RecordCleanupUnsubscribeEvent(event, ok)
	}
	if lastErr == nil {
		lastErr = ctx.Err()
	}
	return lastErr
}

func cleanupUnsubscribeTotal(agents []*agent.ExtensionAgent, cfg *config.VMConfig) int {
	total := 0
	for _, ag := range agents {
		for _, event := range ag.SubscriptionEvents() {
			if cfg.ShouldUnsubscribeSubscribeEvent(event) {
				total++
			}
		}
	}
	return total
}

func cleanupUnregisterWithRetry(ctx context.Context, ag *agent.ExtensionAgent, cfg *config.VMConfig) error {
	maxRetries := cleanupRetryCount(cfg)
	timeout := time.Duration(cfg.RegisterTimeout) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	var lastErr error
retryUnregister:
	for attempt := 1; attempt <= maxRetries; attempt++ {
		regCtx, cancel := context.WithTimeout(ctx, timeout)
		err := ag.Unregister(regCtx)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		slog.Warn("UNREGISTER cleanup attempt failed",
			"ext", ag.Ext,
			"attempt", attempt,
			"max", maxRetries,
			"err", err)
		if ctx.Err() != nil || attempt == maxRetries {
			break
		}
		select {
		case <-ctx.Done():
			break retryUnregister
		case <-time.After(cleanupBackoff(attempt)):
		}
	}
	if lastErr == nil {
		lastErr = ctx.Err()
	}
	return lastErr
}

func unregisterSecondaryRegistrations(ctx context.Context, agents map[string]*agent.ExtensionAgent, cfg *config.VMConfig) {
	agentSlice := agentsToSlice(agents)
	if len(agentSlice) == 0 {
		return
	}
	batchSize := cleanupBatchSize(cfg)
	slog.Info("Cleaning up secondary controller registrations", "count", len(agentSlice), "batch_size", batchSize)
	runCleanupBatches(ctx, agentSlice, batchSize, "secondary_unregister", func(a *agent.ExtensionAgent) {
		if err := cleanupUnregisterWithRetry(ctx, a, cfg); err != nil {
			slog.Debug("Secondary unregister error", "ext", a.Ext, "err", err)
		} else {
			slog.Debug("Secondary unregistered", "ext", a.Ext)
		}
	})
	for _, ag := range agentSlice {
		_ = ag.Close()
	}
}

func agentsExceptExts(agents []*agent.ExtensionAgent, failed []string) []*agent.ExtensionAgent {
	if len(failed) == 0 {
		return append([]*agent.ExtensionAgent(nil), agents...)
	}
	failedSet := make(map[string]struct{}, len(failed))
	for _, ext := range failed {
		failedSet[ext] = struct{}{}
	}
	out := make([]*agent.ExtensionAgent, 0, len(agents))
	for _, ag := range agents {
		if _, bad := failedSet[ag.Ext]; !bad {
			out = append(out, ag)
		}
	}
	return out
}

func countConnectedAgents(activeAgents, candidateAgents []*agent.ExtensionAgent) int {
	candidatesByExt := make(map[string]*agent.ExtensionAgent, len(candidateAgents))
	for _, ag := range candidateAgents {
		candidatesByExt[ag.Ext] = ag
	}
	count := 0
	for _, active := range activeAgents {
		if candidate := candidatesByExt[active.Ext]; candidate != nil && candidate.IsTransportConnected() {
			count++
		}
	}
	return count
}

func haReadinessCounts(activeReady, standbyRegistered []*agent.ExtensionAgent, configuredTotal int) (protected, degradedPrimaryOnly, notUsable int) {
	standbyByExt := make(map[string]*agent.ExtensionAgent, len(standbyRegistered))
	for _, ag := range standbyRegistered {
		standbyByExt[ag.Ext] = ag
	}
	for _, ready := range activeReady {
		if standby := standbyByExt[ready.Ext]; standby != nil && standby.IsTransportConnected() {
			protected++
		} else {
			degradedPrimaryOnly++
		}
	}
	notUsable = configuredTotal - protected - degradedPrimaryOnly
	if notUsable < 0 {
		notUsable = 0
	}
	return protected, degradedPrimaryOnly, notUsable
}

func moveSubscriptions(ctx context.Context, fromAgents, toAgents []*agent.ExtensionAgent, toCfg, fromCfg *config.VMConfig, fromDown bool) ([]*agent.ExtensionAgent, error) {
	toByExt := make(map[string]*agent.ExtensionAgent, len(toAgents))
	for _, ag := range toAgents {
		toByExt[ag.Ext] = ag
	}
	moved := make([]*agent.ExtensionAgent, 0, len(fromAgents))
	for _, from := range fromAgents {
		to := toByExt[from.Ext]
		if to == nil {
			return moved, fmt.Errorf("no target controller agent for extension %s", from.Ext)
		}
		if !fromDown {
			if err := from.Unsubscribe(ctx); err != nil {
				return moved, fmt.Errorf("unsubscribe %s from %s:%d: %w", from.Ext, fromCfg.SBCHost, fromCfg.SBCPort, err)
			}
		}
		if err := to.Subscribe(ctx); err != nil {
			return moved, fmt.Errorf("subscribe %s to %s:%d: %w", to.Ext, toCfg.SBCHost, toCfg.SBCPort, err)
		}
		moved = append(moved, to)
	}
	if len(moved) < 2 {
		return moved, fmt.Errorf("only %d target controller agents subscribed; need at least 2", len(moved))
	}
	return moved, nil
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
		"unsubscribe_total_expected":    cleanupDetails.UnsubscribeTotal,
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
		"local_ip_mode", cfg.LocalIPMode,
	)
	for ext := cfg.ExtStart; ext <= cfg.ExtEnd; ext++ {
		extStr := strconv.Itoa(ext)
		ag := agent.NewExtensionAgent(extStr, cfg)
		ag.SetAssignedLocalHost(cfg.LocalHostForExtension(extStr))
		agents[extStr] = ag
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

func connectTransportsBatched(ctx context.Context, agents map[string]*agent.ExtensionAgent, cfg *config.VMConfig, collector *metrics.MetricsCollector) (map[string]*agent.ExtensionAgent, error) {
	allAgents := agentsToSlice(agents)
	total := len(allAgents)
	connected := make(map[string]*agent.ExtensionAgent, total)
	if collector != nil {
		collector.ResetTransportConnect(total)
		defer collector.FinishTransportConnect()
	}
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
		var mu sync.Mutex
		batchFailures := 0
		for _, ag := range batch {
			wg.Add(1)
			go func(a *agent.ExtensionAgent) {
				defer wg.Done()
				if err := a.Start(ctx); err != nil {
					mu.Lock()
					batchFailures++
					mu.Unlock()
					slog.Error("Agent start failed", "ext", a.Ext, "err", err)
					if collector != nil {
						collector.RecordTransportConnectFailure(a.Ext, cfg.LocalHostForExtension(a.Ext), fmt.Sprintf("%s:%d", cfg.SBCHost, cfg.SBCPort), err)
					}
					return
				}
				mu.Lock()
				connected[a.Ext] = a
				mu.Unlock()
				if collector != nil {
					collector.RecordTransportConnectSuccess()
				}
			}(ag)
		}
		wg.Wait()

		if batchFailures > 0 {
			slog.Warn("Transport batch partially connected",
				"batch", batchNum,
				"connected", len(batch)-batchFailures,
				"failed", batchFailures,
				"count", len(batch),
			)
		} else {
			slog.Info("Transport batch connected", "batch", batchNum, "count", len(batch))
		}

		if batchEnd < total {
			select {
			case <-ctx.Done():
				return connected, ctx.Err()
			case <-time.After(batchDelay):
			}
		}
	}
	if len(connected) == 0 {
		return connected, fmt.Errorf("no transports connected out of %d configured agents", total)
	}
	if len(connected) < total {
		slog.Warn("Transport connection completed with partial success",
			"configured", total,
			"connected", len(connected),
			"failed", total-len(connected),
		)
	}
	return connected, nil
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

		collector.ResetForRun(cfg.VMID)

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
		SIPLocalIP:          r.SIPLocalIP,
		SIPLocalPort:        r.SIPLocalPort,
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
