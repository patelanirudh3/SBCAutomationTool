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
	// InviteCSeq is the CSeq sequence number of the (last) INVITE that
	// established this dialog. It is set when the INVITE is sent (or when
	// re-sent under 407 challenge in Handle407Invite) and is used by
	// SendAck so the ACK CSeq matches the INVITE per RFC 3261 §13.2.2.4.
	// Without this field SendAck would use dialog.CSeq, which has been
	// incremented by intervening PRACK/BYE traffic.
	InviteCSeq  int
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
	// InviteSDP is the SDP body sent with the original INVITE; needed so
	// Timer A retransmissions (RFC 3261 §17.1.1.2, UDP only) can re-send
	// the exact same payload without rebuilding it.
	InviteSDP     string
	ProvMsg       *sip.SipMessage
	RTPRemoteIP   string
	RTPRemotePort int

	// [FIX-2] Proactive Auth: after the first INVITE 407 challenge is handled,
	// these fields store the digest credentials so that every subsequent
	// in-dialog request (PRACK, ACK, BYE) includes Proxy-Authorization
	// proactively, eliminating the need for a separate 407 round-trip.
	// Revert FIX-2: remove these four fields, buildProxyAuth helper, and
	// the proactive-auth blocks in SendPrack, SendAck, SendBye.
	ProxyAuthEnabled bool
	AuthNonce        string
	AuthRealm        string
	AuthOpaque       string
	// AuthNonceCount is the per-nonce request counter ("nc") required by
	// RFC 2617 §3.3. It is reset to 0 whenever AuthNonce is replaced and
	// incremented before each Proxy-Authorization is built so the wire
	// values are 00000001, 00000002, ... for the same nonce.
	AuthNonceCount int
}

// NextNCHex returns the next nonce-count value formatted as the 8-hex-digit
// string required by RFC 2617 §3.2.2 ("nc-value = 8LHEX"). Each call
// increments the in-memory counter; callers MUST use the return value in
// exactly the request being built (no peeking, no caching). Reset by
// assigning AuthNonce/AuthNonceCount when a fresh challenge arrives.
func (d *DialogState) NextNCHex() string {
	d.AuthNonceCount++
	return fmt.Sprintf("%08x", d.AuthNonceCount)
}

// WildcardEvent is delivered to wildcard listeners.
type WildcardEvent struct {
	EventCode string
	RawMsg    string
}

// earlyResponse holds a SIP message that arrived before any handler was
// registered for its event code.  The dispatch loop buffers these so that a
// subsequent WaitForSIPEvent can retrieve them without a timing race.
type earlyResponse struct {
	code string
	raw  string
}

// maxEarlyResponses caps the buffer.  Each agent handles one call at a time,
// so in practice the buffer holds 0-1 entries.  16 is generous headroom.
const maxEarlyResponses = 16

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

	handlers       map[string][]chan string
	wildcards      []chan WildcardEvent
	earlyResponses []earlyResponse
	handlerMu      sync.Mutex

	closed atomic.Bool

	// autoAnswerEnabled controls whether this agent's uasLoop will answer
	// incoming INVITEs. All agents start with auto-answer enabled.
	// Disabled atomically by PoolEngine.NextPair() when the agent is selected
	// as a caller, re-enabled after the call completes (BYE/200).
	autoAnswerEnabled atomic.Bool

	regCallID      string
	regFromTag     string
	regFromHeader  string
	regContactHdr  string
	regNonce       string
	regRealm       string
	regOpaque      string // [FIX-4] echo opaque from 401 challenge
	regCSeq        int
	regGrantedExp  int // server-granted Expires from REGISTER 200 OK
	// regNonceCount tracks the RFC 2617 §3.3 nonce-count for the active
	// REGISTER nonce. Reset to 0 whenever regNonce is replaced; the
	// helpers nextRegNC / resetRegNonce ensure increment-and-use semantics.
	regNonceCount int

	subCallID     string
	subFromHeader string
	subToHeader   string
	subContact    string
	subNonce      string
	subRealm      string
	subOpaque     string
	subCSeq       int
	// subNonceCount tracks the RFC 2617 §3.3 nonce-count for SUBSCRIBE.
	subNonceCount int
}

// nextRegNC returns the next nonce-count for REGISTER digest auth as the
// 8-hex-digit string required by RFC 2617 §3.2.2. Caller MUST use the
// returned value in the request being built immediately.
func (a *ExtensionAgent) nextRegNC() string {
	a.regNonceCount++
	return fmt.Sprintf("%08x", a.regNonceCount)
}

// resetRegNonce stores a fresh REGISTER nonce/realm/opaque from a 401
// challenge and zeroes the nonce-count so the next nextRegNC() returns 1.
func (a *ExtensionAgent) resetRegNonce(nonce, realm, opaque string) {
	a.regNonce = nonce
	if realm != "" {
		a.regRealm = realm
	}
	a.regOpaque = opaque
	a.regNonceCount = 0
}

