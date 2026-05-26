package metrics

import "testing"

func TestMilestoneCountersAreEventDrivenAndDeduped(t *testing.T) {
	c := NewMetricsCollector("traffic-local", 1)

	uacCall := "uac-call-1"
	uasCall := "uas-call-1"

	c.RecordRawEvent(map[string]any{"call_id": uacCall, "direction": "uac", "event": "INVITE_SENT"})
	c.RecordRawEvent(map[string]any{"call_id": uacCall, "direction": "uac", "event": "TRYING_100"})
	c.RecordRawEvent(map[string]any{"call_id": uacCall, "direction": "uac", "event": "TRYING_100"})
	c.RecordRawEvent(map[string]any{"call_id": uacCall, "direction": "uac", "event": "OK_200_INVITE"})
	c.RecordRawEvent(map[string]any{"call_id": uasCall, "direction": "uas", "event": "UAS_ACK_RECEIVED"})
	c.RecordRawEvent(map[string]any{"call_id": uasCall, "direction": "uas", "event": "UAS_ACK_RECEIVED"})

	snap := c.BuildSnapshot()
	if snap.CallsInviteSent != 1 {
		t.Fatalf("calls_invite_sent=%d, want 1", snap.CallsInviteSent)
	}
	if snap.CallsAttempted != 1 {
		t.Fatalf("calls_attempted=%d, want 1", snap.CallsAttempted)
	}
	if snap.CallsAnswered != 1 {
		t.Fatalf("calls_answered=%d, want 1", snap.CallsAnswered)
	}
	if snap.CallsAcknowledged != 1 {
		t.Fatalf("calls_acknowledged=%d, want 1", snap.CallsAcknowledged)
	}
	if snap.CallsCompleted != 0 {
		t.Fatalf("calls_completed=%d, want 0 before BYE_200", snap.CallsCompleted)
	}
	if snap.ASR != 100 {
		t.Fatalf("asr=%v, want 100 after OK_200_INVITE", snap.ASR)
	}
	if snap.CSR != 0 {
		t.Fatalf("csr=%v, want 0 before BYE_200", snap.CSR)
	}

	c.RecordRawEvent(map[string]any{"call_id": uacCall, "direction": "uac", "event": "BYE_200"})
	c.RecordRawEvent(map[string]any{"call_id": uacCall, "direction": "uac", "event": "BYE_200"})
	snap = c.BuildSnapshot()
	if snap.CallsCompleted != 1 {
		t.Fatalf("calls_completed=%d, want 1", snap.CallsCompleted)
	}
	if snap.CSR != 100 {
		t.Fatalf("csr=%v, want 100 after BYE_200", snap.CSR)
	}
}

func TestRecordCallDoesNotMutateLiveFunnelCounters(t *testing.T) {
	c := NewMetricsCollector("traffic-local", 1)

	c.RecordCall(CallResultData{
		CallID:   "uac-result",
		Caller:   "6001",
		Callee:   "6002",
		Success:  true,
		Answered: true,
		PDDMs:    100,
		HoldMs:   10000,
		TotalMs:  10100,
	})
	c.RecordCall(CallResultData{
		CallID:    "uas-result",
		Caller:    "6001",
		Callee:    "6002",
		Success:   true,
		Answered:  true,
		Direction: "uas",
	})

	snap := c.BuildSnapshot()
	if snap.CallsAttempted != 0 || snap.CallsAnswered != 0 ||
		snap.CallsAcknowledged != 0 || snap.CallsCompleted != 0 ||
		snap.CallsFailed != 0 {
		t.Fatalf("RecordCall mutated live funnel counters: %+v", snap)
	}
}

func TestFailureCounterIsExplicitOnly(t *testing.T) {
	c := NewMetricsCollector("traffic-local", 1)

	c.RecordRawEvent(map[string]any{"call_id": "call-1", "direction": "uac", "event": "TRYING_100"})
	c.RecordRawEvent(map[string]any{"call_id": "call-2", "direction": "uac", "event": "TRYING_100"})

	snap := c.BuildSnapshot()
	if snap.CallsFailed != 0 {
		t.Fatalf("calls_failed=%d, want 0 for in-progress calls", snap.CallsFailed)
	}

	c.RecordRawEvent(map[string]any{"call_id": "call-1", "direction": "uac", "event": "CALL_TIMEOUT"})
	c.RecordRawEvent(map[string]any{"call_id": "call-1", "direction": "uac", "event": "CALL_FAILED"})
	snap = c.BuildSnapshot()
	if snap.CallsFailed != 1 {
		t.Fatalf("calls_failed=%d, want 1 after duplicate failure events", snap.CallsFailed)
	}
}

