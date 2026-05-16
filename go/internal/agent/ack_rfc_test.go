package agent

import (
	"strings"
	"testing"

	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/sip"
)

func newAckTestAgent(t *testing.T) (*ExtensionAgent, *mockTransport) {
	t.Helper()
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain:       "example.com",
		SIPTransport: "UDP",
		SIPPassword:  "secret",
	}
	a.localHost = "192.0.2.10"
	a.localPort = 5060
	return a, tr
}

func newInviteDialog() *DialogState {
	invite := sip.NewSipMessage()
	invite.SetRequestLine("INVITE sip:6000001@example.com;user=phone SIP/2.0")
	invite.AddHeader(sip.HdrCallID, "call-1")
	invite.AddHeader(sip.HdrFrom, "<sip:6000000@example.com>;tag=local-1")
	invite.AddHeader(sip.HdrTo, "<sip:6000001@example.com>")
	invite.AddHeader(sip.HdrVia, "SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-original")
	invite.AddHeader(sip.HdrCSeq, "1 INVITE")
	invite.AddHeader(sip.HdrContentLength, "0")

	return &DialogState{
		CallID:     "call-1",
		LocalExt:   "6000000",
		RemoteExt:  "6000001",
		Domain:     "example.com",
		CSeq:       1,
		InviteCSeq: 1,
		InviteMsg:  invite,
		InviteSDP:  "v=0\r\n",
	}
}

func TestSendAckForFailureUsesOriginalInviteTransaction(t *testing.T) {
	a, tr := newAckTestAgent(t)
	dialog := newInviteDialog()
	raw480 := "SIP/2.0 480 Temporarily Unavailable\r\n" +
		"Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-original\r\n" +
		"From: <sip:6000000@example.com>;tag=local-1\r\n" +
		"To: <sip:6000001@example.com>;tag=remote-1\r\n" +
		"Call-ID: call-1\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"Content-Length: 0\r\n\r\n"

	if err := a.SendAckForFailure(dialog, raw480); err != nil {
		t.Fatalf("SendAckForFailure: %v", err)
	}

	ack := <-tr.sent
	for _, want := range []string{
		"ACK sip:6000001@example.com;user=phone SIP/2.0",
		"Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-original",
		"From: <sip:6000000@example.com>;tag=local-1",
		"To: <sip:6000001@example.com>;tag=remote-1",
		"Call-ID: call-1",
		"CSeq: 1 ACK",
	} {
		if !strings.Contains(ack, want) {
			t.Fatalf("ACK missing %q:\n%s", want, ack)
		}
	}
	if strings.Contains(ack, "CSeq: 1 INVITE") {
		t.Fatalf("ACK reused INVITE CSeq method:\n%s", ack)
	}
}

func TestHandle401InviteAcksThenRetriesWithAuthorization(t *testing.T) {
	a, tr := newAckTestAgent(t)
	dialog := newInviteDialog()
	raw401 := "SIP/2.0 401 Unauthorized\r\n" +
		"Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-original\r\n" +
		"From: <sip:6000000@example.com>;tag=local-1\r\n" +
		"To: <sip:6000001@example.com>;tag=remote-auth\r\n" +
		"Call-ID: call-1\r\n" +
		"CSeq: 1 INVITE\r\n" +
		"WWW-Authenticate: Digest realm=\"example.com\",nonce=\"nonce-1\",opaque=\"opaque-1\",algorithm=MD5,qop=\"auth\"\r\n" +
		"Content-Length: 0\r\n\r\n"

	if err := a.Handle401Invite(dialog, raw401, 4000); err != nil {
		t.Fatalf("Handle401Invite: %v", err)
	}

	ack := <-tr.sent
	retry := <-tr.sent
	if !strings.Contains(ack, "ACK sip:6000001@example.com;user=phone SIP/2.0") ||
		!strings.Contains(ack, "Via: SIP/2.0/UDP 192.0.2.10:5060;branch=z9hG4bK-original") ||
		!strings.Contains(ack, "CSeq: 1 ACK") {
		t.Fatalf("401 ACK is not tied to original INVITE transaction:\n%s", ack)
	}
	if !strings.Contains(retry, "INVITE sip:6000001@example.com;user=phone SIP/2.0") {
		t.Fatalf("retry did not preserve INVITE Request-URI:\n%s", retry)
	}
	if !strings.Contains(retry, "CSeq: 2 INVITE") {
		t.Fatalf("retry did not increment INVITE CSeq:\n%s", retry)
	}
	if !strings.Contains(retry, "Authorization: Digest") || !strings.Contains(retry, `nonce="nonce-1"`) {
		t.Fatalf("retry missing Authorization digest:\n%s", retry)
	}
	if strings.Contains(retry, "branch=z9hG4bK-original") {
		t.Fatalf("retry reused original INVITE branch:\n%s", retry)
	}
}
