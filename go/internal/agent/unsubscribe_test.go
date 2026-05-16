package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/cci/traffic-engine/internal/config"
)

func TestUnsubscribeSkipsDialogSubscription(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.subscriptions["dialog"] = &SubscriptionState{Event: "dialog", CallID: "sub-call-1"}

	if err := a.Unsubscribe(context.Background()); err != nil {
		t.Fatalf("Unsubscribe returned error: %v", err)
	}

	select {
	case sent := <-tr.sent:
		t.Fatalf("dialog cleanup should not send unsubscribe, sent:\n%s", sent)
	default:
	}
}

func TestUnsubscribeSkipsRegSubscriptionForNow(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.subscriptions["reg"] = &SubscriptionState{Event: "reg", CallID: "sub-call-1"}

	if err := a.Unsubscribe(context.Background()); err != nil {
		t.Fatalf("Unsubscribe returned error: %v", err)
	}

	select {
	case sent := <-tr.sent:
		t.Fatalf("reg cleanup should not send unsubscribe yet, sent:\n%s", sent)
	default:
	}
}

func TestSubscribeStoresSeparateStateForConfiguredEvents(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain:           "avaya.com",
		SIPTransport:     "TCP",
		SIPPassword:      "123456",
		SubscribeExpires: 3600,
		SubscribeEvents:  []string{"dialog", "reg"},
		RegisterTimeout:  1,
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5062

	done := make(chan error, 1)
	go func() {
		done <- a.Subscribe(context.Background())
	}()

	var sent string
	select {
	case sent = <-tr.sent:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for subscribe request")
	}
	if !strings.Contains(sent, "Event: dialog") {
		t.Fatalf("subscribe request missing Event header:\n%s", sent)
	}

	tr.ch <- "SIP/2.0 202 Accepted\r\nCall-ID: sub-call-2\r\nCSeq: 1 SUBSCRIBE\r\nTo: <sip:6000000@avaya.com>;tag=remote-sub-tag\r\nContent-Length: 0\r\n\r\n"

	select {
	case sent = <-tr.sent:
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for second subscribe request")
	}
	if !strings.Contains(sent, "Event: reg") {
		t.Fatalf("second subscribe request missing reg Event header:\n%s", sent)
	}

	tr.ch <- "SIP/2.0 202 Accepted\r\nCall-ID: sub-call-3\r\nCSeq: 1 SUBSCRIBE\r\nTo: <sip:6000000@avaya.com>;tag=remote-reg-tag\r\nContent-Length: 0\r\n\r\n"

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Subscribe returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Subscribe to complete")
	}

	if !strings.Contains(a.subscriptions["dialog"].ToHeader, "tag=remote-sub-tag") {
		t.Fatalf("expected dialog To header to include remote tag, got %q", a.subscriptions["dialog"].ToHeader)
	}
	if !strings.Contains(a.subscriptions["reg"].ToHeader, "tag=remote-reg-tag") {
		t.Fatalf("expected reg To header to include remote tag, got %q", a.subscriptions["reg"].ToHeader)
	}
}