func TestCleanupSplitCountersKeepUnregisterSeparate(t *testing.T) {
	c := NewMetricsCollector("traffic-local", 1)
	c.ResetCleanup(2)

	c.IncrementCleanupUnsubscribe("6001", true, true)
	c.IncrementCleanupUnregister("6001", true)
	c.IncrementCleanupUnsubscribe("6002", false, false)
	c.IncrementCleanupUnregister("6002", true)

	snap := c.BuildSnapshot()
	if snap.CleanupCount != 2 || snap.CleanupUnregisterCount != 2 {
		t.Fatalf("unregister counts got cleanup=%d unregister=%d, want 2/2", snap.CleanupCount, snap.CleanupUnregisterCount)
	}
	if len(snap.CleanupFailed) != 0 || len(snap.CleanupUnregisterFailed) != 0 {
		t.Fatalf("unregister failure should be empty: legacy=%v unregister=%v", snap.CleanupFailed, snap.CleanupUnregisterFailed)
	}
	if snap.CleanupUnsubscribeSkipped != 1 || snap.CleanupUnsubscribeCount != 1 {
		t.Fatalf("unsubscribe skipped/count=%d/%d, want 1/1", snap.CleanupUnsubscribeSkipped, snap.CleanupUnsubscribeCount)
	}
	if len(snap.CleanupUnsubscribeFailed) != 1 || snap.CleanupUnsubscribeFailed[0] != "6002" {
		t.Fatalf("unsubscribe failed=%v, want [6002]", snap.CleanupUnsubscribeFailed)
	}
}

func TestCleanupUnsubscribeByEventIsExposed(t *testing.T) {
	c := NewMetricsCollector("traffic-local", 1)
	c.ResetCleanup(2)
	c.RecordCleanupUnsubscribeEvent("reg", true)
	c.RecordCleanupUnsubscribeEvent("reg", true)
	c.IncrementCleanupUnsubscribe("6001", false, true)
	c.IncrementCleanupUnsubscribe("6002", false, true)

	snap := c.BuildSnapshot()
	if got := snap.CleanupUnsubscribeByEvent["reg"]; got.Total != 2 || got.Successful != 2 || got.Failed != 0 {
		t.Fatalf("cleanup unsubscribe by event=%+v, want total=2 successful=2 failed=0", got)
	}
	details := c.CleanupDetailsSnapshot()
	if got := details.UnsubscribeByEvent["reg"]; got.Total != 2 || got.Successful != 2 {
		t.Fatalf("cleanup details by event=%+v, want total=2 successful=2", got)
	}
}

func TestUpdateCountsDoesNotCollapseMultiEventSubscribeProgress(t *testing.T) {
	c := NewMetricsCollector("traffic-local", 1)
	c.SetRegisterTotal(5)
	c.SetSubscribeTotal(30)
	c.SetSubscribeEventTotals([]string{
		"avaya-cm-feature-status",
		"avaya-cm-cc-info",
		"dialog",
		"avaya-ccs-profile",
		"reg",
		"message-summary",
	}, 5)

	for _, event := range []string{
		"avaya-cm-feature-status",
		"avaya-cm-cc-info",
		"dialog",
		"avaya-ccs-profile",
		"reg",
		"message-summary",
	} {
		for i := 0; i < 5; i++ {
			c.RecordSubscriptionEvent(event, true, true)
		}
	}

	c.UpdateCounts(0, 5, 5, 5)
	snap := c.BuildSnapshot()
	if snap.SubscribedCount != 30 || snap.SubscribedTotal != 30 {
		t.Fatalf("subscribe progress=%d/%d, want 30/30", snap.SubscribedCount, snap.SubscribedTotal)
	}
	if got := snap.SubscriptionsByEvent["dialog"]; got.Successful != 5 || got.NotifyReceived != 5 {
		t.Fatalf("dialog stats=%+v, want successful=5 notify=5", got)
	}
}

func TestPerformanceWarningsAttributeHighHostLowEngineCPU(t *testing.T) {
	warnings := performanceWarnings(HostHealth{
		CPUPercent:            85,
		ProcessCPUPercentCore: 2,
		CPUSoftIRQPercent:     12,
	})
	if len(warnings) < 2 {
		t.Fatalf("warnings=%v, want host/engine and softirq warnings", warnings)
	}
}

func TestPerformanceDiagnosticsModeDefaultsInvalidToWarningOnly(t *testing.T) {
	c := NewMetricsCollector("traffic-local", 1)
	if got := c.SetPerformanceDiagnosticsMode("bad-mode"); got != TopProcessModeWarningOnly {
		t.Fatalf("mode=%q, want %q", got, TopProcessModeWarningOnly)
	}
	if got := c.SetPerformanceDiagnosticsMode(TopProcessModeSlow); got != TopProcessModeSlow {
		t.Fatalf("mode=%q, want %q", got, TopProcessModeSlow)
	}
}
