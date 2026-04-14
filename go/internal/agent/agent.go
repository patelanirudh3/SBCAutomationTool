package agent

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/cci/traffic-engine/internal/config"
	"github.com/cci/traffic-engine/internal/sip"
)

// DialogState tracks a single SIP dialog for one call leg.
type DialogState struct {
	CallID      string
	LocalTag    string
	LocalExt    string
	RemoteExt   string
	Domain      string
	Transport   string
	LocalHost   string
	LocalPort   int
	RemoteTag   string
	CSeq        int
	RSeq        int
	RouteSet    []string
	RemoteTarget string
	State       string // IDLE, INVITE_SENT, PROVRESP_RCVD, ESTABLISHED, BYE_SENT, COMPLETE
	InviteSentMs  float64
	RingingRecvMs float64
	AckSentMs     float64
	ByeSentMs     float64
	IsReliable    bool
	InviteMsg     *sip.SipMessage
	ProvMsg       *sip.SipMessage
	RTPRemoteIP   string
	RTPRemotePort int
}

// WildcardEvent is delivered to wildcard listeners.
type WildcardEvent struct {
	EventCode string
	RawMsg    string
}

// ExtensionAgent manages one SIP extension.
type ExtensionAgent struct {
	Ext    string
	Config *config.VMConfig

	transport  sip.Transport
	localPort  int
	localHost  string

	Registered chan struct{}
	Subscribed chan struct{}
	registeredOnce sync.Once
	subscribedOnce sync.Once

	ActiveDialogs map[string]*DialogState
	ZombieDialogs map[string]*DialogState
	mu            sync.RWMutex

	handlers  map[string][]chan string
	wildcards []chan WildcardEvent
	handlerMu sync.Mutex

	closed atomic.Bool

	regCallID      string
	regFromTag     string
	regFromHeader  string
	regContactHdr  string
	regNonce       string
	regRealm       string
	regCSeq        int
}

// NewExtensionAgent creates a new agent for the given extension.
func NewExtensionAgent(ext string, cfg *config.VMConfig) *ExtensionAgent {
	return &ExtensionAgent{
		Ext:           ext,
		Config:        cfg,
		ActiveDialogs: make(map[string]*DialogState),
		ZombieDialogs: make(map[string]*DialogState),
		handlers:      make(map[string][]chan string),
		Registered:    make(chan struct{}),
		Subscribed:    make(chan struct{}),
	}
}

// Start creates the SIP transport, connects, and starts the dispatch goroutine.
func (a *ExtensionAgent) Start(ctx context.Context) error {
	if a.Config.LocalHost != "" {
		a.localHost = a.Config.LocalHost
	} else {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("%s:%d", a.Config.SBCHost, a.Config.SBCPort), 3*time.Second)
		if err != nil {
			a.localHost = "127.0.0.1"
		} else {
			a.localHost = conn.LocalAddr().(*net.TCPAddr).IP.String()
			conn.Close()
		}
	}

	t, err := sip.CreateTransport(a.Config.SIPTransport, a.localHost, a.Config.SBCHost, a.Config.SBCPort, a.Config.BuildResolver())
	if err != nil {
		return fmt.Errorf("ext=%s create transport: %w", a.Ext, err)
	}
	if err := t.Connect(ctx); err != nil {
		return fmt.Errorf("ext=%s connect: %w", a.Ext, err)
	}
	a.transport = t
	a.localPort = t.LocalPort()

	go a.dispatchLoop()
	slog.Debug("agent started", "ext", a.Ext, "port", a.localPort)
	return nil
}

// Close stops the dispatch loop and closes the transport.
func (a *ExtensionAgent) Close() error {
	a.closed.Store(true)
	if a.transport != nil {
		return a.transport.Close()
	}
	return nil
}

// LocalPort returns the local SIP port.
func (a *ExtensionAgent) LocalPort() int { return a.localPort }

// LocalHost returns the local host IP.
func (a *ExtensionAgent) LocalHost() string { return a.localHost }

// Send serializes a SIP message and sends it.
func (a *ExtensionAgent) Send(msg *sip.SipMessage, body string) error {
	raw := sip.BuildMessage(msg, body)
	return a.transport.Send(raw)
}

func (a *ExtensionAgent) syncLocalPort() {
	if a.transport != nil {
		tp := a.transport.LocalPort()
		if tp != 0 && tp != a.localPort {
			a.localPort = tp
		}
	}
}

