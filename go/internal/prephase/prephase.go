// Package prephase implements bulk REGISTER + SUBSCRIBE for all extensions
// before any INVITE is fired.
//
// New behaviour (single-pool model):
//
//   - Partial registration or subscription failures no longer abort the run.
//   - Per-agent callbacks are invoked as each user completes:
//     Reg OK + Sub OK  → onIdle(ag)       — added to the idle pool
//     Reg OK + Sub fail → onRegOnly(ag)    — added to reg-only list
//     Reg fail           — counted only in PrePhaseResult.FailedRegister
//   - stopNew *atomic.Bool: if set to true mid-run, no new batches/requests
//     are started (used during interrupted shutdown).
//
// Sequencing:
//
//	Phase 0 — Flush stale registrations (REGISTER Expires:0)
//	Phase 1 — Register all extensions in sequential batches
//	Phase 2 — Subscribe successfully registered extensions
package prephase

import (
	"context"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
)

// batchMinExt returns the numerically smallest extension in the batch.
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

// batchMaxExt returns the numerically largest extension in the batch.
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

// PrePhaseResult holds success/failure counts from the pre-phase pipeline.
type PrePhaseResult struct {
	Total           int
	Registered      int
	Subscribed      int
	IdleCount       int // reg + sub OK
	RegOnlyCount    int // reg OK, sub failed
	FailedRegister  []string
	FailedSubscribe []string
	DurationSeconds float64
}

// RegisterSuccessRate returns the percentage of extensions that registered
// successfully, or 0 if there are no extensions.
func (r *PrePhaseResult) RegisterSuccessRate() float64 {
	if r.Total == 0 {
		return 0
	}
	return float64(r.Registered) / float64(r.Total) * 100
}

// AllReady reports whether every extension registered and subscribed
// without error.
func (r *PrePhaseResult) AllReady() bool {
	return len(r.FailedRegister) == 0 && len(r.FailedSubscribe) == 0
}

// RegisterAll registers extensions in sequential batches of cfg.RegisterBatchSize.
// Each batch fires concurrently; batches are separated by RegisterBatchDelayMs.
//
// agentCb is called for each agent after its registration attempt:
//
//	agentCb(ag, true)  — registration succeeded
//	agentCb(ag, false) — registration failed
//
// onProgress, if non-nil, is invoked once per agent (after the agent finishes,
// regardless of success). Used to drive the live REGISTER progress counter in
// MetricsCollector — callee just increments a counter; total is set by caller
// before invocation via SetRegisterTotal.
//
// If stopNew is non-nil and becomes true, no further batches are started.
// Returns the list of extensions that failed to register.
func RegisterAll(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	agentCb func(ag *agent.ExtensionAgent, succeeded bool),
	onProgress func(),
	stopNew *atomic.Bool,
) []string {
	total := len(agents)
	batchSize := cfg.RegisterBatchSize
	if batchSize <= 0 {
		batchSize = 10
	}
	batchDelay := cfg.BatchDelay()

	var (
		mu     sync.Mutex
		failed []string
	)

	slog.Info("Pre-phase: registering extensions",
		"total", total, "batch_size", batchSize,
		"batch_delay_ms", batchDelay.Milliseconds())

	start := time.Now()

	for batchStart := 0; batchStart < total; batchStart += batchSize {
		if stopNew != nil && stopNew.Load() {
			slog.Info("RegisterAll: stopNew requested — halting new batches",
				"completed", batchStart, "total", total)
			break
		}

		batchEnd := batchStart + batchSize
		if batchEnd > total {
			batchEnd = total
		}
		batch := agents[batchStart:batchEnd]
		batchNum := batchStart/batchSize + 1

		slog.Info("REGISTER batch",
			"batch", batchNum,
			"from", batchMinExt(batch), "to", batchMaxExt(batch),
			"count", len(batch))

		var wg sync.WaitGroup
		wg.Add(len(batch))

		for _, a := range batch {
			go func(ag *agent.ExtensionAgent) {
				defer wg.Done()
				ok := registerOne(ctx, ag, cfg)
				if !ok {
					mu.Lock()
					failed = append(failed, ag.Ext)
					mu.Unlock()
				}
				if agentCb != nil {
					agentCb(ag, ok)
				}
				if onProgress != nil {
					onProgress()
				}
			}(a)
		}

		wg.Wait()

		mu.Lock()
		batchFailCount := 0
		for _, ext := range failed {
			for _, a := range batch {
				if a.Ext == ext {
					batchFailCount++
				}
			}
		}
		mu.Unlock()

		slog.Info("REGISTER batch complete",
			"batch", batchNum, "ok", len(batch)-batchFailCount, "total", len(batch))

		if batchEnd < total {
			select {
			case <-ctx.Done():
				goto done
			case <-time.After(batchDelay):
			}
		}
	}

done:
	elapsed := time.Since(start).Seconds()
	mu.Lock()
	failedCopy := make([]string, len(failed))
	copy(failedCopy, failed)
	mu.Unlock()

	slog.Info("REGISTER complete",
		"ok", total-len(failedCopy), "failed", len(failedCopy),
		"total", total, "elapsed_s", fmt.Sprintf("%.1f", elapsed))

	return failedCopy
}

