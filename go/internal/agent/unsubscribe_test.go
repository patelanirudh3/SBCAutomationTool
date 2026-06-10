package agent

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/sip"
)

func TestUnsubscribeSendsExpiresZeroForPolicyEvents(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain: "avaya.com", SIPTransport: "TCP", SIPPassword: "123456",
		SubscribeExpires: 3600, RegisterTimeout: 1, SubscribeUnsubscribeEvents: []string{"dialog"},
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5062
	a.subscriptions["dialog"] = &SubscriptionState{
		Event: "dialog", CallID: "sub-call-1", FromHeader: "<sip:6000000@avaya.com>;tag=local",
		ToHeader: "<sip:6000000@avaya.com>;tag=remote", Contact: "<sip:6000000@127.0.0.1:5062;transport=TCP>",
		RemoteTarget: "sip:6000000@notifier.example.com;transport=tcp",
		RouteSet:     []string{"<sip:proxy1.example.com;lr>", "<sip:proxy2.example.com;lr>"},
		CSeq:         1,
	}

	done := make(chan error, 1)
	go func() { done <- a.Unsubscribe(context.Background()) }()

	sent := waitSent(t, tr)
	if !strings.Contains(sent, "Event: dialog") || !strings.Contains(sent, "Expires: 0") {
		t.Fatalf("unsubscribe did not send dialog Expires:0:\n%s", sent)
	}
	if !strings.Contains(sent, "SUBSCRIBE sip:6000000@notifier.example.com;transport=tcp SIP/2.0") {
		t.Fatalf("unsubscribe did not target stored remote target:\n%s", sent)
	}
	if !strings.Contains(sent, "Route: <sip:proxy1.example.com;lr>") ||
		!strings.Contains(sent, "Route: <sip:proxy2.example.com;lr>") {
		t.Fatalf("unsubscribe did not include stored route set:\n%s", sent)
	}
	tr.ch <- "SIP/2.0 200 OK\r\nCall-ID: sub-call-1\r\nCSeq: 2 SUBSCRIBE\r\nTo: <sip:6000000@avaya.com>;tag=remote\r\nContent-Length: 0\r\n\r\n"
	tr.ch <- "NOTIFY sip:6000000@127.0.0.1:5062 SIP/2.0\r\nCall-ID: sub-call-1\r\nEvent: dialog\r\nSubscription-State: terminated;reason=timeout\r\nCSeq: 1 NOTIFY\r\nFrom: <sip:6000000@avaya.com>;tag=remote\r\nTo: <sip:6000000@avaya.com>;tag=local\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK1\r\nContent-Length: 0\r\n\r\n"

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Unsubscribe returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Unsubscribe to complete")
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

	sent := waitSent(t, tr)
	if !strings.Contains(sent, "Event: dialog") {
		t.Fatalf("subscribe request missing Event header:\n%s", sent)
	}
	dialogCallID := headerValue(sent, "Call-ID")
	dialogLocalTag := tagFromHeader(headerValue(sent, "From"))

	tr.ch <- "SIP/2.0 202 Accepted\r\nCall-ID: " + dialogCallID + "\r\nCSeq: 1 SUBSCRIBE\r\nTo: <sip:6000000@avaya.com>;tag=remote-sub-tag\r\nContact: <sip:6000000@notifier.example.com;transport=tcp>\r\nRecord-Route: <sip:proxy-a.example.com;lr>\r\nRecord-Route: <sip:proxy-b.example.com;lr>\r\nContent-Length: 0\r\n\r\n"
	tr.ch <- "NOTIFY sip:6000000@127.0.0.1:5062 SIP/2.0\r\nCall-ID: " + dialogCallID + "\r\nEvent: dialog\r\nSubscription-State: active;expires=3600\r\nCSeq: 1 NOTIFY\r\nFrom: <sip:6000000@avaya.com>;tag=remote-sub-tag\r\nTo: <sip:6000000@avaya.com>;tag=" + dialogLocalTag + "\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK2\r\nContent-Length: 0\r\n\r\n"

	sent = waitSent(t, tr) // NOTIFY 200 OK
	if !strings.Contains(sent, "SIP/2.0 200 OK") {
		t.Fatalf("expected NOTIFY 200 OK, got:\n%s", sent)
	}
	sent = waitSent(t, tr)
	if !strings.Contains(sent, "Event: reg") {
		t.Fatalf("second subscribe request missing reg Event header:\n%s", sent)
	}
	regCallID := headerValue(sent, "Call-ID")
	regLocalTag := tagFromHeader(headerValue(sent, "From"))

	tr.ch <- "SIP/2.0 202 Accepted\r\nCall-ID: " + regCallID + "\r\nCSeq: 1 SUBSCRIBE\r\nTo: <sip:6000000@avaya.com>;tag=remote-reg-tag\r\nContent-Length: 0\r\n\r\n"
	tr.ch <- "NOTIFY sip:6000000@127.0.0.1:5062 SIP/2.0\r\nCall-ID: " + regCallID + "\r\nEvent: reg\r\nSubscription-State: active;expires=3600\r\nCSeq: 1 NOTIFY\r\nFrom: <sip:6000000@avaya.com>;tag=remote-reg-tag\r\nTo: <sip:6000000@avaya.com>;tag=" + regLocalTag + "\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK3\r\nContent-Length: 0\r\n\r\n"

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
	if a.subscriptions["dialog"].RemoteTarget != "sip:6000000@notifier.example.com;transport=tcp" {
		t.Fatalf("expected dialog remote target from Contact, got %q", a.subscriptions["dialog"].RemoteTarget)
	}
	if got := a.subscriptions["dialog"].RouteSet; len(got) != 2 ||
		got[0] != "<sip:proxy-b.example.com;lr>" || got[1] != "<sip:proxy-a.example.com;lr>" {
		t.Fatalf("expected reversed dialog route set, got %#v", got)
	}
	if !strings.Contains(a.subscriptions["reg"].ToHeader, "tag=remote-reg-tag") {
		t.Fatalf("expected reg To header to include remote tag, got %q", a.subscriptions["reg"].ToHeader)
	}
}

