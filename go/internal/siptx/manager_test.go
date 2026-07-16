package siptx

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cci/traffic-engine/internal/sip"
)

type testSender struct {
	mu        sync.Mutex
	connected bool
	sent      []string
}

func newTestSender() *testSender {
	return &testSender{connected: true}
}

func (s *testSender) Send(msg string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent = append(s.sent, msg)
	return nil
}

func (s *testSender) IsConnected() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.connected
}

func (s *testSender) setConnected(v bool) {
	s.mu.Lock()
	s.connected = v
	s.mu.Unlock()
}

func (s *testSender) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sent)
}

func (s *testSender) joined() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return strings.Join(s.sent, "\n---\n")
}

func shortTimers() Timers {
	return Timers{
		T1:     10 * time.Millisecond,
		T2:     20 * time.Millisecond,
		T4:     10 * time.Millisecond,
		TimerB: 80 * time.Millisecond,
		TimerF: 80 * time.Millisecond,
		TimerH: 80 * time.Millisecond,
		TimerJ: 40 * time.Millisecond,
	}
}

const inviteReq = "INVITE sip:6001@example.com SIP/2.0\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-inv\r\nFrom: <sip:6000@example.com>;tag=from1\r\nTo: <sip:6001@example.com>\r\nCall-ID: call-inv\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"
const invite100 = "SIP/2.0 100 Trying\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-inv\r\nFrom: <sip:6000@example.com>;tag=from1\r\nTo: <sip:6001@example.com>\r\nCall-ID: call-inv\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"

func TestInviteTimerARetransmitsAndStopsOnFirstResponse(t *testing.T) {
	s := newTestSender()
	m := NewManager(s, shortTimers())
	defer m.Shutdown("test_done")

	if err := m.Send(inviteReq); err != nil {
		t.Fatalf("Send INVITE: %v", err)
	}
	time.Sleep(25 * time.Millisecond)
	if got := s.count(); got < 2 {
		t.Fatalf("expected Timer A retransmission, sent=%d\n%s", got, s.joined())
	}

	m.HandleInbound(invite100)
	stoppedAt := s.count()
	time.Sleep(35 * time.Millisecond)
	if got := s.count(); got != stoppedAt {
		t.Fatalf("Timer A did not stop on provisional response: before=%d after=%d\n%s", stoppedAt, got, s.joined())
	}
}

func TestInviteProvisionalStopsTimerAButNotTimerB(t *testing.T) {
	s := newTestSender()
	timers := shortTimers()
	m := NewManager(s, timers)
	defer m.Shutdown("test_done")

	if err := m.Send(inviteReq); err != nil {
		t.Fatalf("Send INVITE: %v", err)
	}
	m.HandleInbound(invite100)

	tx := getClientTx(t, m, inviteReq)
	select {
	case <-tx.ctx.Done():
		t.Fatal("transaction context canceled by provisional response; Timer B was stopped")
	case <-time.After(timers.TimerB / 2):
	}

	select {
	case <-tx.ctx.Done():
	case <-time.After(timers.TimerB):
		t.Fatal("Timer B did not fire after provisional response")
	}
}

func getClientTx(t *testing.T, m *Manager, raw string) *clientTx {
	t.Helper()
	msg := mustParseForTest(t, raw)
	key := clientKey(msg)
	m.mu.Lock()
	defer m.mu.Unlock()
	tx := m.client[key]
	if tx == nil {
		t.Fatalf("client transaction %q not found", key)
	}
	return tx
}

func mustParseForTest(t *testing.T, raw string) *sip.SipMessage {
	t.Helper()
	msg, _, err := sip.ParseMessage(raw)
	if err != nil {
		t.Fatalf("parse test SIP: %v", err)
	}
	return msg
}

const registerReq = "REGISTER sip:example.com SIP/2.0\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-reg\r\nFrom: <sip:6000@example.com>;tag=from2\r\nTo: <sip:6000@example.com>\r\nCall-ID: call-reg\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n"
const register200 = "SIP/2.0 200 OK\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-reg\r\nFrom: <sip:6000@example.com>;tag=from2\r\nTo: <sip:6000@example.com>;tag=to2\r\nCall-ID: call-reg\r\nCSeq: 1 REGISTER\r\nContent-Length: 0\r\n\r\n"

func TestNonInviteTimerERetransmitsAndStopsOnFinalResponse(t *testing.T) {
	s := newTestSender()
	m := NewManager(s, shortTimers())
	defer m.Shutdown("test_done")

	if err := m.Send(registerReq); err != nil {
		t.Fatalf("Send REGISTER: %v", err)
	}
	time.Sleep(25 * time.Millisecond)
	if got := s.count(); got < 2 {
		t.Fatalf("expected Timer E retransmission, sent=%d\n%s", got, s.joined())
	}

	m.HandleInbound(register200)
	stoppedAt := s.count()
	time.Sleep(35 * time.Millisecond)
	if got := s.count(); got != stoppedAt {
		t.Fatalf("Timer E did not stop on final response: before=%d after=%d\n%s", stoppedAt, got, s.joined())
	}
}