// registerOne attempts to register a single agent with retries.
func registerOne(ctx context.Context, ag *agent.ExtensionAgent, cfg *config.VMConfig) bool {
	maxRetries := cfg.RegisterRetry
	if maxRetries <= 0 {
		maxRetries = 3
	}
	timeout := time.Duration(cfg.RegisterTimeout) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Second
	}

	for attempt := 1; attempt <= maxRetries; attempt++ {
		regCtx, cancel := context.WithTimeout(ctx, timeout)
		err := ag.Register(regCtx)
		cancel()

		if err == nil {
			return true
		}

		slog.Warn("REGISTER attempt failed",
			"ext", ag.Ext,
			"attempt", attempt, "max", maxRetries,
			"err", err)

		if attempt < maxRetries {
			backoff := time.Duration(float64(time.Second) * 0.5 * float64(attempt))
			select {
			case <-ctx.Done():
				return false
			case <-time.After(backoff):
			}
		}
	}

	slog.Error("failed to register after all attempts",
		"ext", ag.Ext, "attempts", maxRetries)
	return false
}

// SubscribeAll subscribes a list of extensions with a semaphore limiting
// concurrency to cfg.SubscribeConcurrency.
//
// agentCb is called for each agent after its subscription attempt:
//
//	agentCb(ag, true)  — subscription succeeded
//	agentCb(ag, false) — subscription failed
//
// If stopNew is non-nil and becomes true, no further subscriptions are started.
// Returns the list of extensions that failed to subscribe.
// SubscribeAll subscribes successfully-registered extensions concurrently.
//
// onProgress, if non-nil, is invoked once per configured event package after
// its subscribe attempt completes. Used to drive live per-event progress.
func SubscribeAll(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	agentCb func(ag *agent.ExtensionAgent, succeeded bool),
	onProgress func(event string, ok bool, notifyReceived bool),
	stopNew *atomic.Bool,
) []string {
	total := len(agents)
	concurrency := cfg.SubscribeConcurrency
	if concurrency <= 0 {
		concurrency = 10
	}

	var (
		mu     sync.Mutex
		failed []string
	)

	slog.Info("Pre-phase: subscribing extensions", "total", total)
	start := time.Now()

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup

	for _, a := range agents {
		if stopNew != nil && stopNew.Load() {
			slog.Info("SubscribeAll: stopNew requested — halting new subscriptions")
			break
		}
		wg.Add(1)
		go func(ag *agent.ExtensionAgent) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			ok := subscribeOne(ctx, ag, cfg, onProgress)
			if !ok {
				mu.Lock()
				failed = append(failed, ag.Ext)
				mu.Unlock()
			}
			if agentCb != nil {
				agentCb(ag, ok)
			}
		}(a)
	}

	wg.Wait()

	elapsed := time.Since(start).Seconds()
	mu.Lock()
	failedCopy := make([]string, len(failed))
	copy(failedCopy, failed)
	mu.Unlock()

	slog.Info("SUBSCRIBE complete",
		"ok", total-len(failedCopy), "failed", len(failedCopy),
		"total", total, "elapsed_s", fmt.Sprintf("%.1f", elapsed))

	return failedCopy
}

