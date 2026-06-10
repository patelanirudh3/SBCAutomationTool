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
	Total            int
	Registered       int
	Subscribed       int
	IdleCount        int // reg + sub OK
	RegOnlyCount     int // reg OK, sub failed
	FailedRegister   []string
	FailedSubscribe  []string
	RegisteredAgents []*agent.ExtensionAgent
	DurationSeconds  float64
}

type PipelineHandle struct {
	Done   <-chan *PrePhaseResult
	Stop   func()
	Result func() *PrePhaseResult
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
	for attempt := 1; attempt <= maxRetries; attempt++ {
		var attemptProgress []struct {
			event          string
			ok             bool
			notifyReceived bool
		}
		err := ag.SubscribeWithProgress(ctx, func(event string, ok bool, notifyReceived bool) {
			attemptProgress = append(attemptProgress, struct {
				event          string
				ok             bool
				notifyReceived bool
			}{event: event, ok: ok, notifyReceived: notifyReceived})
		})

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

// StartRegisterRefreshLoop starts one refresh worker per registered agent.
// Each worker uses the server-granted REGISTER expiry from that agent's latest
// 200 OK and refreshes at granted_exp * 0.5. The interval is recalculated after
// each successful refresh because the registrar can grant a different expiry
// on every REGISTER transaction.
func StartRegisterRefreshLoop(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
) func() {
	concurrency := cfg.RegisterBatchSize
	if concurrency <= 0 {
		concurrency = 10
	}

	stopCh := make(chan struct{})
	sem := make(chan struct{}, concurrency)
	var stopOnce sync.Once

	slog.Info("Register refresh loop started",
		"agents", len(agents),
		"strategy", "per_agent_granted_exp_half",
		"configured_register_expires", cfg.RegisterExpires,
		"concurrency", concurrency)

	for _, ag := range agents {
		go runAgentRegisterRefresh(ctx, stopCh, sem, ag, cfg)
	}

	return func() {
		stopOnce.Do(func() {
			close(stopCh)
			slog.Info("Register refresh loop stopped")
		})
	}
}

func runAgentRegisterRefresh(ctx context.Context, stopCh <-chan struct{}, sem chan struct{}, ag *agent.ExtensionAgent, cfg *config.VMConfig) {
	for {
		granted := ag.GrantedRegisterExpiry()
		interval := registerRefreshInterval(granted, cfg)
		slog.Debug("Register refresh scheduled",
			"ext", ag.Ext,
			"granted_exp", granted,
			"refresh_in_s", int(interval.Seconds()))

		timer := time.NewTimer(interval)
		select {
		case <-stopCh:
			timer.Stop()
			return
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}

		select {
		case sem <- struct{}{}:
		case <-stopCh:
			return
		case <-ctx.Done():
			return
		}

		timeout := time.Duration(cfg.RegisterTimeout) * time.Second
		if timeout <= 0 {
			timeout = 5 * time.Second
		}
		rCtx, cancel := context.WithTimeout(ctx, timeout)
		err := ag.Reregister(rCtx)
		cancel()
		<-sem

		if err != nil {
			ag.MarkRegistrationUncertain(err)
			slog.Warn("Reregister failed",
				"ext", ag.Ext,
				"granted_exp", granted,
				"err", err)
			retryRegisterRefreshUntilUsable(ctx, stopCh, sem, ag, cfg, err)
			continue
		}
		slog.Debug("Reregister refreshed",
			"ext", ag.Ext,
			"granted_exp", ag.GrantedRegisterExpiry())
	}
}

func retryRegisterRefreshUntilUsable(ctx context.Context, stopCh <-chan struct{}, sem chan struct{}, ag *agent.ExtensionAgent, cfg *config.VMConfig, firstErr error) {
	backoffs := []time.Duration{
		100 * time.Millisecond,
		500 * time.Millisecond,
		time.Second,
		2 * time.Second,
		4 * time.Second,
		8 * time.Second,
		16 * time.Second,
		32 * time.Second,
	}
	lastErr := firstErr
	for attempt := 1; ; attempt++ {
		delay := backoffs[len(backoffs)-1]
		if attempt <= len(backoffs) {
			delay = backoffs[attempt-1]
		}
		slog.Warn("REGISTER refresh retry scheduled",
			"ext", ag.Ext,
			"attempt", attempt,
			"retry_in_ms", delay.Milliseconds(),
			"last_err", lastErr)

		timer := time.NewTimer(delay)
		select {
		case <-stopCh:
			timer.Stop()
			return
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}

		if !ag.IsTransportConnected() {
			lastErr = fmt.Errorf("transport not connected")
			ag.MarkRegistrationUncertain(lastErr)
			continue
		}

		select {
		case sem <- struct{}{}:
		case <-stopCh:
			return
		case <-ctx.Done():
			return
		}

		timeout := time.Duration(cfg.RegisterTimeout) * time.Second
		if timeout <= 0 {
			timeout = 5 * time.Second
		}
		rCtx, cancel := context.WithTimeout(ctx, timeout)
		err := ag.Reregister(rCtx)
		cancel()
		<-sem

		if err == nil {
			slog.Info("REGISTER refresh recovered",
				"ext", ag.Ext,
				"attempt", attempt,
				"granted_exp", ag.GrantedRegisterExpiry())
			return
		}
		lastErr = err
		ag.MarkRegistrationUncertain(err)
	}
}

func registerRefreshInterval(granted int, cfg *config.VMConfig) time.Duration {
	expires := granted
	if expires <= 0 {
		expires = cfg.RegisterExpires
	}
	if expires <= 0 {
		expires = 3600
	}
	interval := time.Duration(expires) * time.Second / 2
	if interval < time.Second {
		return time.Second
	}
	return interval
}

// StartSubscribeRefreshLoop starts one refresh worker per subscribed agent.
// Each worker refreshes at half of that agent's shortest active granted
// subscription expiry, recalculating after every successful resubscribe.
func StartSubscribeRefreshLoop(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
) func() {
	stopCh := make(chan struct{})
	concurrency := cfg.SubscribeConcurrency
	if concurrency <= 0 {
		concurrency = 10
	}
	sem := make(chan struct{}, concurrency)
	var stopOnce sync.Once

	slog.Info("Subscribe refresh loop started",
		"agents", len(agents),
		"strategy", "per_agent_min_granted_exp_half",
		"configured_subscribe_expires", cfg.SubscribeExpires,
		"concurrency", concurrency)

	for _, ag := range agents {
		go runAgentSubscribeRefresh(ctx, stopCh, sem, ag, cfg)
	}

	return func() {
		stopOnce.Do(func() {
			close(stopCh)
			slog.Info("Subscribe refresh loop stopped")
		})
	}
}

func runAgentSubscribeRefresh(ctx context.Context, stopCh <-chan struct{}, sem chan struct{}, ag *agent.ExtensionAgent, cfg *config.VMConfig) {
	for {
		interval, granted := subscribeRefreshInterval(ag, cfg)
		slog.Debug("Subscribe refresh scheduled",
			"ext", ag.Ext,
			"min_granted_exp", granted,
			"refresh_in_s", int(interval.Seconds()))

		timer := time.NewTimer(interval)
		select {
		case <-stopCh:
			timer.Stop()
			return
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}

		select {
		case sem <- struct{}{}:
		case <-stopCh:
			return
		case <-ctx.Done():
			return
		}

		err := ag.Resubscribe(ctx)
		<-sem
		if err != nil {
			slog.Warn("Resubscribe failed", "ext", ag.Ext, "min_granted_exp", granted, "err", err)
			continue
		}
		slog.Debug("Subscribe refresh complete", "ext", ag.Ext)
	}
}

func subscribeRefreshInterval(ag *agent.ExtensionAgent, cfg *config.VMConfig) (time.Duration, int) {
	expires := 0
	for _, st := range ag.SubscriptionSnapshots() {
		if st.Terminated || !cfg.ShouldRefreshSubscribeEvent(st.Event) {
			continue
		}
		granted := st.GrantedExpires
		if granted <= 0 {
			granted = st.RequestedExpires
		}
		if granted <= 0 {
			granted = cfg.SubscribeExpires
		}
		if granted <= 0 {
			granted = 3600
		}
		if expires == 0 || granted < expires {
			expires = granted
		}
	}
	if expires <= 0 {
		expires = cfg.SubscribeExpires
	}
	if expires <= 0 {
		expires = 3600
	}
	interval := time.Duration(expires) * time.Second / 2
	if interval < time.Second {
		interval = time.Second
	}
	return interval, expires
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

func RunRegSubPipeline(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	skipSubscribe bool,
	onRegisterProgress func(),
	onSubscribeProgress func(event string, ok bool, notifyReceived bool),
	onIdle func(ag *agent.ExtensionAgent),
	onRegOnly func(ag *agent.ExtensionAgent),
	stopNew *atomic.Bool,
) *PipelineHandle {
	if stopNew == nil {
		var sn atomic.Bool
		stopNew = &sn
	}
	done := make(chan *PrePhaseResult, 1)
	subQueue := make(chan *agent.ExtensionAgent, cfg.SubscribeConcurrency*2+1)
	start := time.Now()
	total := len(agents)
	var mu sync.Mutex
	var registeredAg []*agent.ExtensionAgent
	var failedReg []string
	var failedSub []string
	var stopFuncs []func()
	var result *PrePhaseResult
	var stopOnce sync.Once

	addStop := func(fn func()) {
		if fn == nil {
			return
		}
		mu.Lock()
		stopFuncs = append(stopFuncs, fn)
		mu.Unlock()
	}
	stopAllRefresh := func() {
		mu.Lock()
		funcs := append([]func(){}, stopFuncs...)
		stopFuncs = nil
		mu.Unlock()
		for _, fn := range funcs {
			fn()
		}
	}

	subConcurrency := cfg.SubscribeConcurrency
	if subConcurrency <= 0 {
		subConcurrency = 10
	}
	subQueue = make(chan *agent.ExtensionAgent, subConcurrency*2+1)
	var subWG sync.WaitGroup
	for i := 0; i < subConcurrency; i++ {
		subWG.Add(1)
		go func() {
			defer subWG.Done()
			for ag := range subQueue {
				if skipSubscribe {
					if onRegOnly != nil {
						onRegOnly(ag)
					}
					continue
				}
				ok := subscribeOne(ctx, ag, cfg, onSubscribeProgress)
				if ok {
					if onIdle != nil {
						onIdle(ag)
					}
					addStop(StartSubscribeRefreshLoop(ctx, []*agent.ExtensionAgent{ag}, cfg))
				} else {
					mu.Lock()
					failedSub = append(failedSub, ag.Ext)
					mu.Unlock()
					if onRegOnly != nil {
						onRegOnly(ag)
					}
				}
			}
		}()
	}

	go func() {
		defer func() {
			close(subQueue)
			subWG.Wait()
			mu.Lock()
			registered := len(registeredAg)
			subscribed := registered - len(failedSub)
			idleCount := subscribed
			regOnlyCount := len(failedSub)
			if skipSubscribe {
				idleCount = 0
				regOnlyCount = registered
			}
			result = &PrePhaseResult{
				Total:            total,
				Registered:       registered,
				Subscribed:       subscribed,
				IdleCount:        idleCount,
				RegOnlyCount:     regOnlyCount,
				FailedRegister:   append([]string(nil), failedReg...),
				FailedSubscribe:  append([]string(nil), failedSub...),
				RegisteredAgents: append([]*agent.ExtensionAgent(nil), registeredAg...),
				DurationSeconds:  time.Since(start).Seconds(),
			}
			mu.Unlock()
			done <- result
			close(done)
		}()
		batchSize := cfg.RegisterBatchSize
		if batchSize <= 0 {
			batchSize = 10
		}
		batchDelay := cfg.BatchDelay()
		slog.Info("REG/SUB pipelined pre-phase starting", "total", total, "register_batch_size", batchSize, "subscribe_concurrency", subConcurrency)
		for batchStart := 0; batchStart < total; batchStart += batchSize {
			if stopNew.Load() || ctx.Err() != nil {
				slog.Info("Reg/Sub pipeline stopped before next register batch", "completed", batchStart, "total", total)
				return
			}
			batchEnd := batchStart + batchSize
			if batchEnd > total {
				batchEnd = total
			}
			batch := agents[batchStart:batchEnd]
			batchNum := batchStart/batchSize + 1
			slog.Info("REGISTER batch", "batch", batchNum, "from", batchMinExt(batch), "to", batchMaxExt(batch), "count", len(batch))
			var wg sync.WaitGroup
			wg.Add(len(batch))
			for _, ag := range batch {
				go func(a *agent.ExtensionAgent) {
					defer wg.Done()
					ok := registerOne(ctx, a, cfg)
					if onRegisterProgress != nil {
						onRegisterProgress()
					}
					if !ok {
						mu.Lock()
						failedReg = append(failedReg, a.Ext)
						mu.Unlock()
						return
					}
					mu.Lock()
					registeredAg = append(registeredAg, a)
					mu.Unlock()
					addStop(StartRegisterRefreshLoop(ctx, []*agent.ExtensionAgent{a}, cfg))
					if stopNew.Load() || ctx.Err() != nil {
						return
					}
					select {
					case subQueue <- a:
					case <-ctx.Done():
					}
				}(ag)
			}
			wg.Wait()
			if batchEnd < total {
				select {
				case <-ctx.Done():
					return
				case <-time.After(batchDelay):
				}
			}
		}
	}()

	return &PipelineHandle{
		Done: done,
		Stop: func() {
			stopOnce.Do(func() {
				stopNew.Store(true)
				stopAllRefresh()
				select {
				case <-done:
				case <-time.After(time.Duration(cfg.RegisterTimeout*len(cfg.SubscribeEvents)+10) * time.Second):
					slog.Warn("Reg/Sub pipeline stop timed out")
				}
			})
		},
		Result: func() *PrePhaseResult {
			mu.Lock()
			defer mu.Unlock()
			return result
		},
	}
}

type ConnectProgress struct {
	Ext     string
	LocalIP string
	Remote  string
	Err     error
	OK      bool
}

func RunConnectRegSubPipeline(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	skipSubscribe bool,
	onConnectProgress func(ConnectProgress),
	onConnectComplete func(connected, failed int),
	onRegisterProgress func(),
	onSubscribeProgress func(event string, ok bool, notifyReceived bool),
	onIdle func(ag *agent.ExtensionAgent),
	onRegOnly func(ag *agent.ExtensionAgent),
	stopNew *atomic.Bool,
) *PipelineHandle {
	if stopNew == nil {
		var sn atomic.Bool
		stopNew = &sn
	}
	done := make(chan *PrePhaseResult, 1)
	start := time.Now()
	total := len(agents)
	var mu sync.Mutex
	var registeredAg []*agent.ExtensionAgent
	var failedReg []string
	var failedSub []string
	var connectedCount int
	var connectFailed int
	var stopFuncs []func()
	var result *PrePhaseResult
	var stopOnce sync.Once

	addStop := func(fn func()) {
		if fn == nil {
			return
		}
		mu.Lock()
		stopFuncs = append(stopFuncs, fn)
		mu.Unlock()
	}
	stopAllRefresh := func() {
		mu.Lock()
		funcs := append([]func(){}, stopFuncs...)
		stopFuncs = nil
		mu.Unlock()
		for _, fn := range funcs {
			fn()
		}
	}

	subConcurrency := cfg.SubscribeConcurrency
	if subConcurrency <= 0 {
		subConcurrency = 10
	}
	connectBatchSize := cfg.RegisterBatchSize
	if connectBatchSize <= 0 {
		connectBatchSize = 10
	}
	subQueue := make(chan *agent.ExtensionAgent, subConcurrency*2+1)
	regQueue := make(chan *agent.ExtensionAgent, connectBatchSize*2+1)
	var regWG sync.WaitGroup
	for i := 0; i < connectBatchSize; i++ {
		regWG.Add(1)
		go func() {
			defer regWG.Done()
			for ag := range regQueue {
				ok := registerOne(ctx, ag, cfg)
				if onRegisterProgress != nil {
					onRegisterProgress()
				}
				if !ok {
					mu.Lock()
					failedReg = append(failedReg, ag.Ext)
					mu.Unlock()
					continue
				}
				mu.Lock()
				registeredAg = append(registeredAg, ag)
				mu.Unlock()
				addStop(StartRegisterRefreshLoop(ctx, []*agent.ExtensionAgent{ag}, cfg))
				if stopNew.Load() || ctx.Err() != nil {
					continue
				}
				select {
				case subQueue <- ag:
				case <-ctx.Done():
				}
			}
		}()
	}
	var subWG sync.WaitGroup
	for i := 0; i < subConcurrency; i++ {
		subWG.Add(1)
		go func() {
			defer subWG.Done()
			for ag := range subQueue {
				if skipSubscribe {
					if onRegOnly != nil {
						onRegOnly(ag)
					}
					continue
				}
				ok := subscribeOne(ctx, ag, cfg, onSubscribeProgress)
				if ok {
					if onIdle != nil {
						onIdle(ag)
					}
					addStop(StartSubscribeRefreshLoop(ctx, []*agent.ExtensionAgent{ag}, cfg))
				} else {
					mu.Lock()
					failedSub = append(failedSub, ag.Ext)
					mu.Unlock()
					if onRegOnly != nil {
						onRegOnly(ag)
					}
				}
			}
		}()
	}

	go func() {
		defer func() {
			close(regQueue)
			regWG.Wait()
			close(subQueue)
			subWG.Wait()
			mu.Lock()
			registered := len(registeredAg)
			subscribed := registered - len(failedSub)
			idleCount := subscribed
			regOnlyCount := len(failedSub)
			if skipSubscribe {
				idleCount = 0
				regOnlyCount = registered
			}
			result = &PrePhaseResult{
				Total:            total,
				Registered:       registered,
				Subscribed:       subscribed,
				IdleCount:        idleCount,
				RegOnlyCount:     regOnlyCount,
				FailedRegister:   append([]string(nil), failedReg...),
				FailedSubscribe:  append([]string(nil), failedSub...),
				RegisteredAgents: append([]*agent.ExtensionAgent(nil), registeredAg...),
				DurationSeconds:  time.Since(start).Seconds(),
			}
			mu.Unlock()
			done <- result
			close(done)
		}()
		defer func() {
			if onConnectComplete != nil {
				mu.Lock()
				connected, failed := connectedCount, connectFailed
				mu.Unlock()
				onConnectComplete(connected, failed)
			}
		}()

		batchDelay := cfg.BatchDelay()
		connectTimeout := connectTimeoutFromConfig(cfg)
		slog.Info("Connect/Register/Subscribe streaming pre-phase starting",
			"total", total,
			"connect_batch_size", connectBatchSize,
			"register_concurrency", connectBatchSize,
			"subscribe_concurrency", subConcurrency,
			"connect_timeout_ms", connectTimeout.Milliseconds())

		for batchStart := 0; batchStart < total; batchStart += connectBatchSize {
			if stopNew.Load() || ctx.Err() != nil {
				slog.Info("Connect/Reg/Sub pipeline stopped before next connect batch", "completed", batchStart, "total", total)
				return
			}
			batchEnd := batchStart + connectBatchSize
			if batchEnd > total {
				batchEnd = total
			}
			batch := agents[batchStart:batchEnd]
			batchNum := batchStart/connectBatchSize + 1
			slog.Info("Transport/Register batch", "batch", batchNum, "from", batchMinExt(batch), "to", batchMaxExt(batch), "count", len(batch))

			var wg sync.WaitGroup
			for _, ag := range batch {
				wg.Add(1)
				go func(a *agent.ExtensionAgent) {
					defer wg.Done()
					connectCtx, cancel := context.WithTimeout(ctx, connectTimeout)
					err := a.Start(connectCtx)
					cancel()
					if err != nil {
						mu.Lock()
						connectFailed++
						mu.Unlock()
						slog.Error("Agent start failed", "ext", a.Ext, "err", err)
						if onConnectProgress != nil {
							onConnectProgress(ConnectProgress{Ext: a.Ext, LocalIP: cfg.LocalHostForExtension(a.Ext), Remote: fmt.Sprintf("%s:%d", cfg.SBCHost, cfg.SBCPort), Err: err})
						}
						return
					}
					mu.Lock()
					connectedCount++
					mu.Unlock()
					if onConnectProgress != nil {
						onConnectProgress(ConnectProgress{Ext: a.Ext, LocalIP: cfg.LocalHostForExtension(a.Ext), Remote: fmt.Sprintf("%s:%d", cfg.SBCHost, cfg.SBCPort), OK: true})
					}
					if stopNew.Load() || ctx.Err() != nil {
						return
					}
					select {
					case regQueue <- a:
					case <-ctx.Done():
					}
				}(ag)
			}
			wg.Wait()

			if batchEnd < total {
				select {
				case <-ctx.Done():
					return
				case <-time.After(batchDelay):
				}
			}
		}
	}()

	return &PipelineHandle{
		Done: done,
		Stop: func() {
			stopOnce.Do(func() {
				stopNew.Store(true)
				stopAllRefresh()
				select {
				case <-done:
				case <-time.After(time.Duration(cfg.RegisterTimeout*len(cfg.SubscribeEvents)+10) * time.Second):
					slog.Warn("Connect/Reg/Sub pipeline stop timed out")
				}
			})
		},
		Result: func() *PrePhaseResult {
			mu.Lock()
			defer mu.Unlock()
			return result
		},
	}
}

func connectTimeoutFromConfig(cfg *config.VMConfig) time.Duration {
	timeoutSeconds := cfg.ConnectTimeout
	if timeoutSeconds <= 0 {
		timeoutSeconds = 1
	}
	return time.Duration(timeoutSeconds) * time.Second
}