// Register performs the full REGISTER flow: initial -> 401 -> auth -> 200.
func (a *ExtensionAgent) Register(ctx context.Context) error {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	fromTag := sip.CreateFromTag()

	msg := sip.BuildInitialRegister(a.Ext, a.Config.Domain, a.Config.SIPTransport, a.localHost, a.localPort, 3600)
	msg.ReplaceHeader(sip.HdrCallID, callID)
	fromHdr := fmt.Sprintf("<sip:%s@%s>;tag=%s", a.Ext, a.Config.Domain, fromTag)
	msg.ReplaceHeader(sip.HdrFrom, fromHdr)

	a.regCallID = callID
	a.regFromTag = fromTag
	a.regFromHeader = fromHdr
	a.regCSeq = 1

	ch401 := a.waitForEvent("401")
	ch200 := a.waitForEvent("200")
	defer a.deregisterCh(ch401, "401")
	defer a.deregisterCh(ch200, "200")

	if err := a.Send(msg, ""); err != nil {
		return err
	}

	tCtx, cancel := context.WithTimeout(ctx, time.Duration(a.Config.RegisterTimeout)*time.Second)
	defer cancel()

	select {
	case raw401 := <-ch401:
		challenge := sip.Parse401Challenge(raw401)
		a.regNonce = challenge.Nonce
		a.regRealm = challenge.Realm
		if a.regRealm == "" {
			a.regRealm = a.Config.Domain
		}

		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, "00000001", "auth")

		a.regCSeq = 2
		authMsg := sip.CloneSipMessage(msg)
		authMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
		authMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
		authMsg.RemoveHeader(sip.HdrAuthorization)
		authMsg.AddHeader(sip.HdrAuthorization, authHdr)

		if err := a.Send(authMsg, ""); err != nil {
			return err
		}

		select {
		case <-ch200:
			slog.Info("registered", "ext", a.Ext)
			a.registeredOnce.Do(func() { close(a.Registered) })
			return nil
		case <-tCtx.Done():
			return tCtx.Err()
		}

	case <-ch200:
		slog.Info("registered (no auth)", "ext", a.Ext)
		a.registeredOnce.Do(func() { close(a.Registered) })
		return nil

	case <-tCtx.Done():
		return tCtx.Err()
	}
}

// Unregister sends REGISTER with Expires:0.
func (a *ExtensionAgent) Unregister(ctx context.Context) error {
	a.syncLocalPort()
	a.regCSeq++

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("REGISTER sip:%s SIP/2.0", a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, a.regCallID)
	msg.AddHeader(sip.HdrFrom, a.regFromHeader)
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>", a.Ext, a.Config.Domain))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, "*")
	msg.AddHeader(sip.HdrExpires, "0")
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
	msg.AddHeader(sip.HdrContentLength, "0")

	if a.regNonce != "" {
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, "00000001", "auth")
		msg.AddHeader(sip.HdrAuthorization, authHdr)
	}

	ch200 := a.waitForEvent("200")
	ch401 := a.waitForEvent("401")
	defer a.deregisterCh(ch200, "200")
	defer a.deregisterCh(ch401, "401")

	if err := a.Send(msg, ""); err != nil {
		return err
	}

	tCtx, cancel := context.WithTimeout(ctx, time.Duration(a.Config.RegisterTimeout)*time.Second)
	defer cancel()

	select {
	case <-ch200:
		slog.Info("unregistered", "ext", a.Ext)
		return nil
	case raw401 := <-ch401:
		challenge := sip.Parse401Challenge(raw401)
		a.regNonce = challenge.Nonce
		if challenge.Realm != "" {
			a.regRealm = challenge.Realm
		}
		a.regCSeq++
		retryMsg := sip.CloneSipMessage(msg)
		retryMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
		retryMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, "00000001", "auth")
		retryMsg.RemoveHeader(sip.HdrAuthorization)
		retryMsg.AddHeader(sip.HdrAuthorization, authHdr)
		if err := a.Send(retryMsg, ""); err != nil {
			return err
		}
		ch200r := a.waitForEvent("200")
		defer a.deregisterCh(ch200r, "200")
		select {
		case <-ch200r:
			slog.Info("unregistered (after 401)", "ext", a.Ext)
			return nil
		case <-tCtx.Done():
			return tCtx.Err()
		}
	case <-tCtx.Done():
		return tCtx.Err()
	}
}

// FlushRegister sends REGISTER(Expires:0) to clear stale bindings.
func (a *ExtensionAgent) FlushRegister(ctx context.Context) error {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	fromTag := sip.CreateFromTag()

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("REGISTER sip:%s SIP/2.0", a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, callID)
	msg.AddHeader(sip.HdrFrom, fmt.Sprintf("<sip:%s@%s>;tag=%s", a.Ext, a.Config.Domain, fromTag))
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>", a.Ext, a.Config.Domain))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, "*")
	msg.AddHeader(sip.HdrExpires, "0")
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, "1 REGISTER")
	msg.AddHeader(sip.HdrContentLength, "0")

	doneCodes := []string{"200", "404", "403", "481"}
	chDone := a.waitForEvent(doneCodes...)
	ch401 := a.waitForEvent("401")
	defer a.deregisterCh(chDone, doneCodes...)
	defer a.deregisterCh(ch401, "401")

	if err := a.Send(msg, ""); err != nil {
		return nil // swallow
	}

	tCtx, cancel := context.WithTimeout(ctx, time.Duration(a.Config.RegisterTimeout)*time.Second)
	defer cancel()

	select {
	case <-chDone:
		return nil
	case raw401 := <-ch401:
		challenge := sip.Parse401Challenge(raw401)
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		realm := challenge.Realm
		if realm == "" {
			realm = a.Config.Domain
		}
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, uri, "REGISTER", cnonce, "00000001", "auth")
		authMsg := sip.CloneSipMessage(msg)
		authMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
		authMsg.ReplaceHeader(sip.HdrCSeq, "2 REGISTER")
		authMsg.AddHeader(sip.HdrAuthorization, authHdr)
		_ = a.Send(authMsg, "")
		chDone2 := a.waitForEvent(doneCodes...)
		defer a.deregisterCh(chDone2, doneCodes...)
		select {
		case <-chDone2:
		case <-tCtx.Done():
		}
		return nil
	case <-tCtx.Done():
		return nil
	}
}