func TestRetransmissionStopsWhenTransportIsDown(t *testing.T) {
	s := newTestSender()
	m := NewManager(s, shortTimers())
	defer m.Shutdown("test_done")

	if err := m.Send(registerReq); err != nil {
		t.Fatalf("Send REGISTER: %v", err)
	}
	s.setConnected(false)
	time.Sleep(35 * time.Millisecond)
	if got := s.count(); got != 1 {
		t.Fatalf("expected no retransmit after transport down, sent=%d\n%s", got, s.joined())
	}
}

const notifyReq = "NOTIFY sip:6000@example.com SIP/2.0\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-notify\r\nFrom: <sip:6001@example.com>;tag=from3\r\nTo: <sip:6000@example.com>;tag=to3\r\nCall-ID: call-notify\r\nCSeq: 4 NOTIFY\r\nEvent: dialog\r\nSubscription-State: active\r\nContent-Length: 0\r\n\r\n"
const notify200 = "SIP/2.0 200 OK\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-notify\r\nFrom: <sip:6001@example.com>;tag=from3\r\nTo: <sip:6000@example.com>;tag=to3\r\nCall-ID: call-notify\r\nCSeq: 4 NOTIFY\r\nContent-Length: 0\r\n\r\n"

func TestDuplicateNonInviteRequestReplaysCachedResponse(t *testing.T) {
	s := newTestSender()
	m := NewManager(s, shortTimers())
	defer m.Shutdown("test_done")

	if err := m.Send(notify200); err != nil {
		t.Fatalf("Send NOTIFY 200: %v", err)
	}
	if handled := m.HandleInbound(notifyReq); !handled {
		t.Fatal("duplicate NOTIFY was not handled by transaction layer")
	}
	if got := s.count(); got != 2 {
		t.Fatalf("expected initial response plus cached replay, sent=%d\n%s", got, s.joined())
	}
}

const invite200 = "SIP/2.0 200 OK\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-invite-srv\r\nFrom: <sip:6000@example.com>;tag=from4\r\nTo: <sip:6001@example.com>;tag=to4\r\nCall-ID: call-invite-srv\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"
const inviteAck = "ACK sip:6001@example.com SIP/2.0\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-ack-new\r\nFrom: <sip:6000@example.com>;tag=from4\r\nTo: <sip:6001@example.com>;tag=to4\r\nCall-ID: call-invite-srv\r\nCSeq: 1 ACK\r\nContent-Length: 0\r\n\r\n"

func TestInvite2xxRetransmissionStopsOnAck(t *testing.T) {
	s := newTestSender()
	m := NewManager(s, shortTimers())
	defer m.Shutdown("test_done")

	if err := m.Send(invite200); err != nil {
		t.Fatalf("Send INVITE 200: %v", err)
	}
	time.Sleep(25 * time.Millisecond)
	if got := s.count(); got < 2 {
		t.Fatalf("expected INVITE 2xx retransmission, sent=%d\n%s", got, s.joined())
	}

	m.HandleInbound(inviteAck)
	stoppedAt := s.count()
	time.Sleep(35 * time.Millisecond)
	if got := s.count(); got != stoppedAt {
		t.Fatalf("INVITE 2xx retransmission did not stop on ACK: before=%d after=%d\n%s", stoppedAt, got, s.joined())
	}
}

const inviteReqFor2xx = "INVITE sip:6001@example.com SIP/2.0\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-uac-2xx\r\nFrom: <sip:6000@example.com>;tag=from5\r\nTo: <sip:6001@example.com>\r\nCall-ID: call-uac-2xx\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"
const invite200ForUAC = "SIP/2.0 200 OK\r\nVia: SIP/2.0/TCP 127.0.0.1:5060;branch=z9hG4bK-uac-2xx\r\nFrom: <sip:6000@example.com>;tag=from5\r\nTo: <sip:6001@example.com>;tag=to5\r\nCall-ID: call-uac-2xx\r\nCSeq: 1 INVITE\r\nContent-Length: 0\r\n\r\n"

func TestDuplicateInvite2xxInvokesAckReplayCallbackAndSuppressesDelivery(t *testing.T) {
	s := newTestSender()
	m := NewManager(s, shortTimers())
	defer m.Shutdown("test_done")

	callbacks := 0
	m.SetDuplicateInvite2xxHandler(func(raw string) {
		callbacks++
		if !strings.Contains(raw, "SIP/2.0 200 OK") {
			t.Fatalf("callback raw did not contain 200 OK:\n%s", raw)
		}
	})

	if err := m.Send(inviteReqFor2xx); err != nil {
		t.Fatalf("Send INVITE: %v", err)
	}
	if handled := m.HandleInbound(invite200ForUAC); handled {
		t.Fatal("first INVITE 2xx should be delivered to business logic")
	}
	if handled := m.HandleInbound(invite200ForUAC); !handled {
		t.Fatal("duplicate INVITE 2xx should be handled by transaction layer")
	}
	if callbacks != 1 {
		t.Fatalf("callbacks=%d, want 1", callbacks)
	}
}