// subscribeOne attempts to subscribe a single agent with retries.
func subscribeOne(ctx context.Context, ag *agent.ExtensionAgent, cfg *config.VMConfig, onProgress func(event string, ok bool, notifyReceived bool)) bool {
	maxRetries := cfg.RegisterRetry
	if maxRetries <= 0 {
		maxRetries = 3
	}
	timeout := time.Duration(cfg.RegisterTimeout) * time.Second
	if timeout <= 0 {
		timeout = 5 * time.Second
	}

	for attempt := 1; attempt <= maxRetries; attempt++ {
		subCtx, cancel := context.WithTimeout(ctx, timeout)
		var attemptProgress []struct {
			event          string
			ok             bool
			notifyReceived bool
		}
		err := ag.SubscribeWithProgress(subCtx, func(event string, ok bool, notifyReceived bool) {
			attemptProgress = append(attemptProgress, struct {
				event          string
				ok             bool
				notifyReceived bool
			}{event: event, ok: ok, notifyReceived: notifyReceived})
		})
		cancel()

		if err == nil {
			if onProgress != nil {
				for _, p := range attemptProgress {
					onProgress(p.event, p.ok, p.notifyReceived)
				}
			}
			return true
		}

		slog.Warn("SUBSCRIBE attempt failed",
			"ext", ag.Ext,
			"attempt", attempt, "max", maxRetries,
			"err", err)

		if attempt < maxRetries {
			backoff := time.Duration(float64(time.Second) * 0.5 * float64(attempt))
			select {
			case <-ctx.Done():
				return false
			case <-time.After(backoff):
			}
		} else if onProgress != nil {
			for _, p := range attemptProgress {
				onProgress(p.event, p.ok, p.notifyReceived)
			}
		}
	}

	slog.Error("failed to subscribe after all attempts",
		"ext", ag.Ext, "attempts", maxRetries)
	return false
}

// StartRegisterRefreshLoop starts a background goroutine that re-registers all
// agents at half the register_expires interval, preventing SBC registration
// bindings from expiring during long test runs. The returned stop function must
// be called (e.g. via defer) to cleanly terminate the loop.
func StartRegisterRefreshLoop(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
) func() {
	expires := cfg.RegisterExpires
	if expires <= 0 {
		expires = 3600
	}
	interval := time.Duration(expires/2) * time.Second

	concurrency := cfg.RegisterBatchSize
	if concurrency <= 0 {
		concurrency = 10
	}

	stopCh := make(chan struct{})

	go func() {
		slog.Info("Register refresh loop started",
			"interval_s", interval.Seconds(), "register_expires", expires)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				slog.Info("Register refresh loop stopped")
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				slog.Debug("Register refresh: firing", "agents", len(agents))
				sem := make(chan struct{}, concurrency)
				var wg sync.WaitGroup
				wg.Add(len(agents))
				for _, ag := range agents {
					go func(a *agent.ExtensionAgent) {
						defer wg.Done()
						sem <- struct{}{}
						defer func() { <-sem }()
						rCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.RegisterTimeout)*time.Second)
						defer cancel()
						if err := a.Reregister(rCtx); err != nil {
							slog.Warn("Reregister failed", "ext", a.Ext, "err", err)
						}
					}(ag)
				}
				wg.Wait()
				slog.Debug("Register refresh: complete", "agents", len(agents))
			}
		}
	}()

	return func() { close(stopCh) }
}

// StartSubscribeRefreshLoop starts a background goroutine that re-subscribes
// all agents at half the subscribe_expires interval, keeping SBC subscription
// state alive for the duration of the run. The returned stop function must be
// called (e.g. via defer) to cleanly terminate the loop.
func StartSubscribeRefreshLoop(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
) func() {
	expires := cfg.SubscribeExpires
	if expires <= 0 {
		expires = 3600
	}
	interval := time.Duration(expires/2) * time.Second

	stopCh := make(chan struct{})
	concurrency := cfg.SubscribeConcurrency
	if concurrency <= 0 {
		concurrency = 10
	}

	go func() {
		slog.Info("Subscribe refresh loop started",
			"interval_s", interval.Seconds(), "subscribe_expires", expires)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				slog.Info("Subscribe refresh loop stopped")
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				slog.Debug("Subscribe refresh: firing", "agents", len(agents))
				sem := make(chan struct{}, concurrency)
				var wg sync.WaitGroup
				wg.Add(len(agents))
				for _, ag := range agents {
					go func(a *agent.ExtensionAgent) {
						defer wg.Done()
						sem <- struct{}{}
						defer func() { <-sem }()
						rCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.RegisterTimeout)*time.Second)
						defer cancel()
						if err := a.Resubscribe(rCtx); err != nil {
							slog.Warn("Resubscribe failed", "ext", a.Ext, "err", err)
						}
					}(ag)
				}
				wg.Wait()
				slog.Debug("Subscribe refresh: complete", "agents", len(agents))
			}
		}
	}()

	return func() { close(stopCh) }
}

// FlushStaleRegistrations sends REGISTER(Expires:0) for every extension to
// clear stale bindings from a previous run. Errors are swallowed.
func FlushStaleRegistrations(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
) {
	total := len(agents)
	concurrency := cfg.SubscribeConcurrency
	if concurrency <= 0 {
		concurrency = 10
	}

	slog.Info("========================================")
	slog.Info("PRE-PHASE 0/2 — FLUSH stale registrations", "count", total)
	slog.Info("========================================")

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	wg.Add(total)

	for _, a := range agents {
		go func(ag *agent.ExtensionAgent) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if err := ag.FlushRegister(ctx); err != nil {
				slog.Debug("flush register error (ignored)", "ext", ag.Ext, "err", err)
			}
		}(a)
	}

	wg.Wait()
	slog.Info("Flush complete — all extensions cleared from server")
}

