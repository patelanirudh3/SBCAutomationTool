package agent

import (
	"strings"
	"testing"

	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/sip"
)

func TestRegisterUsesSIPSScheme(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain: "avaya.com", SIPTransport: "TLS", SIPScheme: "SIPS",
		SIPPassword: "123456", RegisterExpires: 3600,
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5061

	_ = a.buildInitialRegisterForTest()
	sent := waitSent(t, tr)
	if !strings.Contains(sent, "REGISTER sips:avaya.com SIP/2.0") ||
		!strings.Contains(sent, "From: <sips:6000000@avaya.com>;") ||
		!strings.Contains(sent, "To: <sips:6000000@avaya.com>") ||
		!strings.Contains(sent, "Contact: <sips:6000000@127.0.0.1:5061;transport=TLS") {
		t.Fatalf("REGISTER did not use SIPS consistently:\n%s", sent)
	}
}

func (a *ExtensionAgent) buildInitialRegisterForTest() string {
	msg := sip.BuildInitialRegisterWithScheme(a.Ext, a.Config.Domain, a.uriScheme(), a.Config.SIPTransport, a.localHost, a.localPort, a.Config.RegisterExpires)
	raw := sip.BuildMessage(msg, "")
	_ = a.transport.Send(raw)
	return raw
}

func TestInviteUsesSIPSScheme(t *testing.T) {
	tr := newMockTransport()
	a := newTestAgent(t, tr)
	a.Config = &config.VMConfig{
		Domain: "avaya.com", SIPTransport: "TLS", SIPScheme: "SIPS",
		SIPPassword: "123456", RTPPtime: 20, MediaSecurity: "rtp",
	}
	a.localHost = "127.0.0.1"
	a.localPort = 5061

	if _, err := a.SendInvite("6000001", 40000); err != nil {
		t.Fatalf("SendInvite err=%v", err)
	}
	sent := waitSent(t, tr)
	if !strings.Contains(sent, "INVITE sips:6000001@avaya.com SIP/2.0") ||
		!strings.Contains(sent, "From: <sips:6000000@avaya.com>;") ||
		!strings.Contains(sent, "To: <sips:6000001@avaya.com>") ||
		!strings.Contains(sent, "Contact: <sips:6000000@127.0.0.1:5061;transport=TLS>") {
		t.Fatalf("INVITE did not use SIPS consistently:\n%s", sent)
	}
}