func TestSubscribeAcceptedWithoutNotifyDoesNotRetryNewDialog(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain:           "avaya.com",
		SIPTransport:     "TCP",
		SIPPassword:      "123456",
		SubscribeExpires: 3600,
		SubscribeEvents:  []string{"avaya-cm-feature-status"},
		RegisterTimeout:  1,
		T1Ms:             1,
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5062

	var progress []struct {
		event          string
		ok             bool
		notifyReceived bool
	}
	done := make(chan error, 1)
	go func() {
		done <- a.SubscribeWithProgress(context.Background(), func(event string, ok bool, notifyReceived bool) {
			progress = append(progress, struct {
				event          string
				ok             bool
				notifyReceived bool
			}{event: event, ok: ok, notifyReceived: notifyReceived})
		})
	}()

	initial := waitSent(t, tr)
	callID := headerValue(initial, "Call-ID")
	tr.ch <- "SIP/2.0 401 Unauthorized\r\nCall-ID: " + callID + "\r\nCSeq: 1 SUBSCRIBE\r\nWWW-Authenticate: Digest realm=\"avaya.com\",nonce=\"abc\"\r\nContent-Length: 0\r\n\r\n"

	authRetry := waitSent(t, tr)
	if got := headerValue(authRetry, "Call-ID"); got != callID {
		t.Fatalf("auth retry Call-ID=%q, want %q", got, callID)
	}
	tr.ch <- "SIP/2.0 202 Accepted\r\nCall-ID: " + callID + "\r\nCSeq: 2 SUBSCRIBE\r\nTo: <sip:6000000@avaya.com>;tag=remote-sub-tag\r\nExpires: 3600\r\nContent-Length: 0\r\n\r\n"

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SubscribeWithProgress returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for SubscribeWithProgress to complete")
	}

	if len(progress) != 1 || progress[0].event != "avaya-cm-feature-status" || !progress[0].ok || progress[0].notifyReceived {
		t.Fatalf("unexpected progress: %+v", progress)
	}
	st := a.subscriptions["avaya-cm-feature-status"]
	if st == nil {
		t.Fatal("subscription state was not stored")
	}
	if st.CallID != callID {
		t.Fatalf("stored Call-ID=%q, want original %q", st.CallID, callID)
	}
	if st.NotifyReceived {
		t.Fatal("NotifyReceived=true, want false")
	}
	select {
	case extra := <-tr.sent:
		t.Fatalf("unexpected extra SUBSCRIBE retry:\n%s", extra)
	default:
	}
}