// Subscribe performs the SUBSCRIBE flow handling both 407 (Proxy-Auth) and
// 401 (WWW-Auth) challenges. Avaya Session Manager issues 401 for SUBSCRIBE.
func (a *ExtensionAgent) Subscribe(ctx context.Context) error {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	fromTag := sip.CreateFromTag()
	cseq := 1

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("SUBSCRIBE sip:%s@%s SIP/2.0", a.Ext, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, callID)
	msg.AddHeader(sip.HdrFrom, fmt.Sprintf("<sip:%s@%s>;tag=%s", a.Ext, a.Config.Domain, fromTag))
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>", a.Ext, a.Config.Domain))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d;transport=%s>", a.Ext, a.localHost, a.localPort, a.Config.SIPTransport))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrExpires, "600")
	msg.AddHeader(sip.HdrEvent, "dialog")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", cseq))
	msg.AddHeader(sip.HdrContentLength, "0")
	msg.AddHeader(sip.HdrSupported, "100rel")

	ch407 := a.waitForEvent("407")
	ch401 := a.waitForEvent("401")
	ch200 := a.waitForEvent("200")
	ch202 := a.waitForEvent("202")
	defer a.deregisterCh(ch407, "407")
	defer a.deregisterCh(ch401, "401")
	defer a.deregisterCh(ch200, "200")
	defer a.deregisterCh(ch202, "202")

	if err := a.Send(msg, ""); err != nil {
		return err
	}

	tCtx, cancel := context.WithTimeout(ctx, time.Duration(a.Config.RegisterTimeout)*time.Second)
	defer cancel()

	// sendAuthRetry builds a re-SUBSCRIBE with the appropriate auth header.
	// use401=true → WWW-Authenticate challenge → Authorization header (SM/401)
	// use401=false → Proxy-Authenticate challenge → Proxy-Authorization header (SBC/407)
	sendAuthRetry := func(rawChallenge string, use401 bool) error {
		var realm, nonce string
		if use401 {
			ch := sip.Parse401Challenge(rawChallenge)
			realm, nonce = ch.Realm, ch.Nonce
		} else {
			ch := sip.Parse407Challenge(rawChallenge)
			realm, nonce = ch.Realm, ch.Nonce
		}
		if realm == "" {
			realm = a.Config.Domain
		}
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s@%s", a.Ext, a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, nonce, uri, "SUBSCRIBE", cnonce, "00000001", "auth")

		cseq++
		retryMsg := sip.CloneSipMessage(msg)
		retryMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
		retryMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", cseq))
		if use401 {
			retryMsg.AddHeader(sip.HdrAuthorization, authHdr)
		} else {
			retryMsg.AddHeader(sip.HdrProxyAuthorization, authHdr)
		}
		return a.Send(retryMsg, "")
	}

	select {
	case raw407 := <-ch407:
		if err := sendAuthRetry(raw407, false); err != nil {
			return err
		}
		select {
		case <-ch200:
		case <-ch202:
		case <-tCtx.Done():
			return tCtx.Err()
		}

	case raw401 := <-ch401:
		if err := sendAuthRetry(raw401, true); err != nil {
			return err
		}
		select {
		case <-ch200:
		case <-ch202:
		case <-tCtx.Done():
			return tCtx.Err()
		}

	case <-ch200:
	case <-ch202:
	case <-tCtx.Done():
		return tCtx.Err()
	}

	slog.Info("subscribed", "ext", a.Ext)
	a.subscribedOnce.Do(func() { close(a.Subscribed) })
	return nil
}