// nextSubNC returns the next nonce-count for SUBSCRIBE digest auth.
func (a *ExtensionAgent) nextSubNC() string {
	a.subNonceCount++
	return fmt.Sprintf("%08x", a.subNonceCount)
}

// resetSubNonce stores a fresh SUBSCRIBE nonce and zeroes the nc counter.
func (a *ExtensionAgent) resetSubNonce(nonce, realm, opaque string) {
	a.subNonce = nonce
	if realm != "" {
		a.subRealm = realm
	}
	a.subOpaque = opaque
	a.subNonceCount = 0
}

// NewExtensionAgent creates a new agent for the given extension.
// Auto-answer starts enabled — all agents can act as callees by default.
func NewExtensionAgent(ext string, cfg *config.VMConfig) *ExtensionAgent {
	a := &ExtensionAgent{
		Ext:           ext,
		Config:        cfg,
		ActiveDialogs: make(map[string]*DialogState),
		ZombieDialogs: make(map[string]*DialogState),
		handlers:      make(map[string][]chan string),
		Registered:    make(chan struct{}),
		Subscribed:    make(chan struct{}),
	}
	a.autoAnswerEnabled.Store(true)
	return a
}

// SetAutoAnswer enables or disables automatic INVITE answering for this agent.
// Set to false atomically (inside PoolEngine.NextPair lock) when the agent is
// selected as a caller; set back to true after BYE/200 completes.
func (a *ExtensionAgent) SetAutoAnswer(enabled bool) {
	a.autoAnswerEnabled.Store(enabled)
}

// AutoAnswerEnabled reports whether this agent will automatically answer
// incoming INVITEs. Checked by uasLoop before spawning handleCall.
func (a *ExtensionAgent) AutoAnswerEnabled() bool {
	return a.autoAnswerEnabled.Load()
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

	tlsCfg, err := config.BuildTLSConfig(a.Config)
	if err != nil {
		return fmt.Errorf("ext=%s build tls: %w", a.Ext, err)
	}

	t, err := sip.CreateTransportWithTLS(a.Config.SIPTransport, a.localHost, a.Config.SBCHost, a.Config.SBCPort, a.Config.BuildResolver(), tlsCfg)
	if err != nil {
		return fmt.Errorf("ext=%s create transport: %w", a.Ext, err)
	}
	if err := t.Connect(ctx); err != nil {
		return fmt.Errorf("ext=%s connect: %w", a.Ext, err)
	}
	a.transport = t
	a.localPort = t.LocalPort()

	go a.dispatchLoop()
	slog.Debug("agent started",
		"ext", a.Ext,
		"port", a.localPort,
		"transport", a.Config.SIPTransport,
		"tls_mode", a.Config.TLSMode,
	)
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
//
// Both response waits use WaitForSIPEvent so that any 200 OK that arrived
// between attempts (buffered in earlyResponses) is consumed immediately
// instead of being silently dropped when no handler was registered.
func (a *ExtensionAgent) Register(ctx context.Context) error {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	fromTag := sip.CreateFromTag()

	msg := sip.BuildInitialRegister(a.Ext, a.Config.Domain, a.Config.SIPTransport, a.localHost, a.localPort, a.Config.RegisterExpires)
	msg.ReplaceHeader(sip.HdrCallID, callID)
	fromHdr := fmt.Sprintf("<sip:%s@%s>;tag=%s", a.Ext, a.Config.Domain, fromTag)
	msg.ReplaceHeader(sip.HdrFrom, fromHdr)

	a.regCallID = callID
	a.regFromTag = fromTag
	a.regFromHeader = fromHdr
	a.regCSeq = 1

	timeout := time.Duration(a.Config.RegisterTimeout) * time.Second

	if err := a.Send(msg, ""); err != nil {
		return err
	}

	// Wait for either 401 (challenge) or 200 (no-auth path).
	// WaitForSIPEvent scans earlyResponses first, so a 200 that arrived
	// while no handler was registered (e.g. late response from a previous
	// attempt) is picked up immediately.
	raw, err := a.WaitForSIPEvent(ctx, timeout, "401", "200")
	if err != nil {
		return err
	}

	eventCode, _ := sip.ClassifyMessage(raw)
	if eventCode == "200" {
		parsed := sip.ParseHeaders(strings.SplitN(raw, "\r\n\r\n", 2)[0])
		a.regGrantedExp = parsed.GetGrantedExpiry()
		slog.Info("registered (no auth)", "ext", a.Ext, "granted_exp", a.regGrantedExp)
		a.registeredOnce.Do(func() { close(a.Registered) })
		return nil
	}

	// eventCode == "401": build and send authenticated REGISTER.
	challenge := sip.Parse401Challenge(raw)
	a.resetRegNonce(challenge.Nonce, challenge.Realm, challenge.Opaque) // [FIX-4]
	if a.regRealm == "" {
		a.regRealm = a.Config.Domain
	}

	cnonce := sip.GenCNonce()
	uri := fmt.Sprintf("sip:%s", a.Config.Domain)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, a.nextRegNC(), "auth", a.regOpaque)

	a.regCSeq = 2
	authMsg := sip.CloneSipMessage(msg)
	authMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	authMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
	authMsg.RemoveHeader(sip.HdrAuthorization)
	authMsg.AddHeader(sip.HdrAuthorization, authHdr)

	if err := a.Send(authMsg, ""); err != nil {
		return err
	}

	// Wait for the final 200 OK after sending the authenticated REGISTER.
	// Again uses WaitForSIPEvent to catch any already-buffered 200.
	raw200, err := a.WaitForSIPEvent(ctx, timeout, "200")
	if err != nil {
		return err
	}
	parsed := sip.ParseHeaders(strings.SplitN(raw200, "\r\n\r\n", 2)[0])
	a.regGrantedExp = parsed.GetGrantedExpiry()
	slog.Info("registered", "ext", a.Ext, "granted_exp", a.regGrantedExp)
	a.registeredOnce.Do(func() { close(a.Registered) })
	return nil
}