func TestSubscribe423RetriesWithMinExpires(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain:           "avaya.com",
		SIPTransport:     "TCP",
		SIPPassword:      "123456",
		SubscribeExpires: 300,
		SubscribeEvents:  []string{"dialog"},
		RegisterTimeout:  1,
		T1Ms:             1,
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5062

	done := make(chan error, 1)
	go func() {
		_, err := a.SubscribeEvent(context.Background(), "dialog")
		done <- err
	}()

	initial := waitSent(t, tr)
	callID := headerValue(initial, "Call-ID")
	tr.ch <- "SIP/2.0 423 Interval Too Brief\r\nCall-ID: " + callID + "\r\nCSeq: 1 SUBSCRIBE\r\nMin-Expires: 600\r\nContent-Length: 0\r\n\r\n"

	retry := waitSent(t, tr)
	if got := headerValue(retry, "Call-ID"); got != callID {
		t.Fatalf("retry Call-ID=%q, want %q", got, callID)
	}
	if !strings.Contains(retry, "CSeq: 2 SUBSCRIBE") || !strings.Contains(retry, "Expires: 600") {
		t.Fatalf("retry did not use Min-Expires 600 with incremented CSeq:\n%s", retry)
	}
	tr.ch <- "SIP/2.0 202 Accepted\r\nCall-ID: " + callID + "\r\nCSeq: 2 SUBSCRIBE\r\nTo: <sip:6000000@avaya.com>;tag=remote-sub-tag\r\nExpires: 600\r\nContent-Length: 0\r\n\r\n"

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("SubscribeEvent returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for SubscribeEvent")
	}
}

func TestUnsubscribe481TreatsDialogAlreadyGoneAsSuccess(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain: "avaya.com", SIPTransport: "TCP", SIPPassword: "123456",
		SubscribeExpires: 3600, RegisterTimeout: 1, SubscribeUnsubscribeEvents: []string{"dialog"},
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5062
	a.subscriptions["dialog"] = &SubscriptionState{
		Event: "dialog", CallID: "sub-call-481", FromHeader: "<sip:6000000@avaya.com>;tag=local",
		ToHeader: "<sip:6000000@avaya.com>;tag=remote", Contact: "<sip:6000000@127.0.0.1:5062;transport=TCP>",
		CSeq: 1,
	}

	done := make(chan error, 1)
	go func() { done <- a.Unsubscribe(context.Background()) }()

	waitSent(t, tr)
	tr.ch <- "SIP/2.0 481 Subscription Does Not Exist\r\nCall-ID: sub-call-481\r\nCSeq: 2 SUBSCRIBE\r\nContent-Length: 0\r\n\r\n"

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Unsubscribe returned error: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Unsubscribe")
	}
	if _, ok := a.subscriptions["dialog"]; ok {
		t.Fatal("subscription was not removed after 481 cleanup success")
	}
}

func TestSubscriptionAuthHeaderNameIsPreservedForProxyChallenge(t *testing.T) {
	a := newTestAgent(t, newMockTransport())
	a.Config = &config.VMConfig{Domain: "avaya.com", SIPTransport: "TCP"}
	st := &SubscriptionState{
		Event: "reg", CallID: "sub-call-1", FromHeader: "<sip:6000000@avaya.com>;tag=local",
		ToHeader: "<sip:6000000@avaya.com>;tag=remote", Contact: "<sip:6000000@127.0.0.1:5062;transport=TCP>",
		AuthHeaderName: "Proxy-Authorization",
		CSeq:           2,
	}
	msg := a.buildSubscribeMessage(st, 0)
	addSubscriptionAuth(msg, st, "Digest response=\"abc\"")
	raw := sip.BuildMessage(msg, "")
	if !strings.Contains(raw, "Proxy-Authorization: Digest response=\"abc\"") {
		t.Fatalf("expected Proxy-Authorization on in-dialog subscribe, got:\n%s", raw)
	}
	if strings.Contains(raw, "\r\nAuthorization:") {
		t.Fatalf("unexpected Authorization header for proxy auth state:\n%s", raw)
	}
}

func TestRegisterFinalFailureReportsSIPCode(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain:           "avaya.com",
		SIPTransport:     "TCP",
		SIPPassword:      "123456",
		RegisterExpires:  3600,
		RegisterTimeout:  1,
		SubscribeExpires: 3600,
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5062

	done := make(chan error, 1)
	go func() { done <- a.Register(context.Background()) }()

	sent := waitSent(t, tr)
	callID := headerValue(sent, "Call-ID")
	tr.ch <- "SIP/2.0 404 Not Found\r\nCall-ID: " + callID + "\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n"

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Register returned nil, want 404 error")
		}
		if !strings.Contains(err.Error(), "code=404") || !strings.Contains(err.Error(), "REGISTER") {
			t.Fatalf("Register error=%q, want explicit 404 REGISTER", err.Error())
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Register to return 404")
	}
}

func waitSent(t *testing.T, tr *mockTransport) string {
	t.Helper()
	select {
	case sent := <-tr.sent:
		return sent
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for SIP send")
		return ""
	}
}

func headerValue(raw, name string) string {
	prefix := strings.ToLower(name) + ":"
	for _, line := range strings.Split(raw, "\r\n") {
		if strings.HasPrefix(strings.ToLower(line), prefix) {
			return strings.TrimSpace(line[len(name)+1:])
		}
	}
	return ""
}