// RunPrePhase executes the full pre-phase pipeline with per-agent callbacks:
//
//	Phase 0 — Flush stale registrations
//	Phase 1 — Register all extensions (partial failures are tolerated)
//	Phase 2 — Subscribe successfully registered extensions
//	           onIdle(ag)    called when reg+sub both succeed → idle_list
//	           onRegOnly(ag) called when reg OK but sub failed → reg_only_list
//
// stopNew, if non-nil, causes new batches/subscriptions to halt when set to
// true (used by interrupted shutdown before cleaning up in-flight work).
//
// Always returns a result; never returns an error for partial failures.
// Background refresh loops are started after their respective phases; the
// returned stop function must be called to terminate them.
func RunPrePhase(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	skipSubscribe bool,
	onIdle func(ag *agent.ExtensionAgent),
	onRegOnly func(ag *agent.ExtensionAgent),
	stopNew *atomic.Bool,
) (*PrePhaseResult, func()) {
	total := len(agents)
	start := time.Now()
	noopStop := func() {}

	// Phase 0: flush stale registrations
	FlushStaleRegistrations(ctx, agents, cfg)

	// Phase 1: REGISTER
	slog.Info("============================================================")
	slog.Info("PRE-PHASE 1/2 — REGISTER", "count", total)
	slog.Info("============================================================")

	// Track which agents registered successfully so we can subscribe only those.
	var (
		regMu        sync.Mutex
		registeredAg []*agent.ExtensionAgent
	)

	failedReg := RegisterAll(ctx, agents, cfg, func(ag *agent.ExtensionAgent, ok bool) {
		if ok {
			regMu.Lock()
			registeredAg = append(registeredAg, ag)
			regMu.Unlock()
		}
	}, nil, stopNew)

	if len(failedReg) > 0 {
		slog.Warn("PRE-PHASE REGISTER partial failure",
			"failed_count", len(failedReg), "extensions", failedReg)
	}
	if len(registeredAg) == 0 {
		slog.Error("PRE-PHASE: no extensions registered — skipping SUBSCRIBE")
		elapsed := time.Since(start).Seconds()
		return &PrePhaseResult{
			Total: total, Registered: 0, Subscribed: 0,
			FailedRegister: failedReg, FailedSubscribe: []string{},
			DurationSeconds: elapsed,
		}, noopStop
	}

	stopRegRefresh := StartRegisterRefreshLoop(ctx, registeredAg, cfg)

	// Phase 2: SUBSCRIBE (only for successfully registered agents)
	var failedSub []string
	stopSubRefresh := noopStop

	if skipSubscribe {
		slog.Info("PRE-PHASE 2/2 — SUBSCRIBE skipped")
		// All registered agents go to reg_only
		if onRegOnly != nil {
			for _, ag := range registeredAg {
				onRegOnly(ag)
			}
		}
	} else {
		slog.Info("============================================================")
		slog.Info("PRE-PHASE 2/2 — SUBSCRIBE", "count", len(registeredAg))
		slog.Info("============================================================")

		failedSub = SubscribeAll(ctx, registeredAg, cfg, func(ag *agent.ExtensionAgent, ok bool) {
			if ok {
				if onIdle != nil {
					onIdle(ag)
				}
			} else {
				if onRegOnly != nil {
					onRegOnly(ag)
				}
			}
		}, nil, stopNew)

		if len(failedSub) > 0 {
			slog.Warn("PRE-PHASE SUBSCRIBE partial failure",
				"failed_count", len(failedSub), "extensions", failedSub)
		}

		stopSubRefresh = StartSubscribeRefreshLoop(ctx, registeredAg, cfg)
	}

	stopRefresh := func() {
		stopRegRefresh()
		stopSubRefresh()
	}

	elapsed := time.Since(start).Seconds()
	registered := len(registeredAg)
	subscribed := registered - len(failedSub)
	idleCount := subscribed
	regOnlyCount := len(failedSub)
	if skipSubscribe {
		idleCount = 0
		regOnlyCount = registered
	}

	if failedReg == nil {
		failedReg = []string{}
	}
	if failedSub == nil {
		failedSub = []string{}
	}

	result := &PrePhaseResult{
		Total:           total,
		Registered:      registered,
		Subscribed:      subscribed,
		IdleCount:       idleCount,
		RegOnlyCount:    regOnlyCount,
		FailedRegister:  failedReg,
		FailedSubscribe: failedSub,
		DurationSeconds: elapsed,
	}

	slog.Info("============================================================")
	slog.Info("PRE-PHASE COMPLETE",
		"registered", registered, "subscribed", subscribed,
		"idle", idleCount, "reg_only", regOnlyCount,
		"failed_reg", len(failedReg), "failed_sub", len(failedSub),
		"elapsed_s", fmt.Sprintf("%.1f", elapsed))
	slog.Info("============================================================")

	return result, stopRefresh
}