// GrantedRegisterExpiry returns the server-granted Expires value from the last
// successful REGISTER 200 OK, or 0 if not yet registered.
func (a *ExtensionAgent) GrantedRegisterExpiry() int { return a.regGrantedExp }

// Reregister sends a REGISTER refresh using the same Call-ID and From tag as
// the original registration (in-dialog re-REGISTER per RFC 3261 §10.2.2).
// It reuses cached credentials so no new 401 round-trip is needed when the
// nonce is still valid, and falls back to a fresh 401 challenge if required.
func (a *ExtensionAgent) Reregister(ctx context.Context) error {
	a.syncLocalPort()
	if a.regCallID == "" {
		return fmt.Errorf("ext=%s: no registration state; Register must be called first", a.Ext)
	}

	a.regCSeq++
	expiresVal := fmt.Sprintf("%d", a.Config.RegisterExpires)

	msg := sip.BuildInitialRegister(a.Ext, a.Config.Domain, a.Config.SIPTransport, a.localHost, a.localPort, a.Config.RegisterExpires)
	msg.ReplaceHeader(sip.HdrCallID, a.regCallID)
	msg.ReplaceHeader(sip.HdrFrom, a.regFromHeader)
	msg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
	msg.ReplaceHeader(sip.HdrExpires, expiresVal)

	// Include cached credentials proactively to avoid an extra 401 round-trip.
	if a.regNonce != "" {
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, a.nextRegNC(), "auth", a.regOpaque)
		msg.AddHeader(sip.HdrAuthorization, authHdr)
	}

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
		a.resetRegNonce(challenge.Nonce, challenge.Realm, challenge.Opaque)
		a.regCSeq++
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, a.nextRegNC(), "auth", a.regOpaque)
		retryMsg := sip.CloneSipMessage(msg)
		retryMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
		retryMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
		retryMsg.RemoveHeader(sip.HdrAuthorization)
		retryMsg.AddHeader(sip.HdrAuthorization, authHdr)
		if err := a.Send(retryMsg, ""); err != nil {
			return err
		}
		ch200r := a.waitForEvent("200")
		defer a.deregisterCh(ch200r, "200")
		select {
		case raw200 := <-ch200r:
			parsed := sip.ParseHeaders(strings.SplitN(raw200, "\r\n\r\n", 2)[0])
			a.regGrantedExp = parsed.GetGrantedExpiry()
			slog.Debug("reregistered (after 401)", "ext", a.Ext, "granted_exp", a.regGrantedExp)
			return nil
		case <-tCtx.Done():
			return tCtx.Err()
		}
	case raw200 := <-ch200:
		parsed := sip.ParseHeaders(strings.SplitN(raw200, "\r\n\r\n", 2)[0])
		a.regGrantedExp = parsed.GetGrantedExpiry()
		slog.Debug("reregistered", "ext", a.Ext, "granted_exp", a.regGrantedExp)
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
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, "*")
	msg.AddHeader(sip.HdrExpires, "0")
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
	msg.AddHeader(sip.HdrContentLength, "0")

	if a.regNonce != "" {
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, a.nextRegNC(), "auth", a.regOpaque)
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
		a.resetRegNonce(challenge.Nonce, challenge.Realm, challenge.Opaque) // [FIX-4]
		a.regCSeq++
		retryMsg := sip.CloneSipMessage(msg)
		retryMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
		retryMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s", a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.regRealm, a.regNonce, uri, "REGISTER", cnonce, a.nextRegNC(), "auth", a.regOpaque)
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
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
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
		// FlushRegister is fire-and-forget cleanup with a fresh local
		// Call-ID/From-tag, NOT tied to the agent's active registration
		// nonce sequence. nc=00000001 is correct here because this is the
		// first (and only) request using this challenge nonce.
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, uri, "REGISTER", cnonce, "00000001", "auth", challenge.Opaque)
		authMsg := sip.CloneSipMessage(msg)
		authMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
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
// On success it saves dialog state so Resubscribe can issue in-dialog refreshes.
func (a *ExtensionAgent) Subscribe(ctx context.Context) error {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	fromTag := sip.CreateFromTag()
	cseq := 1

	fromHdr := fmt.Sprintf("<sip:%s@%s>;tag=%s", a.Ext, a.Config.Domain, fromTag)
	toHdr := fmt.Sprintf("<sip:%s@%s>", a.Ext, a.Config.Domain)
	contactHdr := fmt.Sprintf("<sip:%s@%s:%d;transport=%s>", a.Ext, a.localHost, a.localPort, a.Config.SIPTransport)
	expiresVal := fmt.Sprintf("%d", a.Config.SubscribeExpires)

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("SUBSCRIBE sip:%s@%s SIP/2.0", a.Ext, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, callID)
	msg.AddHeader(sip.HdrFrom, fromHdr)
	msg.AddHeader(sip.HdrTo, toHdr)
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, contactHdr)
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrExpires, expiresVal)
	msg.AddHeader(sip.HdrEvent, "dialog")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", cseq))
	msg.AddHeader(sip.HdrContentLength, "0")
	msg.AddHeader(sip.HdrSupported, "100rel")
	// RFC 3265 §3.1.1: SUBSCRIBE SHOULD include Accept listing acceptable
	// NOTIFY body content types. For the "dialog" event package the
	// expected body type is application/dialog-info+xml (RFC 4235).
	msg.AddHeader("Accept", "application/dialog-info+xml")

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
		var realm, nonce, opaque string
		if use401 {
			ch := sip.Parse401Challenge(rawChallenge)
			realm, nonce, opaque = ch.Realm, ch.Nonce, ch.Opaque
		} else {
			ch := sip.Parse407Challenge(rawChallenge)
			realm, nonce, opaque = ch.Realm, ch.Nonce, ch.Opaque
		}
		if realm == "" {
			realm = a.Config.Domain
		}
		a.resetSubNonce(nonce, realm, opaque)

		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s@%s", a.Ext, a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, nonce, uri, "SUBSCRIBE", cnonce, a.nextSubNC(), "auth", opaque)

		cseq++
		retryMsg := sip.CloneSipMessage(msg)
		retryMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
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

	// Save dialog state for in-dialog refresh via Resubscribe.
	a.subCallID = callID
	a.subFromHeader = fromHdr
	a.subToHeader = toHdr
	a.subContact = contactHdr
	a.subCSeq = cseq

	slog.Info("subscribed", "ext", a.Ext)
	a.subscribedOnce.Do(func() { close(a.Subscribed) })
	return nil
}