// SendInvite builds and sends an INVITE with SDP.
func (a *ExtensionAgent) SendInvite(calleeExt string, rtpPort int) (*DialogState, error) {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	localTag := sip.CreateFromTag()
	sdpBody := BuildSDP(a.localHost, rtpPort)

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("INVITE sip:%s@%s SIP/2.0", calleeExt, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, callID)
	msg.AddHeader(sip.HdrFrom, fmt.Sprintf("<sip:%s@%s>;tag=%s", a.Ext, a.Config.Domain, localTag))
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>", calleeExt, a.Config.Domain))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d;transport=%s>", a.Ext, a.localHost, a.localPort, a.Config.SIPTransport))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, "1 INVITE")
	msg.AddHeader(sip.HdrRequire, "100rel")
	msg.AddHeader(sip.HdrSupported, "100rel")
	msg.AddHeader(sip.HdrContentType, "application/sdp")
	msg.AddHeader(sip.HdrContentLength, fmt.Sprintf("%d", len(sdpBody)))

	dialog := &DialogState{
		CallID:       callID,
		LocalTag:     localTag,
		LocalExt:     a.Ext,
		RemoteExt:    calleeExt,
		Domain:       a.Config.Domain,
		Transport:    a.Config.SIPTransport,
		LocalHost:    a.localHost,
		LocalPort:    a.localPort,
		CSeq:         1,
		State:        "INVITE_SENT",
		InviteSentMs: float64(time.Now().UnixMilli()),
		InviteMsg:    msg,
		IsReliable:   true,
	}

	a.mu.Lock()
	a.ActiveDialogs[callID] = dialog
	a.mu.Unlock()

	if err := a.Send(msg, sdpBody); err != nil {
		return nil, err
	}
	return dialog, nil
}

// SendPrack sends a PRACK for a reliable provisional response.
func (a *ExtensionAgent) SendPrack(dialog *DialogState) error {
	if dialog.ProvMsg == nil {
		return fmt.Errorf("no provisional msg stored")
	}
	rackValue := fmt.Sprintf("%d %d INVITE", dialog.RSeq, dialog.CSeq)
	dialog.CSeq++

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("PRACK sip:%s@%s SIP/2.0", dialog.RemoteExt, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	toBase := fmt.Sprintf("<sip:%s@%s>", dialog.RemoteExt, a.Config.Domain)
	if dialog.RemoteTag != "" {
		msg.AddHeader(sip.HdrTo, toBase+";tag="+dialog.RemoteTag)
	} else {
		msg.AddHeader(sip.HdrTo, toBase)
	}
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d>", a.Ext, a.localHost, a.localPort))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d PRACK", dialog.CSeq))
	msg.AddHeader(sip.HdrRAck, rackValue)
	msg.AddHeader(sip.HdrContentLength, "0")

	return a.Send(msg, "")
}

// SendAck sends ACK after 200 OK.
func (a *ExtensionAgent) SendAck(dialog *DialogState) error {
	dialog.AckSentMs = float64(time.Now().UnixMilli())
	target := dialog.RemoteTarget
	if target == "" {
		target = fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	}

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("ACK %s SIP/2.0", target))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>;tag=%s", dialog.RemoteExt, dialog.Domain, dialog.RemoteTag))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d ACK", dialog.CSeq))
	for _, route := range dialog.RouteSet {
		msg.AddHeader(sip.HdrRoute, route)
	}
	msg.AddHeader(sip.HdrContentLength, "0")

	dialog.State = "ESTABLISHED"
	return a.Send(msg, "")
}

// SendAckForFailure sends ACK for a final failure response (4xx/5xx/6xx).
func (a *ExtensionAgent) SendAckForFailure(dialog *DialogState, rawResponse string) error {
	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("ACK sip:%s@%s SIP/2.0", dialog.RemoteExt, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}

	parts := strings.SplitN(rawResponse, "\r\n\r\n", 2)
	resp := sip.ParseHeaders(parts[0])
	if toHdrs := resp.GetHeader(sip.HdrTo); len(toHdrs) > 0 {
		msg.AddHeader(sip.HdrTo, toHdrs[0])
	}
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	if cseqHdrs := resp.GetHeader(sip.HdrCSeq); len(cseqHdrs) > 0 {
		msg.AddHeader(sip.HdrCSeq, cseqHdrs[0])
	}
	msg.AddHeader(sip.HdrContentLength, "0")

	return a.Send(msg, "")
}

// SendCancel sends CANCEL for a pending INVITE.
func (a *ExtensionAgent) SendCancel(dialog *DialogState) error {
	if dialog.InviteMsg == nil {
		return nil
	}
	origVia := ""
	if v := dialog.InviteMsg.GetHeader(sip.HdrVia); len(v) > 0 {
		origVia = v[0]
	} else {
		origVia = fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID())
	}

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("CANCEL sip:%s@%s SIP/2.0", dialog.RemoteExt, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
		msg.AddHeader(sip.HdrFrom, fh[0])
	}
	toBase := fmt.Sprintf("<sip:%s@%s>", dialog.RemoteExt, dialog.Domain)
	if dialog.RemoteTag != "" {
		msg.AddHeader(sip.HdrTo, toBase+";tag="+dialog.RemoteTag)
	} else {
		msg.AddHeader(sip.HdrTo, toBase)
	}
	msg.AddHeader(sip.HdrVia, origVia)
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d CANCEL", dialog.CSeq))
	msg.AddHeader(sip.HdrContentLength, "0")

	return a.Send(msg, "")
}

