// Package prephase implements bulk REGISTER + SUBSCRIBE for all extensions
// before any INVITE is fired. It is a direct port of the Python pre_phase.py
// module.
//
// Sequencing:
//
//	Phase 0 — Flush stale registrations (REGISTER Expires:0)
//	Phase 1 — Register all extensions in sequential batches
//	Phase 2 — Subscribe all extensions (optional)
//	Log "ALL EXTENSIONS READY"
package prephase

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cci/traffic-engine/internal/agent"
	"github.com/cci/traffic-engine/internal/config"
)

const batchDelay = 500 * time.Millisecond

// PrePhaseResult holds success/failure counts from the pre-phase pipeline.
type PrePhaseResult struct {
	Total           int
	Registered      int
	Subscribed      int
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

// RegisterAll registers extensions in sequential batches of cfg.RegisterRate.
// Each batch fires concurrently and must complete before the next batch starts.
// A 500 ms pause separates batches to stay within SBC DATAIFPROTECT limits.
// Returns the list of extension numbers that failed to register.
func RegisterAll(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	progressCb func(done, total int),
) []string {
	total := len(agents)
	batchSize := cfg.RegisterRate
	if batchSize <= 0 {
		batchSize = 10
	}

	var (
		mu     sync.Mutex
		failed []string
		done   int64
	)

	slog.Info("Pre-phase: registering extensions",
		"total", total, "batch_size", batchSize,
		"batch_delay_ms", batchDelay.Milliseconds())

	start := time.Now()

	for batchStart := 0; batchStart < total; batchStart += batchSize {
		batchEnd := batchStart + batchSize
		if batchEnd > total {
			batchEnd = total
		}
		batch := agents[batchStart:batchEnd]
		batchNum := batchStart/batchSize + 1

		slog.Info("REGISTER batch",
			"batch", batchNum,
			"from", batch[0].Ext, "to", batch[len(batch)-1].Ext,
			"count", len(batch))

		var wg sync.WaitGroup
		wg.Add(len(batch))

		for _, a := range batch {
			go func(ag *agent.ExtensionAgent) {
				defer wg.Done()
				if !registerOne(ctx, ag, cfg) {
					mu.Lock()
					failed = append(failed, ag.Ext)
					mu.Unlock()
					return
				}
				cur := atomic.AddInt64(&done, 1)
				if progressCb != nil {
					progressCb(int(cur), total)
				}
			}(a)
		}

		wg.Wait()

		succeeded := len(batch)
		mu.Lock()
		batchFailed := 0
		for _, ext := range failed {
			for _, a := range batch {
				if a.Ext == ext {
					batchFailed++
				}
			}
		}
		mu.Unlock()
		succeeded -= batchFailed

		slog.Info("REGISTER batch complete",
			"batch", batchNum, "ok", succeeded, "total", len(batch))

		if batchEnd < total {
			select {
			case <-ctx.Done():
				break
			case <-time.After(batchDelay):
			}
		}
	}

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
		timeout = 8 * time.Second
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

// SubscribeAll subscribes all extensions with a semaphore limiting concurrency
// to cfg.RegisterRate. Returns the list of extension numbers that failed.
func SubscribeAll(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	progressCb func(done, total int),
) []string {
	total := len(agents)
	concurrency := cfg.RegisterRate
	if concurrency <= 0 {
		concurrency = 10
	}

	var (
		mu     sync.Mutex
		failed []string
		done   int64
	)

	slog.Info("Pre-phase: subscribing extensions", "total", total)
	start := time.Now()

	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	wg.Add(total)

	for _, a := range agents {
		go func(ag *agent.ExtensionAgent) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			if !subscribeOne(ctx, ag, cfg) {
				mu.Lock()
				failed = append(failed, ag.Ext)
				mu.Unlock()
				return
			}
			cur := atomic.AddInt64(&done, 1)
			if progressCb != nil {
				progressCb(int(cur), total)
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
func subscribeOne(ctx context.Context, ag *agent.ExtensionAgent, cfg *config.VMConfig) bool {
	maxRetries := cfg.RegisterRetry
	if maxRetries <= 0 {
		maxRetries = 3
	}
	timeout := time.Duration(cfg.RegisterTimeout) * time.Second
	if timeout <= 0 {
		timeout = 8 * time.Second
	}

	for attempt := 1; attempt <= maxRetries; attempt++ {
		subCtx, cancel := context.WithTimeout(ctx, timeout)
		err := ag.Subscribe(subCtx)
		cancel()

		if err == nil {
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
		}
	}

	slog.Error("failed to subscribe after all attempts",
		"ext", ag.Ext, "attempts", maxRetries)
	return false
}

// FlushStaleRegistrations sends REGISTER(Expires:0) for every extension to
// clear stale bindings from a previous run. Errors are swallowed.
func FlushStaleRegistrations(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
) {
	total := len(agents)
	concurrency := cfg.RegisterRate
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

// RunPrePhase executes the full pre-phase pipeline:
//
//	Phase 0 — Flush stale registrations
//	Phase 1 — Register all extensions
//	Phase 2 — Subscribe all extensions (skipped if skipSubscribe is true)
//
// It returns a PrePhaseResult summarising the outcome. An error is returned
// if any extension fails to register or subscribe.
func RunPrePhase(
	ctx context.Context,
	agents []*agent.ExtensionAgent,
	cfg *config.VMConfig,
	skipSubscribe bool,
) (*PrePhaseResult, error) {
	total := len(agents)
	start := time.Now()

	// Phase 0: flush stale registrations
	FlushStaleRegistrations(ctx, agents, cfg)

	// Phase 1: REGISTER
	slog.Info("============================================================")
	slog.Info("PRE-PHASE 1/2 — REGISTER", "count", total)
	slog.Info("============================================================")

	failedReg := RegisterAll(ctx, agents, cfg, nil)

	if len(failedReg) > 0 {
		slog.Error("PRE-PHASE REGISTER failed",
			"failed_count", len(failedReg), "extensions", failedReg)
		return nil, fmt.Errorf(
			"pre-phase REGISTER failed for %d extension(s): %v — aborting, no INVITE will be sent",
			len(failedReg), failedReg)
	}

	// Phase 2: SUBSCRIBE
	var failedSub []string

	if skipSubscribe {
		slog.Info("PRE-PHASE 2/2 — SUBSCRIBE skipped")
	} else {
		slog.Info("============================================================")
		slog.Info("PRE-PHASE 2/2 — SUBSCRIBE", "count", total)
		slog.Info("============================================================")

		failedSub = SubscribeAll(ctx, agents, cfg, nil)

		if len(failedSub) > 0 {
			slog.Error("PRE-PHASE SUBSCRIBE failed",
				"failed_count", len(failedSub), "extensions", failedSub)
			return nil, fmt.Errorf(
				"pre-phase SUBSCRIBE failed for %d extension(s): %v — aborting",
				len(failedSub), failedSub)
		}
	}

	elapsed := time.Since(start).Seconds()
	registered := total - len(failedReg)
	subscribed := total - len(failedSub)

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
		FailedRegister:  failedReg,
		FailedSubscribe: failedSub,
		DurationSeconds: elapsed,
	}

	slog.Info("============================================================")
	slog.Info("ALL EXTENSIONS READY",
		"registered", registered, "subscribed", subscribed,
		"elapsed_s", fmt.Sprintf("%.1f", elapsed))
	slog.Info("============================================================")

	return result, nil
}