// ---------------------------------------------------------------------------
// Split entry points used by GUI mode (operator-gated lifecycle).
//
// RunPrep — optional, async, fire-and-forget unregister flush.
// RunRegister — Phase 1 with live progress callback for the GUI.
// RunSubscribe — Phase 2 with live progress callback for the GUI.
//
// CLI mode still uses RunPrePhase above as a one-shot pipeline.
// ---------------------------------------------------------------------------

// RunPrep wraps FlushStaleRegistrations for the GUI's optional Prep button.
// Always returns nil (errors are swallowed inside FlushRegister); the caller
// reports completion to the operator via prep_status on the metrics snapshot.
func RunPrep(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
) error {
	FlushStaleRegistrations(ctx, agents, cfg)
	return nil
}

// RunRegister executes Phase 1 (REGISTER all extensions) and returns the
// list of agents that registered successfully along with the failed slice.
// onProgress is fired once per agent to drive the live REGISTER counter.
func RunRegister(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	onProgress func(),
	stopNew *atomic.Bool,
) (registered []*agent.ExtensionAgent, failed []string, stopRefresh func()) {
	noopStop := func() {}
	total := len(agents)

	slog.Info("============================================================")
	slog.Info("REG/SUB 1/2 — REGISTER", "count", total)
	slog.Info("============================================================")

	var (
		regMu        sync.Mutex
		registeredAg []*agent.ExtensionAgent
	)

	failed = RegisterAll(ctx, agents, cfg, func(ag *agent.ExtensionAgent, ok bool) {
		if ok {
			regMu.Lock()
			registeredAg = append(registeredAg, ag)
			regMu.Unlock()
		}
	}, onProgress, stopNew)

	if len(failed) > 0 {
		slog.Warn("REG/SUB REGISTER partial failure",
			"failed_count", len(failed), "extensions", failed)
	}
	if len(registeredAg) == 0 {
		slog.Error("REG/SUB: no extensions registered — caller should skip SUBSCRIBE")
		return nil, failed, noopStop
	}

	stopRefresh = StartRegisterRefreshLoop(ctx, registeredAg, cfg)
	return registeredAg, failed, stopRefresh
}

// RunSubscribe executes Phase 2 (SUBSCRIBE successfully-registered extensions).
// onIdle/onRegOnly are per-agent callbacks the caller uses to populate the
// idle vs reg-only pools. onProgress drives the live SUBSCRIBE counter.
//
// If skipSubscribe is true, every registered agent is routed to onRegOnly
// without sending any SUBSCRIBE on the wire and refresh loop is not started.
func RunSubscribe(
	ctx context.Context,
	registered []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	skipSubscribe bool,
	onIdle func(ag *agent.ExtensionAgent),
	onRegOnly func(ag *agent.ExtensionAgent),
	onProgress func(event string, ok bool, notifyReceived bool),
	stopNew *atomic.Bool,
) (failed []string, stopRefresh func()) {
	noopStop := func() {}
	stopRefresh = noopStop

	if skipSubscribe {
		slog.Info("REG/SUB 2/2 — SUBSCRIBE skipped")
		if onRegOnly != nil {
			for _, ag := range registered {
				onRegOnly(ag)
			}
		}
		return []string{}, noopStop
	}

	slog.Info("============================================================")
	slog.Info("REG/SUB 2/2 — SUBSCRIBE", "count", len(registered))
	slog.Info("============================================================")

	failed = SubscribeAll(ctx, registered, cfg, func(ag *agent.ExtensionAgent, ok bool) {
		if ok {
			if onIdle != nil {
				onIdle(ag)
			}
		} else {
			if onRegOnly != nil {
				onRegOnly(ag)
			}
		}
	}, onProgress, stopNew)

	if len(failed) > 0 {
		slog.Warn("REG/SUB SUBSCRIBE partial failure",
			"failed_count", len(failed), "extensions", failed)
	}

	stopRefresh = StartSubscribeRefreshLoop(ctx, registered, cfg)
	return failed, stopRefresh
}