// Resubscribe sends an in-dialog SUBSCRIBE refresh using the state saved from
// the initial Subscribe call. It reuses the same Call-ID and From tag (keeping
// the subscription dialog alive) and increments CSeq. A fresh auth challenge
// is handled if the server issues a new 401/407.
func (a *ExtensionAgent) Resubscribe(ctx context.Context) error {
	a.syncLocalPort()
	if a.subCallID == "" {
		return fmt.Errorf("ext=%s: no subscription state; Subscribe must be called first", a.Ext)
	}

	a.subCSeq++
	expiresVal := fmt.Sprintf("%d", a.Config.SubscribeExpires)

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("SUBSCRIBE sip:%s@%s SIP/2.0", a.Ext, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, a.subCallID)
	msg.AddHeader(sip.HdrFrom, a.subFromHeader)
	msg.AddHeader(sip.HdrTo, a.subToHeader)
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, a.subContact)
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrExpires, expiresVal)
	msg.AddHeader(sip.HdrEvent, "dialog")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", a.subCSeq))
	msg.AddHeader(sip.HdrContentLength, "0")
	// RFC 3265 §3.1.1: SUBSCRIBE SHOULD include Accept on every refresh.
	msg.AddHeader("Accept", "application/dialog-info+xml")

	// Include cached credentials proactively if we have them.
	if a.subNonce != "" {
		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s@%s", a.Ext, a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, a.subRealm, a.subNonce, uri, "SUBSCRIBE", cnonce, a.nextSubNC(), "auth", a.subOpaque)
		msg.AddHeader(sip.HdrAuthorization, authHdr)
	}

	ch401 := a.waitForEvent("401")
	ch407 := a.waitForEvent("407")
	ch200 := a.waitForEvent("200")
	ch202 := a.waitForEvent("202")
	defer a.deregisterCh(ch401, "401")
	defer a.deregisterCh(ch407, "407")
	defer a.deregisterCh(ch200, "200")
	defer a.deregisterCh(ch202, "202")

	if err := a.Send(msg, ""); err != nil {
		return err
	}

	tCtx, cancel := context.WithTimeout(ctx, time.Duration(a.Config.RegisterTimeout)*time.Second)
	defer cancel()

	sendAuthRetry := func(rawChallenge string, use401 bool) error {
		var realm, nonce, opaque string
		if use401 {
			ch := sip.Parse401Challenge(rawChallenge)
			realm, nonce, opaque = ch.Realm, ch.Nonce, ch.Opaque
		} else {
			ch := sip.Parse407Challenge(rawChallenge)
			realm, nonce, opaque = ch.Realm, ch.Nonce, ch.Opaque
		}
		if realm == "" {
			realm = a.Config.Domain
		}
		a.resetSubNonce(nonce, realm, opaque)

		cnonce := sip.GenCNonce()
		uri := fmt.Sprintf("sip:%s@%s", a.Ext, a.Config.Domain)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, nonce, uri, "SUBSCRIBE", cnonce, a.nextSubNC(), "auth", opaque)

		a.subCSeq++
		retryMsg := sip.CloneSipMessage(msg)
		retryMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
		retryMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", a.subCSeq))
		retryMsg.RemoveHeader(sip.HdrAuthorization)
		retryMsg.RemoveHeader(sip.HdrProxyAuthorization)
		if use401 {
			retryMsg.AddHeader(sip.HdrAuthorization, authHdr)
		} else {
			retryMsg.AddHeader(sip.HdrProxyAuthorization, authHdr)
		}
		return a.Send(retryMsg, "")
	}

	select {
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
	case <-ch200:
	case <-ch202:
	case <-tCtx.Done():
		return tCtx.Err()
	}

	slog.Debug("resubscribed", "ext", a.Ext, "expires", a.Config.SubscribeExpires)
	return nil
}

