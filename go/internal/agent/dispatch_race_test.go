package agent

import (
	"context"
	"testing"
	"time"
)

// mockTransport is a minimal in-process SIP transport used by tests.
type mockTransport struct {
	ch   chan string
	sent chan string
}

func newMockTransport() *mockTransport {
	return &mockTransport{ch: make(chan string, 64), sent: make(chan string, 64)}
}
func (m *mockTransport) Connect(_ context.Context) error { return nil }
func (m *mockTransport) Send(msg string) error {
	m.sent <- msg
	return nil
}
func (m *mockTransport) RecvChan() <-chan string { return m.ch }
func (m *mockTransport) Close() error            { return nil }
func (m *mockTransport) LocalPort() int          { return 0 }

// newTestAgent creates an agent wired to a mockTransport and starts its
// dispatchLoop.
func newTestAgent(t *testing.T, tr *mockTransport) *ExtensionAgent {
	t.Helper()
	a := &ExtensionAgent{
		Ext:           "6000000",
		ActiveDialogs: make(map[string]*DialogState),
		ZombieDialogs: make(map[string]*DialogState),
		handlers:      make(map[string][]chan string),
		dialogQueues:  make(map[string]chan SipEvent),
		subscriptions: make(map[string]*SubscriptionState),
		Registered:    make(chan struct{}),
		Subscribed:    make(chan struct{}),
		transport:     tr,
	}
	go a.dispatchLoop()
	t.Cleanup(func() { a.closed.Store(true) })
	return a
}

// raw100 is a minimal SIP 100 Trying whose CSeq method is INVITE.
const raw100 = "SIP/2.0 100 Trying\r\nCall-ID: test-call\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"

// raw407 is a minimal SIP 407 Proxy Authentication Required for an INVITE.
// ClassifyMessage returns "407_INVITE" for this message.
const raw407 = "SIP/2.0 407 Proxy Authentication Required\r\nCall-ID: test-call\r\nCSeq: 1 INVITE\r\nProxy-Authenticate: Digest realm=\"avaya.com\",nonce=\"abc\"\r\nContent-Length: 0\r\n\r\n"

// raw403Sub is a 403 Forbidden response to a SUBSCRIBE.
const raw403Sub = "SIP/2.0 403 Forbidden\r\nCSeq: 1 SUBSCRIBE\r\nContent-Length: 0\r\n\r\n"

// raw489Sub is a 489 Bad Event response to a SUBSCRIBE.
const raw489Sub = "SIP/2.0 489 Bad Event\r\nCSeq: 1 SUBSCRIBE\r\nContent-Length: 0\r\n\r\n"

// TestDispatchRace_100Then407_SameMs is the regression test for the bug where
// a 100 Trying and a 407 arrive in back-to-back dispatchLoop iterations while
// WaitForSIPEvent is blocked.  Before the fix, the 407 was silently dropped
// (the handler channel was full with the 100) and the call would time out.
// With the buffer-8 fix both messages fit in the channel; the first
// WaitForSIPEvent reads "100", the second finds "407_INVITE" still buffered.
func TestDispatchRace_100Then407_SameMs(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)

	// Push both messages into the transport channel before WaitForSIPEvent
	// registers its handler, simulating the race where both arrive before the
	// goroutine is scheduled to consume the first one.
	tr.ch <- raw100
	tr.ch <- raw407

	// Give the dispatchLoop a moment to process both messages before
	// WaitForSIPEvent runs its earlyResponse scan.
	time.Sleep(10 * time.Millisecond)

	ctx := context.Background()

	// First wait: must return the "100".
	got1, err := a.WaitForSIPEvent(ctx, time.Second, "100", "180", "183", "407_INVITE", "200_INVITE")
	if err != nil {
		t.Fatalf("first WaitForSIPEvent error: %v", err)
	}
	if got1 != raw100 {
		t.Fatalf("expected raw100, got: %q", got1)
	}

	// Second wait: must return the "407_INVITE" — previously it would time out
	// here because the 407 was silently dropped when the channel was full.
	got2, err := a.WaitForSIPEvent(ctx, 500*time.Millisecond, "100", "180", "183", "407_INVITE", "200_INVITE")
	if err != nil {
		t.Fatalf("second WaitForSIPEvent timed out — 407_INVITE was dropped (regression): %v", err)
	}
	if got2 != raw407 {
		t.Fatalf("expected raw407, got: %q", got2)
	}
}

func TestDialogQueue_100Then407_SameMs(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.RegisterDialogQueue("test-call")
	defer a.RemoveDialogQueue("test-call")

	tr.ch <- raw100
	tr.ch <- raw407

	ctx := context.Background()
	got1, err := a.WaitForDialogEvent(ctx, "test-call", time.Second, "100", "180", "183", "407_INVITE", "200_INVITE")
	if err != nil {
		t.Fatalf("first WaitForDialogEvent error: %v", err)
	}
	if got1.Raw != raw100 || got1.Code != "100" {
		t.Fatalf("expected 100 event, got code=%q raw=%q", got1.Code, got1.Raw)
	}

	got2, err := a.WaitForDialogEvent(ctx, "test-call", 500*time.Millisecond, "100", "180", "183", "407_INVITE", "200_INVITE")
	if err != nil {
		t.Fatalf("second WaitForDialogEvent timed out — 407_INVITE was lost (regression): %v", err)
	}
	if got2.Raw != raw407 || got2.Code != "407_INVITE" {
		t.Fatalf("expected 407_INVITE event, got code=%q raw=%q", got2.Code, got2.Raw)
	}
}