// SendBye sends BYE to terminate an established call.
func (a *ExtensionAgent) SendBye(dialog *DialogState) error {
	dialog.ByeSentMs = float64(time.Now().UnixMilli())
	dialog.State = "BYE_SENT"
	dialog.CSeq++

	target := dialog.RemoteTarget
	if target == "" {
		target = fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	}

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("BYE %s SIP/2.0", target))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>;tag=%s", dialog.RemoteExt, dialog.Domain, dialog.RemoteTag))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d BYE", dialog.CSeq))
	for _, route := range dialog.RouteSet {
		msg.AddHeader(sip.HdrRoute, route)
	}
	msg.AddHeader(sip.HdrContentLength, "0")

	return a.Send(msg, "")
}

// HandleIncomingInvite processes an inbound INVITE and sends 100+180.
func (a *ExtensionAgent) HandleIncomingInvite(rawMsg string) (*DialogState, error) {
	parts := strings.SplitN(rawMsg, "\r\n\r\n", 2)
	invite := sip.ParseHeaders(parts[0])
	callID := invite.GetCallID()
	remoteTag := invite.GetFromTag()
	localTag := sip.CreateFromTag()
	cseq := invite.GetCSeq()

	remoteExt := invite.GetReqURIUserPart()

	dialog := &DialogState{
		CallID:    callID,
		LocalTag:  localTag,
		LocalExt:  a.Ext,
		RemoteExt: remoteExt,
		Domain:    a.Config.Domain,
		Transport: a.Config.SIPTransport,
		LocalHost: a.localHost,
		LocalPort: a.localPort,
		RemoteTag: remoteTag,
		CSeq:      cseq,
		State:     "INVITE_RCVD",
		InviteMsg: invite,
		IsReliable: true,
	}

	a.mu.Lock()
	a.ActiveDialogs[callID] = dialog
	a.mu.Unlock()

	if len(parts) > 1 && strings.TrimSpace(parts[1]) != "" {
		ip, port := ParseSDPMedia(parts[1])
		if ip != "" && port > 0 {
			dialog.RTPRemoteIP = ip
			dialog.RTPRemotePort = port
		}
	}

	// 100 Trying
	a.sendProvisional(invite, "100", "Trying", localTag, false, 0)

	// 180 Ringing
	rseq := int(sip.GenRSeq())
	dialog.RSeq = rseq
	a.sendProvisional(invite, "180", "Ringing", localTag, true, rseq)
	dialog.State = "PROVRESP_SENT"

	return dialog, nil
}

func (a *ExtensionAgent) sendProvisional(invite *sip.SipMessage, code, reason, localTag string, includeContact bool, rseq int) {
	resp := sip.NewSipMessage()
	resp.SetResponseLine(fmt.Sprintf("SIP/2.0 %s %s", code, reason))
	if vias := invite.GetHeader(sip.HdrVia); len(vias) > 0 {
		for _, v := range vias {
			resp.AddHeader(sip.HdrVia, v)
		}
	}
	if fh := invite.GetHeader(sip.HdrFrom); len(fh) > 0 {
		resp.AddHeader(sip.HdrFrom, fh[0])
	}
	if th := invite.GetHeader(sip.HdrTo); len(th) > 0 {
		resp.AddHeader(sip.HdrTo, th[0]+";tag="+localTag)
	}
	resp.AddHeader(sip.HdrCallID, invite.GetCallID())
	if ch := invite.GetHeader(sip.HdrCSeq); len(ch) > 0 {
		resp.AddHeader(sip.HdrCSeq, ch[0])
	}
	if includeContact {
		resp.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d>", a.Ext, a.localHost, a.localPort))
	}
	if rseq > 0 {
		resp.AddHeader(sip.HdrRequire, "100rel")
		resp.AddHeader(sip.HdrRSeq, fmt.Sprintf("%d", rseq))
	}
	resp.AddHeader(sip.HdrContentLength, "0")
	_ = a.Send(resp, "")
}

// HandlePrack receives PRACK and sends 200 OK.
func (a *ExtensionAgent) HandlePrack(rawMsg string, dialog *DialogState) error {
	parts := strings.SplitN(rawMsg, "\r\n\r\n", 2)
	prack := sip.ParseHeaders(parts[0])

	resp := sip.NewSipMessage()
	resp.SetResponseLine("SIP/2.0 200 OK")
	if v := prack.GetHeader(sip.HdrVia); len(v) > 0 {
		for _, h := range v {
			resp.AddHeader(sip.HdrVia, h)
		}
	}
	if fh := prack.GetHeader(sip.HdrFrom); len(fh) > 0 {
		resp.AddHeader(sip.HdrFrom, fh[0])
	}
	if th := prack.GetHeader(sip.HdrTo); len(th) > 0 {
		resp.AddHeader(sip.HdrTo, th[0])
	}
	resp.AddHeader(sip.HdrCallID, dialog.CallID)
	if ch := prack.GetHeader(sip.HdrCSeq); len(ch) > 0 {
		resp.AddHeader(sip.HdrCSeq, ch[0])
	}
	resp.AddHeader(sip.HdrContentLength, "0")

	return a.Send(resp, "")
}