// SendInvite builds and sends an INVITE with SDP.
func (a *ExtensionAgent) SendInvite(calleeExt string, rtpPort int) (*DialogState, error) {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	localTag := sip.CreateFromTag()
	sdpBody := BuildSDP(a.localHost, rtpPort, a.Config.IsRTCPMuxEnabled())

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("INVITE sip:%s@%s SIP/2.0", calleeExt, a.Config.Domain))
	msg.AddHeader(sip.HdrCallID, callID)
	msg.AddHeader(sip.HdrFrom, fmt.Sprintf("<sip:%s@%s>;tag=%s", a.Ext, a.Config.Domain, localTag))
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>", calleeExt, a.Config.Domain))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d;transport=%s>", a.Ext, a.localHost, a.localPort, a.Config.SIPTransport))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, "1 INVITE")
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
		InviteCSeq:   1,
		State:        "INVITE_SENT",
		InviteSentMs: float64(time.Now().UnixMilli()),
		InviteMsg:    msg,
		InviteSDP:    sdpBody,
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

// RetransmitInvite resends the original INVITE byte-for-byte. Used by Timer A
// (RFC 3261 §17.1.1.2) on UDP transports when no provisional/final response
// has arrived within the current retransmit interval. Returns an error if the
// dialog has no stored INVITE message (defensive — should never happen).
func (a *ExtensionAgent) RetransmitInvite(dialog *DialogState) error {
	if dialog == nil || dialog.InviteMsg == nil {
		return fmt.Errorf("retransmit_invite: no stored INVITE message")
	}
	return a.Send(dialog.InviteMsg, dialog.InviteSDP)
}

// [FIX-2] buildProxyAuth computes a Proxy-Authorization header for proactive
// in-dialog auth, reusing the nonce/realm stored from the initial 407 challenge.
// Returns "" when the dialog has no stored credentials (e.g. Kamailio path).
//
// Per RFC 2617 §3.3 the nonce-count must increment on every reuse of the
// same nonce, so we route through dialog.NextNCHex() rather than a literal.
func (a *ExtensionAgent) buildProxyAuth(dialog *DialogState, method, uri string) string {
	if !dialog.ProxyAuthEnabled {
		return ""
	}
	cnonce := sip.GenCNonce()
	return sip.CalcDigestResponse(
		a.Ext, a.Config.SIPPassword,
		dialog.AuthRealm, dialog.AuthNonce,
		uri, method, cnonce, dialog.NextNCHex(), "auth",
		dialog.AuthOpaque,
	)
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
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d>", a.Ext, a.localHost, a.localPort))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d PRACK", dialog.CSeq))
	msg.AddHeader(sip.HdrRAck, rackValue)
	// [FIX-2] Proactive auth on PRACK — digest uri matches the PRACK Request-URI
	if authHdr := a.buildProxyAuth(dialog, "PRACK", fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)); authHdr != "" {
		msg.AddHeader(sip.HdrProxyAuthorization, authHdr)
	}
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
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	// RFC 3261 §13.2.2.4: the ACK CSeq sequence number MUST equal the
	// INVITE's CSeq sequence number (only the method differs). dialog.CSeq
	// has been incremented by intervening PRACK; the authoritative INVITE
	// CSeq is held in dialog.InviteCSeq.
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d ACK", dialog.InviteCSeq))
	for _, route := range dialog.RouteSet {
		msg.AddHeader(sip.HdrRoute, route)
	}
	// [FIX-2] Proactive auth on ACK — digest uri matches the ACK Request-URI
	if authHdr := a.buildProxyAuth(dialog, "ACK", target); authHdr != "" {
		msg.AddHeader(sip.HdrProxyAuthorization, authHdr)
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
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	if cseqHdrs := resp.GetHeader(sip.HdrCSeq); len(cseqHdrs) > 0 {
		msg.AddHeader(sip.HdrCSeq, cseqHdrs[0])
	}
	msg.AddHeader(sip.HdrContentLength, "0")

	return a.Send(msg, "")
}