// HandleBye receives BYE and sends 200 OK.
func (a *ExtensionAgent) HandleBye(rawMsg string, dialog *DialogState) error {
	parts := strings.SplitN(rawMsg, "\r\n\r\n", 2)
	byeMsg := sip.ParseHeaders(parts[0])

	resp := sip.NewSipMessage()
	resp.SetResponseLine("SIP/2.0 200 OK")
	if v := byeMsg.GetHeader(sip.HdrVia); len(v) > 0 {
		for _, h := range v {
			resp.AddHeader(sip.HdrVia, h)
		}
	}
	if fh := byeMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
		resp.AddHeader(sip.HdrFrom, fh[0])
	}
	if th := byeMsg.GetHeader(sip.HdrTo); len(th) > 0 {
		resp.AddHeader(sip.HdrTo, th[0])
	}
	resp.AddHeader(sip.HdrCallID, dialog.CallID)
	if ch := byeMsg.GetHeader(sip.HdrCSeq); len(ch) > 0 {
		resp.AddHeader(sip.HdrCSeq, ch[0])
	}
	resp.AddHeader(sip.HdrContentLength, "0")

	if err := a.Send(resp, ""); err != nil {
		return err
	}
	dialog.State = "COMPLETE"
	a.mu.Lock()
	delete(a.ActiveDialogs, dialog.CallID)
	a.mu.Unlock()
	return nil
}

// Send200Invite sends 200 OK to an incoming INVITE.
func (a *ExtensionAgent) Send200Invite(dialog *DialogState, rtpPort int) error {
	invite := dialog.InviteMsg
	sdpBody := BuildSDP(a.localHost, rtpPort)

	resp := sip.NewSipMessage()
	resp.SetResponseLine("SIP/2.0 200 OK")
	if v := invite.GetHeader(sip.HdrVia); len(v) > 0 {
		for _, h := range v {
			resp.AddHeader(sip.HdrVia, h)
		}
	}
	if fh := invite.GetHeader(sip.HdrFrom); len(fh) > 0 {
		resp.AddHeader(sip.HdrFrom, fh[0])
	}
	if th := invite.GetHeader(sip.HdrTo); len(th) > 0 {
		resp.AddHeader(sip.HdrTo, th[0]+";tag="+dialog.LocalTag)
	}
	resp.AddHeader(sip.HdrCallID, dialog.CallID)
	if ch := invite.GetHeader(sip.HdrCSeq); len(ch) > 0 {
		resp.AddHeader(sip.HdrCSeq, ch[0])
	}
	resp.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d>", a.Ext, a.localHost, a.localPort))
	resp.AddHeader(sip.HdrContentType, "application/sdp")
	resp.AddHeader(sip.HdrContentLength, fmt.Sprintf("%d", len(sdpBody)))
	dialog.State = "SUCCESSFULRESP_SENT"

	return a.Send(resp, sdpBody)
}

// ParseProvResponse parses a 180/183 provisional response.
func (a *ExtensionAgent) ParseProvResponse(rawMsg string, dialog *DialogState) {
	parts := strings.SplitN(rawMsg, "\r\n\r\n", 2)
	prov := sip.ParseHeaders(parts[0])
	dialog.RemoteTag = prov.GetToTag()
	if dialog.RingingRecvMs == 0 {
		dialog.RingingRecvMs = float64(time.Now().UnixMilli())
	}
	dialog.RSeq = prov.GetRSeq()
	dialog.ProvMsg = prov
	dialog.State = "PROVRESP_RCVD"
}

// Parse200Invite parses 200 OK to INVITE.
func (a *ExtensionAgent) Parse200Invite(rawMsg string, dialog *DialogState) {
	parts := strings.SplitN(rawMsg, "\r\n\r\n", 2)
	resp := sip.ParseHeaders(parts[0])
	dialog.RemoteTag = resp.GetToTag()
	if contactHdrs := resp.GetHeader(sip.HdrContact); len(contactHdrs) > 0 {
		raw := contactHdrs[0]
		if idx := strings.Index(raw, "<"); idx >= 0 {
			if end := strings.Index(raw[idx:], ">"); end >= 0 {
				dialog.RemoteTarget = raw[idx+1 : idx+end]
			}
		}
	}
	dialog.RouteSet = resp.GetRecordRoutes(true)
	if len(dialog.RouteSet) > 0 {
		reversed := make([]string, len(dialog.RouteSet))
		for i, r := range dialog.RouteSet {
			reversed[len(dialog.RouteSet)-1-i] = r
		}
		dialog.RouteSet = reversed
	}
	dialog.State = "SUCCESSFULRESP_RCVD"

	if len(parts) > 1 && strings.TrimSpace(parts[1]) != "" {
		ip, port := ParseSDPMedia(parts[1])
		if ip != "" && port > 0 {
			dialog.RTPRemoteIP = ip
			dialog.RTPRemotePort = port
		}
	}
}

// WaitForEvent registers for specific SIP event codes and waits.
func (a *ExtensionAgent) WaitForEvent(ctx context.Context, eventCodes ...string) (string, error) {
	ch := a.waitForEvent(eventCodes...)
	defer a.deregisterCh(ch, eventCodes...)
	select {
	case raw := <-ch:
		return raw, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

// RegisterWildcardListener returns a channel receiving all events.
func (a *ExtensionAgent) RegisterWildcardListener() chan WildcardEvent {
	ch := make(chan WildcardEvent, 256)
	a.handlerMu.Lock()
	a.wildcards = append(a.wildcards, ch)
	a.handlerMu.Unlock()
	return ch
}

// DeregisterWildcardListener removes a wildcard listener.
func (a *ExtensionAgent) DeregisterWildcardListener(ch chan WildcardEvent) {
	a.handlerMu.Lock()
	defer a.handlerMu.Unlock()
	for i, c := range a.wildcards {
		if c == ch {
			a.wildcards = append(a.wildcards[:i], a.wildcards[i+1:]...)
			break
		}
	}
}

// Handle407Invite re-sends INVITE with Proxy-Authorization after 407.
func (a *ExtensionAgent) Handle407Invite(dialog *DialogState, raw407 string) error {
	challenge := sip.Parse407Challenge(raw407)
	realm := challenge.Realm
	if realm == "" {
		realm = a.Config.Domain
	}
	cnonce := sip.GenCNonce()
	uri := fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, uri, "INVITE", cnonce, "00000001", "auth")

	if dialog.InviteMsg != nil {
		dialog.CSeq++
		dialog.InviteMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d INVITE", dialog.CSeq))
		dialog.InviteMsg.RemoveHeader(sip.HdrProxyAuthorization)
		dialog.InviteMsg.AddHeader(sip.HdrProxyAuthorization, authHdr)
		dialog.InviteMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", a.Config.SIPTransport, a.localHost, sip.CreateBranchID()))

		sdpBody := BuildSDP(a.localHost, 9) // default port
		return a.Send(dialog.InviteMsg, sdpBody)
	}
	return nil
}

// Internal helpers

func (a *ExtensionAgent) waitForEvent(codes ...string) chan string {
	ch := make(chan string, 1)
	a.handlerMu.Lock()
	for _, code := range codes {
		a.handlers[code] = append(a.handlers[code], ch)
	}
	a.handlerMu.Unlock()
	return ch
}

func (a *ExtensionAgent) deregisterCh(ch chan string, codes ...string) {
	a.handlerMu.Lock()
	defer a.handlerMu.Unlock()
	for _, code := range codes {
		listeners := a.handlers[code]
		for i, c := range listeners {
			if c == ch {
				a.handlers[code] = append(listeners[:i], listeners[i+1:]...)
				break
			}
		}
	}
}

func (a *ExtensionAgent) dispatchLoop() {
	recvCh := a.transport.RecvChan()
	for !a.closed.Load() {
		select {
		case raw, ok := <-recvCh:
			if !ok {
				return
			}
			eventCode, _ := sip.ClassifyMessage(raw)

			a.handlerMu.Lock()
			queues := make([]chan string, len(a.handlers[eventCode]))
			copy(queues, a.handlers[eventCode])
			wcs := make([]chan WildcardEvent, len(a.wildcards))
			copy(wcs, a.wildcards)
			a.handlerMu.Unlock()

			for _, q := range queues {
				select {
				case q <- raw:
				default:
				}
			}
			for _, wc := range wcs {
				select {
				case wc <- WildcardEvent{EventCode: eventCode, RawMsg: raw}:
				default:
				}
			}

			if eventCode == "NOTIFY" {
				go a.respond200ToNotify(raw)
			}

			if eventCode == "BYE" || eventCode == "CANCEL" {
				cid := extractCallID(raw)
				if cid != "" {
					a.mu.RLock()
					_, inActive := a.ActiveDialogs[cid]
					_, inZombie := a.ZombieDialogs[cid]
					a.mu.RUnlock()
					if !inActive {
						if inZombie {
							go a.respond200ToRequest(raw)
						} else if hasToTag(raw) {
							go a.respond481ToRequest(raw)
						}
					}
				}
			}
		case <-time.After(time.Second):
			continue
		}
	}
}

func (a *ExtensionAgent) respond200ToNotify(raw string) {
	parts := strings.SplitN(raw, "\r\n\r\n", 2)
	notify := sip.ParseHeaders(parts[0])
	resp := sip.NewSipMessage()
	resp.SetResponseLine("SIP/2.0 200 OK")
	for _, hdr := range []string{sip.HdrVia, sip.HdrFrom, sip.HdrTo, sip.HdrCallID, sip.HdrCSeq} {
		if vals := notify.GetHeader(hdr); len(vals) > 0 {
			for _, v := range vals {
				resp.AddHeader(hdr, v)
			}
		}
	}
	resp.AddHeader(sip.HdrContentLength, "0")
	_ = a.Send(resp, "")
}

func (a *ExtensionAgent) respond200ToRequest(raw string) {
	parts := strings.SplitN(raw, "\r\n\r\n", 2)
	req := sip.ParseHeaders(parts[0])
	resp := sip.NewSipMessage()
	resp.SetResponseLine("SIP/2.0 200 OK")
	for _, hdr := range []string{sip.HdrVia, sip.HdrFrom, sip.HdrTo, sip.HdrCallID, sip.HdrCSeq} {
		if vals := req.GetHeader(hdr); len(vals) > 0 {
			for _, v := range vals {
				resp.AddHeader(hdr, v)
			}
		}
	}
	resp.AddHeader(sip.HdrContentLength, "0")
	_ = a.Send(resp, "")
}

func (a *ExtensionAgent) respond481ToRequest(raw string) {
	parts := strings.SplitN(raw, "\r\n\r\n", 2)
	req := sip.ParseHeaders(parts[0])
	resp := sip.NewSipMessage()
	resp.SetResponseLine("SIP/2.0 481 Call/Transaction Does Not Exist")
	for _, hdr := range []string{sip.HdrVia, sip.HdrFrom, sip.HdrTo, sip.HdrCallID, sip.HdrCSeq} {
		if vals := req.GetHeader(hdr); len(vals) > 0 {
			for _, v := range vals {
				resp.AddHeader(hdr, v)
			}
		}
	}
	resp.AddHeader(sip.HdrContentLength, "0")
	_ = a.Send(resp, "")
}

func extractCallID(raw string) string {
	for _, line := range strings.Split(raw, "\r\n") {
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "call-id:") || strings.HasPrefix(lower, "i:") {
			return strings.TrimSpace(strings.SplitN(line, ":", 2)[1])
		}
	}
	return ""
}