// SendCancel sends CANCEL for a pending INVITE. Per RFC 3261 §9.1 the
// Request-URI MUST equal the Request-URI of the INVITE being cancelled, so
// we copy it directly from the stored INVITE message rather than rebuilding
// it from struct fields.
func (a *ExtensionAgent) SendCancel(dialog *DialogState) error {
	if dialog.InviteMsg == nil {
		return nil
	}
	origVia := ""
	if v := dialog.InviteMsg.GetHeader(sip.HdrVia); len(v) > 0 {
		origVia = v[0]
	} else {
		origVia = fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID())
	}

	cancelURI := dialog.InviteMsg.GetRequestURI()
	if cancelURI == "" {
		cancelURI = fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	}

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("CANCEL %s SIP/2.0", cancelURI))
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
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d BYE", dialog.CSeq))
	for _, route := range dialog.RouteSet {
		msg.AddHeader(sip.HdrRoute, route)
	}
	// [FIX-2] Proactive auth on BYE — digest uri matches the BYE Request-URI
	if authHdr := a.buildProxyAuth(dialog, "BYE", target); authHdr != "" {
		msg.AddHeader(sip.HdrProxyAuthorization, authHdr)
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
		CallID:     callID,
		LocalTag:   localTag,
		LocalExt:   a.Ext,
		RemoteExt:  remoteExt,
		Domain:     a.Config.Domain,
		Transport:  a.Config.SIPTransport,
		LocalHost:  a.localHost,
		LocalPort:  a.localPort,
		RemoteTag:  remoteTag,
		CSeq:       cseq,
		InviteCSeq: cseq,
		State:      "INVITE_RCVD",
		InviteMsg:  invite,
		IsReliable: false,
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

	// 180 Ringing — no 100rel; omit RSeq/Require so the SBC does not need to PRACK us
	a.sendProvisional(invite, "180", "Ringing", localTag, true, 0)
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
		// RFC 3261 §8.2.6.1: 100 (Trying) responses SHOULD NOT contain
		// a To-tag because they do not establish an early dialog. All
		// other 1xx responses (180, 183, ...) MUST carry the To-tag.
		if code == "100" {
			resp.AddHeader(sip.HdrTo, th[0])
		} else {
			resp.AddHeader(sip.HdrTo, th[0]+";tag="+localTag)
		}
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
	sdpBody := BuildSDP(a.localHost, rtpPort, a.Config.IsRTCPMuxEnabled())

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
	// RFC 3261 §20.5 / §13.3.1: a 2xx response to INVITE MUST include the
	// Allow header listing the methods supported within the dialog.
	resp.AddHeader(sip.HdrAllow, "INVITE,ACK,OPTIONS,BYE,CANCEL,SUBSCRIBE,NOTIFY,INFO,UPDATE,PRACK")
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
	// RFC 3261 §12.1.2: the route set is the sequence of URIs in the
	// Record-Route header field values, taken in reverse order.
	// GetRecordRoutes(true) already performs that reversal for the dialog
	// owner (UAC), so no further reordering is required here.
	dialog.RouteSet = resp.GetRecordRoutes(true)
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

// Handle407Prack re-sends PRACK with Proxy-Authorization after a 407 challenge.
// After SendPrack, dialog.CSeq was incremented once; so the INVITE CSeq used in
// the original RAck is dialog.CSeq-1. The retry gets a new CSeq (dialog.CSeq++).
func (a *ExtensionAgent) Handle407Prack(dialog *DialogState, raw407 string) error {
	challenge := sip.Parse407Challenge(raw407)
	realm := challenge.Realm
	if realm == "" {
		realm = a.Config.Domain
	}
	// [FIX-2] Update stored auth state with fresh nonce from this 407.
	// Reset AuthNonceCount to 0 so the helper-driven nc starts at 1 on
	// this new nonce per RFC 2617 §3.3.
	dialog.ProxyAuthEnabled = true
	dialog.AuthNonce = challenge.Nonce
	dialog.AuthRealm = realm
	dialog.AuthOpaque = challenge.Opaque
	dialog.AuthNonceCount = 0

	cnonce := sip.GenCNonce()
	uri := fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, uri, "PRACK", cnonce, dialog.NextNCHex(), "auth", challenge.Opaque)

	rackValue := fmt.Sprintf("%d %d INVITE", dialog.RSeq, dialog.CSeq-1)
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
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<sip:%s@%s:%d>", a.Ext, a.localHost, a.localPort))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d PRACK", dialog.CSeq))
	msg.AddHeader(sip.HdrRAck, rackValue)
	msg.AddHeader(sip.HdrProxyAuthorization, authHdr)
	msg.AddHeader(sip.HdrContentLength, "0")

	return a.Send(msg, "")
}