func hasToTag(raw string) bool {
	for _, line := range strings.Split(raw, "\r\n") {
		lower := strings.ToLower(line)
		if strings.HasPrefix(lower, "to:") || strings.HasPrefix(lower, "t:") {
			return strings.Contains(lower, "tag=")
		}
	}
	return false
}

// RemoveDialog removes a dialog from the active set by call ID.
func (a *ExtensionAgent) RemoveDialog(callID string) {
	a.mu.Lock()
	delete(a.ActiveDialogs, callID)
	a.mu.Unlock()
}

// RegisterZombie moves a dialog to the zombie set for the given TTL.
// After TTL the zombie is automatically cleaned up.
func (a *ExtensionAgent) RegisterZombie(dialog *DialogState, ttl time.Duration) {
	a.mu.Lock()
	a.ZombieDialogs[dialog.CallID] = dialog
	a.mu.Unlock()
	go func() {
		time.Sleep(ttl)
		a.mu.Lock()
		delete(a.ZombieDialogs, dialog.CallID)
		a.mu.Unlock()
	}()
}

// WaitForSIPEvent waits for one of the specified SIP event codes with a separate
// timeout (independent of the parent context).
func (a *ExtensionAgent) WaitForSIPEvent(ctx context.Context, timeout time.Duration, codes ...string) (string, error) {
	ch := a.waitForEvent(codes...)
	defer a.deregisterCh(ch, codes...)
	tCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	select {
	case raw := <-ch:
		return raw, nil
	case <-tCtx.Done():
		return "", tCtx.Err()
	}
}

// WaitWildcard waits for the next event on a wildcard listener channel with a timeout.
// Returns the event code, raw SIP message, and any error.
func (a *ExtensionAgent) WaitWildcard(ctx context.Context, wq chan WildcardEvent, timeout time.Duration) (string, string, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case ev := <-wq:
		return ev.EventCode, ev.RawMsg, nil
	case <-timer.C:
		return "", "", context.DeadlineExceeded
	case <-ctx.Done():
		return "", "", ctx.Err()
	}
}

// ActiveDialogsSnapshot returns a snapshot copy of all active dialog states.
func (a *ExtensionAgent) ActiveDialogsSnapshot() []*DialogState {
	a.mu.RLock()
	defer a.mu.RUnlock()
	out := make([]*DialogState, 0, len(a.ActiveDialogs))
	for _, d := range a.ActiveDialogs {
		out = append(out, d)
	}
	return out
}