// Handle407Bye re-sends BYE with Proxy-Authorization after a 407 challenge.
func (a *ExtensionAgent) Handle407Bye(dialog *DialogState, raw407 string) error {
	challenge := sip.Parse407Challenge(raw407)
	realm := challenge.Realm
	if realm == "" {
		realm = a.Config.Domain
	}

	dialog.CSeq++
	target := dialog.RemoteTarget
	if target == "" {
		target = fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	}

	// Refresh stored auth state with the fresh nonce from this 407 so
	// later requests in the dialog (none for BYE in practice, but kept
	// for symmetry with Handle407Prack/Invite) honour the same counter.
	dialog.AuthNonce = challenge.Nonce
	dialog.AuthRealm = realm
	dialog.AuthOpaque = challenge.Opaque
	dialog.AuthNonceCount = 0

	cnonce := sip.GenCNonce()
	// [FIX-3] Use target (the BYE Request-URI) as digest uri per RFC 2617
	// Revert FIX-3: change target back to fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, target, "BYE", cnonce, dialog.NextNCHex(), "auth", challenge.Opaque)

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("BYE %s SIP/2.0", target))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("<sip:%s@%s>;tag=%s", dialog.RemoteExt, dialog.Domain, dialog.RemoteTag))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d BYE", dialog.CSeq))
	for _, route := range dialog.RouteSet {
		msg.AddHeader(sip.HdrRoute, route)
	}
	msg.AddHeader(sip.HdrProxyAuthorization, authHdr)
	msg.AddHeader(sip.HdrContentLength, "0")

	return a.Send(msg, "")
}

// Handle407Invite re-sends INVITE with Proxy-Authorization after 407.
// It first sends the mandatory ACK for the 407 (RFC 3261 §17.1.1.3) and then
// retransmits the INVITE with the correct rtpPort in the SDP body.
func (a *ExtensionAgent) Handle407Invite(dialog *DialogState, raw407 string, rtpPort int) error {
	challenge := sip.Parse407Challenge(raw407)
	realm := challenge.Realm
	if realm == "" {
		realm = a.Config.Domain
	}
	// [FIX-2] Store auth state so subsequent in-dialog requests include
	// Proxy-Authorization proactively (mirrors Python seniors' pattern).
	// Reset AuthNonceCount to 0 so the helper-driven nc starts at 1 on
	// this new nonce per RFC 2617 §3.3.
	dialog.ProxyAuthEnabled = true
	dialog.AuthNonce = challenge.Nonce
	dialog.AuthRealm = realm
	dialog.AuthOpaque = challenge.Opaque
	dialog.AuthNonceCount = 0

	cnonce := sip.GenCNonce()
	uri := fmt.Sprintf("sip:%s@%s", dialog.RemoteExt, a.Config.Domain)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, uri, "INVITE", cnonce, dialog.NextNCHex(), "auth", challenge.Opaque)

	if dialog.InviteMsg != nil {
		// ACK must be sent BEFORE CSeq is incremented and Via is replaced,
		// so that the ACK matches the original INVITE transaction exactly.
		if err := a.sendAckFor407(dialog, raw407); err != nil {
			slog.Warn("ACK for 407 INVITE failed (non-fatal)", "ext", a.Ext, "err", err)
		}

		dialog.CSeq++
		// Track the CSeq of the INVITE we're about to re-send so the
		// subsequent ACK to its 200 OK uses the matching CSeq per
		// RFC 3261 §13.2.2.4 (regardless of any PRACK/BYE that bumps
		// dialog.CSeq further).
		dialog.InviteCSeq = dialog.CSeq
		dialog.InviteMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d INVITE", dialog.CSeq))
		dialog.InviteMsg.RemoveHeader(sip.HdrProxyAuthorization)
		dialog.InviteMsg.AddHeader(sip.HdrProxyAuthorization, authHdr)
		dialog.InviteMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))

		// Reuse the SDP built for the original INVITE so the 407 retry
		// carries an identical o= session-id (RFC 4566 §5.2). Falling back
		// to BuildSDP only if the dialog never stored one (defence in depth).
		sdpBody := dialog.InviteSDP
		if sdpBody == "" {
			sdpBody = BuildSDP(a.localHost, rtpPort, a.Config.IsRTCPMuxEnabled())
			dialog.InviteSDP = sdpBody
		}
		dialog.InviteMsg.ReplaceHeader(sip.HdrContentLength, fmt.Sprintf("%d", len(sdpBody)))
		return a.Send(dialog.InviteMsg, sdpBody)
	}
	return nil
}

// sendAckFor407 sends ACK for a 407 Proxy Authentication Required to INVITE.
// Per RFC 3261 §17.1.1.3 the ACK must reuse the original INVITE's Via branch,
// the same CSeq sequence number (method changed to ACK), and the To header
// must include the remote tag assigned by the proxy in the 407.
// Must be called before dialog.CSeq is incremented or InviteMsg.Via is replaced.
func (a *ExtensionAgent) sendAckFor407(dialog *DialogState, raw407 string) error {
	parts := strings.SplitN(raw407, "\r\n\r\n", 2)
	resp407 := sip.ParseHeaders(parts[0])

	// The Via branch MUST equal the top Via of the original INVITE.
	origVia := fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID())
	if dialog.InviteMsg != nil {
		if v := dialog.InviteMsg.GetHeader(sip.HdrVia); len(v) > 0 {
			origVia = v[0]
		}
	}

	ack := sip.NewSipMessage()
	ack.SetRequestLine(fmt.Sprintf("ACK sip:%s@%s SIP/2.0", dialog.RemoteExt, a.Config.Domain))
	ack.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			ack.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	// To header must include the remote tag from the 407 response.
	if toHdrs := resp407.GetHeader(sip.HdrTo); len(toHdrs) > 0 {
		ack.AddHeader(sip.HdrTo, toHdrs[0])
	} else {
		toBase := fmt.Sprintf("<sip:%s@%s>", dialog.RemoteExt, a.Config.Domain)
		if dialog.RemoteTag != "" {
			ack.AddHeader(sip.HdrTo, toBase+";tag="+dialog.RemoteTag)
		} else {
			ack.AddHeader(sip.HdrTo, toBase)
		}
	}
	ack.AddHeader(sip.HdrVia, origVia)
	ack.AddHeader(sip.HdrMaxForwards, "70")
	ack.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d ACK", dialog.CSeq))
	ack.AddHeader(sip.HdrContentLength, "0")

	return a.Send(ack, "")
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
			// Fan out to "_FINAL_FAIL" listeners for any 4xx/5xx/6xx
			// (excluding 401/407 which have dedicated codes). This lets the
			// CallEngine react to unsolicited final failures via a single
			// wildcard handler instead of enumerating every possible code.
			if sip.IsFinalFailureCode(eventCode) {
				queues = append(queues, a.handlers["_FINAL_FAIL"]...)
			}
			if len(queues) == 0 {
				if len(a.earlyResponses) >= maxEarlyResponses {
					a.earlyResponses = a.earlyResponses[1:]
				}
				a.earlyResponses = append(a.earlyResponses, earlyResponse{code: eventCode, raw: raw})
				slog.Debug("dispatchLoop: no handler, buffered as earlyResponse",
					"ext", a.Ext, "eventCode", eventCode, "earlyBufLen", len(a.earlyResponses))
			} else {
				slog.Debug("dispatchLoop: dispatching to handler",
					"ext", a.Ext, "eventCode", eventCode, "handlers", len(queues))
			}
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

// RemoveDialog removes a dialog from the active set by call ID and drains the
// early-response buffer so stale messages from the finished call cannot leak
// into the next call on the same agent.
func (a *ExtensionAgent) RemoveDialog(callID string) {
	a.mu.Lock()
	delete(a.ActiveDialogs, callID)
	a.mu.Unlock()
	a.ClearEarlyResponses()
}

// ClearEarlyResponses discards all buffered early responses.
// Called automatically by RemoveDialog; also available for callers that need
// an explicit reset (e.g. at the very start of a new call).
func (a *ExtensionAgent) ClearEarlyResponses() {
	a.handlerMu.Lock()
	a.earlyResponses = a.earlyResponses[:0]
	a.handlerMu.Unlock()
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

// WaitForSIPEvent waits for one of the specified SIP event codes with a
// separate timeout (independent of the parent context).
//
// Before blocking it scans the earlyResponses buffer for a match, consuming
// and returning the first hit.  This eliminates the "send then wait" race:
// if a response arrived before the caller registered a handler, the dispatch
// loop already buffered it and this call retrieves it instantly.
func (a *ExtensionAgent) WaitForSIPEvent(ctx context.Context, timeout time.Duration, codes ...string) (string, error) {
	a.handlerMu.Lock()
	for i, msg := range a.earlyResponses {
		for _, code := range codes {
			// Match either the exact bare code or the synthetic
			// "_FINAL_FAIL" wildcard against any buffered 4xx/5xx/6xx
			// (excluding 401/407 which use dedicated codes).
			if msg.code == code ||
				(code == "_FINAL_FAIL" && sip.IsFinalFailureCode(msg.code)) {
				a.earlyResponses = append(a.earlyResponses[:i], a.earlyResponses[i+1:]...)
				a.handlerMu.Unlock()
				return msg.raw, nil
			}
		}
	}
	ch := make(chan string, 8)
	for _, code := range codes {
		a.handlers[code] = append(a.handlers[code], ch)
	}
	a.handlerMu.Unlock()

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
