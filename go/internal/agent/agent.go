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
	CallID    string
	LocalTag  string
	LocalExt  string
	RemoteExt string
	Domain    string
	Transport string
	LocalHost string
	LocalPort int
	RemoteTag string
	CSeq      int
	// InviteCSeq is the CSeq sequence number of the (last) INVITE that
	// established this dialog. It is set when the INVITE is sent (or when
	// re-sent under 407 challenge in Handle407Invite) and is used by
	// SendAck so the ACK CSeq matches the INVITE per RFC 3261 §13.2.2.4.
	// Without this field SendAck would use dialog.CSeq, which has been
	// incremented by intervening PRACK/BYE traffic.
	InviteCSeq    int
	RSeq          int
	RouteSet      []string
	RemoteTarget  string
	State         string // IDLE, INVITE_SENT, PROVRESP_RCVD, ESTABLISHED, BYE_SENT, COMPLETE
	InviteSentMs  float64
	RingingRecvMs float64
	AckSentMs     float64
	ByeSentMs     float64
	IsReliable    bool
	InviteMsg     *sip.SipMessage
	// InviteSDP is the SDP body sent with the original INVITE; needed so
	// Timer A retransmissions (RFC 3261 §17.1.1.2, UDP only) can re-send
	// the exact same payload without rebuilding it.
	InviteSDP        string
	ProvMsg          *sip.SipMessage
	RTPRemoteIP      string
	RTPRemotePort    int
	MediaSecurity    string
	SRTPCryptoOffers []SRTPCryptoOffer
	SRTPRemoteCrypto SDPMediaInfo

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

// SipEvent is a parsed dispatch event stored in a durable per-dialog queue.
// It is used by call traffic so back-to-back responses (for example 100 then
// 407_INVITE) remain ordered and available even after one wait returns.
type SipEvent struct {
	Code       string
	Raw        string
	CallID     string
	CSeqNum    int
	CSeqMethod string
	Status     int
	Method     string
	ReceivedAt time.Time
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

	transport         sip.Transport
	localPort         int
	localHost         string
	assignedLocalHost string
	transportDown     func(ext string, err error)

	Registered     chan struct{}
	Subscribed     chan struct{}
	registeredOnce sync.Once
	subscribedOnce sync.Once

	ActiveDialogs map[string]*DialogState
	ZombieDialogs map[string]*DialogState
	mu            sync.RWMutex

	handlers       map[string][]chan string
	wildcards      []chan WildcardEvent
	earlyResponses []earlyResponse
	dialogQueues   map[string]chan SipEvent
	handlerMu      sync.Mutex

	closed atomic.Bool

	// autoAnswerEnabled controls whether this agent's uasLoop will answer
	// incoming INVITEs. All agents start with auto-answer enabled.
	// Disabled atomically by PoolEngine.NextPair() when the agent is selected
	// as a caller, re-enabled after the call completes (BYE/200).
	autoAnswerEnabled atomic.Bool

	regCallID     string
	regFromTag    string
	regFromHeader string
	regContactHdr string
	regNonce      string
	regRealm      string
	regOpaque     string // [FIX-4] echo opaque from 401 challenge
	regCSeq       int
	regGrantedExp int // server-granted Expires from REGISTER 200 OK
	// regNonceCount tracks the RFC 2617 §3.3 nonce-count for the active
	// REGISTER nonce. Reset to 0 whenever regNonce is replaced; the
	// helpers nextRegNC / resetRegNonce ensure increment-and-use semantics.
	regNonceCount int

	subscriptions map[string]*SubscriptionState
}

// SubscriptionState tracks one event-package subscription dialog.
type SubscriptionState struct {
	Event             string
	CallID            string
	FromHeader        string
	ToHeader          string
	Contact           string
	RemoteTarget      string
	RouteSet          []string
	AuthHeaderName    string
	Nonce             string
	Realm             string
	Opaque            string
	CSeq              int
	NonceCount        int
	NotifyReceived    bool
	SubscriptionState string
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

func (s *SubscriptionState) nextNC() string {
	s.NonceCount++
	return fmt.Sprintf("%08x", s.NonceCount)
}

func (s *SubscriptionState) resetNonce(nonce, realm, opaque string) {
	s.Nonce = nonce
	if realm != "" {
		s.Realm = realm
	}
	s.Opaque = opaque
	s.NonceCount = 0
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
		dialogQueues:  make(map[string]chan SipEvent),
		subscriptions: make(map[string]*SubscriptionState),
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

// SetAssignedLocalHost pins this agent to a specific local source IP.
func (a *ExtensionAgent) SetAssignedLocalHost(ip string) {
	a.assignedLocalHost = strings.TrimSpace(ip)
}

func (a *ExtensionAgent) SetTransportDownHandler(fn func(ext string, err error)) {
	a.transportDown = fn
}

// Start creates the SIP transport, connects, and starts the dispatch goroutine.
func (a *ExtensionAgent) Start(ctx context.Context) error {
	if a.assignedLocalHost != "" {
		a.localHost = a.assignedLocalHost
	} else if a.Config.LocalHost != "" {
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
	t.SetDownHandler(func(err error) {
		if a.transportDown != nil {
			a.transportDown(a.Ext, err)
		}
	})
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

// SubscriptionEvent returns a comma-separated list of established subscription
// event packages for logging.
func (a *ExtensionAgent) SubscriptionEvent() string {
	a.mu.RLock()
	defer a.mu.RUnlock()
	events := make([]string, 0, len(a.subscriptions))
	for event := range a.subscriptions {
		events = append(events, event)
	}
	return strings.Join(events, ",")
}

// NeedsUnsubscribe reports whether cleanup should send SUBSCRIBE Expires:0 for
// any established subscription whose event policy requires explicit teardown.
func (a *ExtensionAgent) NeedsUnsubscribe() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	for event := range a.subscriptions {
		if a.Config.ShouldUnsubscribeSubscribeEvent(event) {
			return true
		}
	}
	return false
}

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

func (a *ExtensionAgent) uriScheme() string {
	return a.Config.URIScheme()
}

func (a *ExtensionAgent) uri(user, domain string) string {
	return fmt.Sprintf("%s:%s@%s", a.uriScheme(), user, domain)
}

func (a *ExtensionAgent) addrOfRecord(user string) string {
	return a.uri(user, a.Config.Domain)
}

func (a *ExtensionAgent) domainURI() string {
	return fmt.Sprintf("%s:%s", a.uriScheme(), a.Config.Domain)
}

func (a *ExtensionAgent) nameAddr(user, domain string) string {
	return fmt.Sprintf("<%s>", a.uri(user, domain))
}

func (a *ExtensionAgent) contactURI(user string) string {
	return fmt.Sprintf("%s:%s@%s:%d;transport=%s", a.uriScheme(), user, a.localHost, a.localPort, a.Config.SIPTransport)
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

	msg := sip.BuildInitialRegisterWithScheme(a.Ext, a.Config.Domain, a.uriScheme(), a.Config.SIPTransport, a.localHost, a.localPort, a.Config.RegisterExpires)
	msg.ReplaceHeader(sip.HdrCallID, callID)
	fromHdr := fmt.Sprintf("%s;tag=%s", a.nameAddr(a.Ext, a.Config.Domain), fromTag)
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
		parsed, _, _ := sip.ParseMessage(raw)
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
	uri := a.domainURI()
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
	parsed, _, _ := sip.ParseMessage(raw200)
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

	msg := sip.BuildInitialRegisterWithScheme(a.Ext, a.Config.Domain, a.uriScheme(), a.Config.SIPTransport, a.localHost, a.localPort, a.Config.RegisterExpires)
	msg.ReplaceHeader(sip.HdrCallID, a.regCallID)
	msg.ReplaceHeader(sip.HdrFrom, a.regFromHeader)
	msg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
	msg.ReplaceHeader(sip.HdrExpires, expiresVal)

	// Include cached credentials proactively to avoid an extra 401 round-trip.
	if a.regNonce != "" {
		cnonce := sip.GenCNonce()
		uri := a.domainURI()
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
		uri := a.domainURI()
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
			parsed, _, _ := sip.ParseMessage(raw200)
			a.regGrantedExp = parsed.GetGrantedExpiry()
			slog.Debug("reregistered (after 401)", "ext", a.Ext, "granted_exp", a.regGrantedExp)
			return nil
		case <-tCtx.Done():
			return tCtx.Err()
		}
	case raw200 := <-ch200:
		parsed, _, _ := sip.ParseMessage(raw200)
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
	msg.SetRequestLine(fmt.Sprintf("REGISTER %s SIP/2.0", a.domainURI()))
	msg.AddHeader(sip.HdrCallID, a.regCallID)
	msg.AddHeader(sip.HdrFrom, a.regFromHeader)
	msg.AddHeader(sip.HdrTo, a.nameAddr(a.Ext, a.Config.Domain))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, "*")
	msg.AddHeader(sip.HdrExpires, "0")
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d REGISTER", a.regCSeq))
	msg.AddHeader(sip.HdrContentLength, "0")

	if a.regNonce != "" {
		cnonce := sip.GenCNonce()
		uri := a.domainURI()
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
		uri := a.domainURI()
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
	msg.SetRequestLine(fmt.Sprintf("REGISTER %s SIP/2.0", a.domainURI()))
	msg.AddHeader(sip.HdrCallID, callID)
	msg.AddHeader(sip.HdrFrom, fmt.Sprintf("%s;tag=%s", a.nameAddr(a.Ext, a.Config.Domain), fromTag))
	msg.AddHeader(sip.HdrTo, a.nameAddr(a.Ext, a.Config.Domain))
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
		uri := a.domainURI()
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

// Subscribe performs the configured SUBSCRIBE flows handling both 407
// (Proxy-Auth) and 401 (WWW-Auth) challenges. All configured events must
// succeed for the agent to be considered subscribed.
func (a *ExtensionAgent) Subscribe(ctx context.Context) error {
	return a.SubscribeWithProgress(ctx, nil)
}

// SubscribeWithProgress performs every configured event-package subscription.
// The callback is invoked exactly once per configured event so metrics can track
// per-event success, failure, and NOTIFY confirmation.
func (a *ExtensionAgent) SubscribeWithProgress(ctx context.Context, cb func(event string, ok bool, notifyReceived bool)) error {
	events := a.Config.SubscribeEvents
	if len(events) == 0 {
		events = []string{"dialog"}
	}
	for i, event := range events {
		st, err := a.SubscribeEvent(ctx, event)
		if err != nil {
			if cb != nil {
				cb(event, false, false)
				for _, skipped := range events[i+1:] {
					cb(skipped, false, false)
				}
			}
			return err
		}
		if cb != nil {
			cb(event, true, st != nil && st.NotifyReceived)
		}
	}
	a.subscribedOnce.Do(func() { close(a.Subscribed) })
	return nil
}

// SubscribeEvent establishes one event-package subscription and stores the
// resulting dialog/auth state independently from other subscriptions.
func (a *ExtensionAgent) SubscribeEvent(ctx context.Context, event string) (*SubscriptionState, error) {
	a.syncLocalPort()
	event = strings.ToLower(strings.TrimSpace(event))
	if event == "" {
		event = "dialog"
	}
	if _, ok := config.SubscribeEventPolicyFor(event); !ok {
		return nil, fmt.Errorf("unsupported subscribe event %q", event)
	}

	st := &SubscriptionState{
		Event:      event,
		CallID:     sip.CreateCallID(),
		FromHeader: fmt.Sprintf("%s;tag=%s", a.nameAddr(a.Ext, a.Config.Domain), sip.CreateFromTag()),
		ToHeader:   a.nameAddr(a.Ext, a.Config.Domain),
		Contact:    fmt.Sprintf("<%s>", a.contactURI(a.Ext)),
		CSeq:       1,
	}

	msg := a.buildSubscribeMessage(st, a.Config.SubscribeExpires)
	ch407 := a.waitForEvent("407")
	ch401 := a.waitForEvent("401")
	ch200 := a.waitForEvent("200")
	ch202 := a.waitForEvent("202")
	notifyQ := a.RegisterWildcardListener()
	defer a.deregisterCh(ch407, "407")
	defer a.deregisterCh(ch401, "401")
	defer a.deregisterCh(ch200, "200")
	defer a.deregisterCh(ch202, "202")
	defer a.DeregisterWildcardListener(notifyQ)

	if err := a.Send(msg, ""); err != nil {
		return nil, err
	}

	tCtx, cancel := context.WithTimeout(ctx, a.Config.NonInviteTransactionTimeout())
	defer cancel()

	sendAuthRetry := func(rawChallenge string, use401 bool) error {
		return a.sendSubscribeAuthRetry(msg, st, rawChallenge, use401)
	}

	var finalRaw string
	select {
	case raw407 := <-ch407:
		if err := sendAuthRetry(raw407, false); err != nil {
			return nil, err
		}
		select {
		case finalRaw = <-ch200:
		case finalRaw = <-ch202:
		case <-tCtx.Done():
			return nil, tCtx.Err()
		}
	case raw401 := <-ch401:
		if err := sendAuthRetry(raw401, true); err != nil {
			return nil, err
		}
		select {
		case finalRaw = <-ch200:
		case finalRaw = <-ch202:
		case <-tCtx.Done():
			return nil, tCtx.Err()
		}
	case finalRaw = <-ch200:
	case finalRaw = <-ch202:
	case <-tCtx.Done():
		return nil, tCtx.Err()
	}

	if finalRaw != "" {
		parsed, _, _ := sip.ParseMessage(finalRaw)
		if toResp := parsed.GetHeader(sip.HdrTo); len(toResp) > 0 {
			st.ToHeader = toResp[0]
		}
		st.RemoteTarget = firstURIFromHeader(parsed.GetHeader(sip.HdrContact))
		st.RouteSet = parsed.GetRecordRoutes(true)
	}
	notifyState, err := a.waitForSubscriptionNotify(tCtx, notifyQ, st, false)
	if err != nil {
		return nil, err
	}
	st.NotifyReceived = true
	st.SubscriptionState = notifyState

	a.mu.Lock()
	a.subscriptions[event] = st
	a.mu.Unlock()
	slog.Info("subscribed", "ext", a.Ext, "event", event, "subscription_state", notifyState)
	return st, nil
}

// Resubscribe refreshes every successfully established subscription.
func (a *ExtensionAgent) Resubscribe(ctx context.Context) error {
	a.syncLocalPort()
	a.mu.RLock()
	states := make([]*SubscriptionState, 0, len(a.subscriptions))
	for _, st := range a.subscriptions {
		cp := *st
		states = append(states, &cp)
	}
	a.mu.RUnlock()
	if len(states) == 0 {
		return fmt.Errorf("ext=%s: no subscription state; Subscribe must be called first", a.Ext)
	}

	for _, st := range states {
		if !a.Config.ShouldRefreshSubscribeEvent(st.Event) {
			continue
		}
		if err := a.resubscribeEvent(ctx, st); err != nil {
			return err
		}
	}
	return nil
}

func (a *ExtensionAgent) resubscribeEvent(ctx context.Context, st *SubscriptionState) error {
	st.CSeq++
	msg := a.buildSubscribeMessage(st, a.Config.SubscribeExpires)
	if st.Nonce != "" {
		cnonce := sip.GenCNonce()
		uri := subscribeRequestURI(a, st)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, st.Realm, st.Nonce, uri, "SUBSCRIBE", cnonce, st.nextNC(), "auth", st.Opaque)
		addSubscriptionAuth(msg, st, authHdr)
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

	tCtx, cancel := context.WithTimeout(ctx, a.Config.NonInviteTransactionTimeout())
	defer cancel()

	select {
	case raw401 := <-ch401:
		if err := a.sendSubscribeAuthRetry(msg, st, raw401, true); err != nil {
			return err
		}
		select {
		case <-ch200:
		case <-ch202:
		case <-tCtx.Done():
			return tCtx.Err()
		}
	case raw407 := <-ch407:
		if err := a.sendSubscribeAuthRetry(msg, st, raw407, false); err != nil {
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

	a.mu.Lock()
	a.subscriptions[st.Event] = st
	a.mu.Unlock()
	slog.Debug("resubscribed", "ext", a.Ext, "event", st.Event, "expires", a.Config.SubscribeExpires)
	return nil
}

// Unsubscribe tears down every active subscription whose event policy requires
// explicit cleanup, using RFC 6665's SUBSCRIBE-with-Expires:0 mechanism.
func (a *ExtensionAgent) Unsubscribe(ctx context.Context) error {
	return a.UnsubscribeWithProgress(ctx, nil)
}

// UnsubscribeWithProgress tears down unsubscribe-enabled subscriptions and
// reports one result per event package.
func (a *ExtensionAgent) UnsubscribeWithProgress(ctx context.Context, cb func(event string, ok bool)) error {
	a.syncLocalPort()
	a.mu.RLock()
	states := make([]*SubscriptionState, 0, len(a.subscriptions))
	for _, st := range a.subscriptions {
		cp := *st
		states = append(states, &cp)
	}
	a.mu.RUnlock()

	for _, st := range states {
		if !a.Config.ShouldUnsubscribeSubscribeEvent(st.Event) {
			continue
		}
		if err := a.unsubscribeEvent(ctx, st); err != nil {
			if cb != nil {
				cb(st.Event, false)
			}
			return err
		}
		if cb != nil {
			cb(st.Event, true)
		}
		a.mu.Lock()
		delete(a.subscriptions, st.Event)
		a.mu.Unlock()
	}
	return nil
}

func (a *ExtensionAgent) unsubscribeEvent(ctx context.Context, st *SubscriptionState) error {
	st.CSeq++
	msg := a.buildSubscribeMessage(st, 0)
	if st.Nonce != "" {
		cnonce := sip.GenCNonce()
		uri := subscribeRequestURI(a, st)
		authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, st.Realm, st.Nonce, uri, "SUBSCRIBE", cnonce, st.nextNC(), "auth", st.Opaque)
		addSubscriptionAuth(msg, st, authHdr)
	}

	ch401 := a.waitForEvent("401")
	ch407 := a.waitForEvent("407")
	ch200 := a.waitForEvent("200")
	ch202 := a.waitForEvent("202")
	notifyQ := a.RegisterWildcardListener()
	defer a.deregisterCh(ch401, "401")
	defer a.deregisterCh(ch407, "407")
	defer a.deregisterCh(ch200, "200")
	defer a.deregisterCh(ch202, "202")
	defer a.DeregisterWildcardListener(notifyQ)

	if err := a.Send(msg, ""); err != nil {
		return err
	}

	tCtx, cancel := context.WithTimeout(ctx, a.Config.NonInviteTransactionTimeout())
	defer cancel()

	select {
	case raw401 := <-ch401:
		if err := a.sendSubscribeAuthRetry(msg, st, raw401, true); err != nil {
			return err
		}
		select {
		case <-ch200:
		case <-ch202:
		case <-tCtx.Done():
			return tCtx.Err()
		}
	case raw407 := <-ch407:
		if err := a.sendSubscribeAuthRetry(msg, st, raw407, false); err != nil {
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

	state, err := a.waitForSubscriptionNotify(tCtx, notifyQ, st, true)
	if err != nil {
		return err
	}
	slog.Debug("unsubscribed", "ext", a.Ext, "event", st.Event, "subscription_state", state)
	return nil
}

func (a *ExtensionAgent) buildSubscribeMessage(st *SubscriptionState, expires int) *sip.SipMessage {
	if expires < 0 {
		expires = a.Config.SubscribeExpires
	}
	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("SUBSCRIBE %s SIP/2.0", subscribeRequestURI(a, st)))
	msg.AddHeader(sip.HdrCallID, st.CallID)
	msg.AddHeader(sip.HdrFrom, st.FromHeader)
	msg.AddHeader(sip.HdrTo, st.ToHeader)
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	for _, route := range st.RouteSet {
		msg.AddHeader(sip.HdrRoute, route)
	}
	msg.AddHeader(sip.HdrContact, st.Contact)
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrExpires, fmt.Sprintf("%d", expires))
	msg.AddHeader(sip.HdrEvent, st.Event)
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", st.CSeq))
	msg.AddHeader(sip.HdrContentLength, "0")
	msg.AddHeader(sip.HdrSupported, "100rel")
	if policy, ok := config.SubscribeEventPolicyFor(st.Event); ok && policy.Accept != "" {
		msg.AddHeader("Accept", policy.Accept)
	}
	return msg
}

func subscribeRequestURI(a *ExtensionAgent, st *SubscriptionState) string {
	if st.RemoteTarget != "" {
		return st.RemoteTarget
	}
	return a.addrOfRecord(a.Ext)
}

func addSubscriptionAuth(msg *sip.SipMessage, st *SubscriptionState, authHdr string) {
	msg.RemoveHeader(sip.HdrAuthorization)
	msg.RemoveHeader(sip.HdrProxyAuthorization)
	switch st.AuthHeaderName {
	case sip.HdrProxyAuthorization:
		msg.AddHeader(sip.HdrProxyAuthorization, authHdr)
	default:
		msg.AddHeader(sip.HdrAuthorization, authHdr)
	}
}

func firstURIFromHeader(vals []string) string {
	if len(vals) == 0 {
		return ""
	}
	value := vals[0]
	if start := strings.IndexByte(value, '<'); start >= 0 {
		if end := strings.IndexByte(value[start:], '>'); end >= 0 {
			return value[start+1 : start+end]
		}
	}
	return strings.TrimSpace(value)
}

func (a *ExtensionAgent) sendSubscribeAuthRetry(msg *sip.SipMessage, st *SubscriptionState, rawChallenge string, use401 bool) error {
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
	st.resetNonce(nonce, realm, opaque)
	if use401 {
		st.AuthHeaderName = sip.HdrAuthorization
	} else {
		st.AuthHeaderName = sip.HdrProxyAuthorization
	}

	cnonce := sip.GenCNonce()
	uri := subscribeRequestURI(a, st)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, nonce, uri, "SUBSCRIBE", cnonce, st.nextNC(), "auth", opaque)

	st.CSeq++
	retryMsg := sip.CloneSipMessage(msg)
	retryMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	retryMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", st.CSeq))
	retryMsg.RemoveHeader(sip.HdrAuthorization)
	retryMsg.RemoveHeader(sip.HdrProxyAuthorization)
	if use401 {
		retryMsg.AddHeader(sip.HdrAuthorization, authHdr)
	} else {
		retryMsg.AddHeader(sip.HdrProxyAuthorization, authHdr)
	}
	return a.Send(retryMsg, "")
}

// SendInvite builds and sends an INVITE with SDP.
func (a *ExtensionAgent) SendInvite(calleeExt string, rtpPort int) (*DialogState, error) {
	a.syncLocalPort()
	callID := sip.CreateCallID()
	localTag := sip.CreateFromTag()
	cryptoOffers, err := a.buildSRTPCryptoOffers()
	if err != nil {
		return nil, err
	}
	sdpBody := BuildSDPWithOptions(a.localHost, rtpPort, SDPOptions{
		RTCPMux:         a.Config.IsRTCPMuxEnabled(),
		MediaSecurity:   a.Config.MediaSecurity,
		SRTPCryptoLines: cryptoOfferLines(cryptoOffers),
	})

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("INVITE %s SIP/2.0", a.uri(calleeExt, a.Config.Domain)))
	msg.AddHeader(sip.HdrCallID, callID)
	msg.AddHeader(sip.HdrFrom, fmt.Sprintf("%s;tag=%s", a.nameAddr(a.Ext, a.Config.Domain), localTag))
	msg.AddHeader(sip.HdrTo, a.nameAddr(calleeExt, a.Config.Domain))
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<%s>", a.contactURI(a.Ext)))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, "1 INVITE")
	msg.AddHeader(sip.HdrSupported, "100rel")
	msg.AddHeader(sip.HdrContentType, "application/sdp")
	msg.AddHeader(sip.HdrContentLength, fmt.Sprintf("%d", len(sdpBody)))

	dialog := &DialogState{
		CallID:           callID,
		LocalTag:         localTag,
		LocalExt:         a.Ext,
		RemoteExt:        calleeExt,
		Domain:           a.Config.Domain,
		Transport:        a.Config.SIPTransport,
		LocalHost:        a.localHost,
		LocalPort:        a.localPort,
		CSeq:             1,
		InviteCSeq:       1,
		State:            "INVITE_SENT",
		InviteSentMs:     float64(time.Now().UnixMilli()),
		InviteMsg:        msg,
		InviteSDP:        sdpBody,
		IsReliable:       true,
		MediaSecurity:    a.Config.MediaSecurity,
		SRTPCryptoOffers: cryptoOffers,
	}

	a.mu.Lock()
	a.ActiveDialogs[callID] = dialog
	a.mu.Unlock()
	a.RegisterDialogQueue(callID)

	if err := a.Send(msg, sdpBody); err != nil {
		a.RemoveDialogQueue(callID)
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
	msg.SetRequestLine(fmt.Sprintf("PRACK %s SIP/2.0", a.uri(dialog.RemoteExt, a.Config.Domain)))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	toBase := a.nameAddr(dialog.RemoteExt, a.Config.Domain)
	if dialog.RemoteTag != "" {
		msg.AddHeader(sip.HdrTo, toBase+";tag="+dialog.RemoteTag)
	} else {
		msg.AddHeader(sip.HdrTo, toBase)
	}
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<%s>", a.contactURI(a.Ext)))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d PRACK", dialog.CSeq))
	msg.AddHeader(sip.HdrRAck, rackValue)
	// [FIX-2] Proactive auth on PRACK — digest uri matches the PRACK Request-URI
	if authHdr := a.buildProxyAuth(dialog, "PRACK", a.uri(dialog.RemoteExt, a.Config.Domain)); authHdr != "" {
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
		target = a.uri(dialog.RemoteExt, a.Config.Domain)
	}

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("ACK %s SIP/2.0", target))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("%s;tag=%s", a.nameAddr(dialog.RemoteExt, dialog.Domain), dialog.RemoteTag))
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

// SendAckForFailure sends ACK for a non-2xx final response to INVITE.
// RFC 3261 §17.1.1.3 requires this ACK to match the original INVITE client
// transaction: same Request-URI, Call-ID, From, top Via branch, and CSeq number
// with the method changed to ACK. The To header comes from the final response so
// any remote tag assigned by the UAS is preserved.
func (a *ExtensionAgent) SendAckForFailure(dialog *DialogState, rawResponse string) error {
	msg := sip.NewSipMessage()
	target := a.uri(dialog.RemoteExt, a.Config.Domain)
	if dialog.InviteMsg != nil {
		if uri := dialog.InviteMsg.GetRequestURI(); uri != "" {
			target = uri
		}
	}
	msg.SetRequestLine(fmt.Sprintf("ACK %s SIP/2.0", target))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	origVia := fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID())
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
		if via := dialog.InviteMsg.GetHeader(sip.HdrVia); len(via) > 0 {
			origVia = via[0]
		}
	}

	resp, _, _ := sip.ParseMessage(rawResponse)
	if toHdrs := resp.GetHeader(sip.HdrTo); len(toHdrs) > 0 {
		msg.AddHeader(sip.HdrTo, toHdrs[0])
	}
	msg.AddHeader(sip.HdrVia, origVia)
	msg.AddHeader(sip.HdrMaxForwards, "70")
	inviteCSeq := dialog.InviteCSeq
	if inviteCSeq == 0 && dialog.InviteMsg != nil {
		inviteCSeq = dialog.InviteMsg.GetCSeq()
	}
	if inviteCSeq == 0 {
		inviteCSeq = dialog.CSeq
	}
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d ACK", inviteCSeq))
	for _, route := range dialog.RouteSet {
		msg.AddHeader(sip.HdrRoute, route)
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
		cancelURI = a.uri(dialog.RemoteExt, a.Config.Domain)
	}

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("CANCEL %s SIP/2.0", cancelURI))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
		msg.AddHeader(sip.HdrFrom, fh[0])
	}
	toBase := a.nameAddr(dialog.RemoteExt, dialog.Domain)
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
		target = a.uri(dialog.RemoteExt, a.Config.Domain)
	}

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("BYE %s SIP/2.0", target))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("%s;tag=%s", a.nameAddr(dialog.RemoteExt, dialog.Domain), dialog.RemoteTag))
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
	invite, body, _ := sip.ParseMessage(rawMsg)
	callID := invite.GetCallID()
	remoteTag := invite.GetFromTag()
	localTag := sip.CreateFromTag()
	cseq := invite.GetCSeq()

	remoteExt := invite.GetReqURIUserPart()

	dialog := &DialogState{
		CallID:        callID,
		LocalTag:      localTag,
		LocalExt:      a.Ext,
		RemoteExt:     remoteExt,
		Domain:        a.Config.Domain,
		Transport:     a.Config.SIPTransport,
		LocalHost:     a.localHost,
		LocalPort:     a.localPort,
		RemoteTag:     remoteTag,
		CSeq:          cseq,
		InviteCSeq:    cseq,
		State:         "INVITE_RCVD",
		InviteMsg:     invite,
		IsReliable:    false,
		MediaSecurity: a.Config.MediaSecurity,
	}

	a.mu.Lock()
	a.ActiveDialogs[callID] = dialog
	a.mu.Unlock()

	if strings.TrimSpace(body) != "" {
		a.applySDPMedia(dialog, body, "INVITE")
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
		resp.AddHeader(sip.HdrContact, fmt.Sprintf("<%s>", a.contactURI(a.Ext)))
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
	prack, body, _ := sip.ParseMessage(rawMsg)
	if strings.TrimSpace(body) != "" {
		a.applySDPMedia(dialog, body, "PRACK")
	}

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
	byeMsg, _, _ := sip.ParseMessage(rawMsg)

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
	cryptoOffers, err := a.buildSRTPCryptoOffers()
	if err != nil {
		return err
	}
	sdpBody := BuildSDPWithOptions(a.localHost, rtpPort, SDPOptions{
		RTCPMux:         a.Config.IsRTCPMuxEnabled(),
		MediaSecurity:   a.Config.MediaSecurity,
		SRTPCryptoLines: cryptoOfferLines(cryptoOffers),
	})
	dialog.SRTPCryptoOffers = cryptoOffers
	dialog.MediaSecurity = a.Config.MediaSecurity

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
	resp.AddHeader(sip.HdrContact, fmt.Sprintf("<%s>", a.contactURI(a.Ext)))
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
	prov, body, _ := sip.ParseMessage(rawMsg)
	dialog.RemoteTag = prov.GetToTag()
	if dialog.RingingRecvMs == 0 {
		dialog.RingingRecvMs = float64(time.Now().UnixMilli())
	}
	dialog.RSeq = prov.GetRSeq()
	dialog.ProvMsg = prov
	dialog.State = "PROVRESP_RCVD"
	if strings.TrimSpace(body) != "" {
		a.applySDPMedia(dialog, body, "provisional response")
	}
}

// Parse200Invite parses 200 OK to INVITE.
func (a *ExtensionAgent) Parse200Invite(rawMsg string, dialog *DialogState) {
	resp, body, _ := sip.ParseMessage(rawMsg)
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

	if strings.TrimSpace(body) != "" {
		a.applySDPMedia(dialog, body, "200 OK INVITE")
	}
}

func (a *ExtensionAgent) applySDPMedia(dialog *DialogState, body, source string) {
	info := ParseSDPMediaInfo(body)
	if info.IP != "" && info.Port > 0 {
		dialog.RTPRemoteIP = info.IP
		dialog.RTPRemotePort = info.Port
		if dialog.MediaSecurity == "srtp_sdes" {
			dialog.SRTPRemoteCrypto = info
			if info.Proto != "RTP/SAVP" || len(info.CryptoLines) == 0 {
				slog.Warn("SRTP SDP did not include usable crypto",
					"ext", a.Ext,
					"call_id", dialog.CallID,
					"source", source,
					"proto", info.Proto,
					"crypto_count", len(info.CryptoLines))
			}
		}
		return
	}
	slog.Warn("SDP did not contain usable audio media address",
		"ext", a.Ext,
		"call_id", dialog.CallID,
		"source", source,
		"body_len", len(body),
		"has_audio", strings.Contains(body, "m=audio"),
		"has_connection", strings.Contains(body, "c=IN "),
	)
}

func (a *ExtensionAgent) buildSRTPCryptoOffers() ([]SRTPCryptoOffer, error) {
	if !a.Config.IsSRTPSDESEnabled() {
		return nil, nil
	}
	return GenerateSRTPCryptoOffers(a.Config.SRTPCryptoSuites)
}

func cryptoOfferLines(offers []SRTPCryptoOffer) []string {
	lines := make([]string, 0, len(offers))
	for _, offer := range offers {
		lines = append(lines, offer.SDPLine)
	}
	return lines
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
func (a *ExtensionAgent) Handle401Prack(dialog *DialogState, raw401 string) error {
	return a.handleAuthPrack(dialog, raw401, true)
}

func (a *ExtensionAgent) Handle407Prack(dialog *DialogState, raw407 string) error {
	return a.handleAuthPrack(dialog, raw407, false)
}

func (a *ExtensionAgent) handleAuthPrack(dialog *DialogState, rawChallenge string, use401 bool) error {
	challenge := sip.Parse407Challenge(rawChallenge)
	if use401 {
		challenge = sip.Parse401Challenge(rawChallenge)
	}
	realm := challenge.Realm
	if realm == "" {
		realm = a.Config.Domain
	}
	// Cache proxy auth for later in-dialog requests only when the challenge
	// came from a proxy. WWW-auth credentials are used for this PRACK retry only.
	if !use401 {
		dialog.ProxyAuthEnabled = true
		dialog.AuthNonce = challenge.Nonce
		dialog.AuthRealm = realm
		dialog.AuthOpaque = challenge.Opaque
	}
	dialog.AuthNonceCount = 0

	cnonce := sip.GenCNonce()
	uri := a.uri(dialog.RemoteExt, a.Config.Domain)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, uri, "PRACK", cnonce, dialog.NextNCHex(), "auth", challenge.Opaque)

	rackValue := fmt.Sprintf("%d %d INVITE", dialog.RSeq, dialog.CSeq-1)
	dialog.CSeq++

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("PRACK %s SIP/2.0", uri))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	toBase := a.nameAddr(dialog.RemoteExt, a.Config.Domain)
	if dialog.RemoteTag != "" {
		msg.AddHeader(sip.HdrTo, toBase+";tag="+dialog.RemoteTag)
	} else {
		msg.AddHeader(sip.HdrTo, toBase)
	}
	msg.AddHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))
	msg.AddHeader(sip.HdrContact, fmt.Sprintf("<%s>", a.contactURI(a.Ext)))
	msg.AddHeader(sip.HdrMaxForwards, "70")
	msg.AddHeader(sip.HdrCSeq, fmt.Sprintf("%d PRACK", dialog.CSeq))
	msg.AddHeader(sip.HdrRAck, rackValue)
	if use401 {
		msg.AddHeader(sip.HdrAuthorization, authHdr)
	} else {
		msg.AddHeader(sip.HdrProxyAuthorization, authHdr)
	}
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
		target = a.uri(dialog.RemoteExt, a.Config.Domain)
	}

	// Refresh stored auth state with the fresh nonce from this 407 so
	// later requests in the dialog (none for BYE in practice, but kept
	// for symmetry with Handle407Prack/Invite) honour the same counter.
	dialog.AuthNonce = challenge.Nonce
	dialog.AuthRealm = realm
	dialog.AuthOpaque = challenge.Opaque
	dialog.AuthNonceCount = 0

	cnonce := sip.GenCNonce()
	// Use target (the BYE Request-URI) as digest uri per RFC 2617.
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, target, "BYE", cnonce, dialog.NextNCHex(), "auth", challenge.Opaque)

	msg := sip.NewSipMessage()
	msg.SetRequestLine(fmt.Sprintf("BYE %s SIP/2.0", target))
	msg.AddHeader(sip.HdrCallID, dialog.CallID)
	if dialog.InviteMsg != nil {
		if fh := dialog.InviteMsg.GetHeader(sip.HdrFrom); len(fh) > 0 {
			msg.AddHeader(sip.HdrFrom, fh[0])
		}
	}
	msg.AddHeader(sip.HdrTo, fmt.Sprintf("%s;tag=%s", a.nameAddr(dialog.RemoteExt, dialog.Domain), dialog.RemoteTag))
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

// Handle401Invite re-sends INVITE with Authorization after 401.
// Like 407 handling, the 401 final response to INVITE must be ACKed before the
// authenticated retry starts a new INVITE client transaction.
func (a *ExtensionAgent) Handle401Invite(dialog *DialogState, raw401 string, rtpPort int) error {
	challenge := sip.Parse401Challenge(raw401)
	realm := challenge.Realm
	if realm == "" {
		realm = a.Config.Domain
	}

	cnonce := sip.GenCNonce()
	uri := a.uri(dialog.RemoteExt, a.Config.Domain)
	authHdr := sip.CalcDigestResponse(a.Ext, a.Config.SIPPassword, realm, challenge.Nonce, uri, "INVITE", cnonce, "00000001", "auth", challenge.Opaque)

	if dialog.InviteMsg != nil {
		if err := a.SendAckForFailure(dialog, raw401); err != nil {
			slog.Warn("ACK for 401 INVITE failed (non-fatal)", "ext", a.Ext, "err", err)
		}

		dialog.CSeq++
		dialog.InviteCSeq = dialog.CSeq
		dialog.InviteMsg.ReplaceHeader(sip.HdrCSeq, fmt.Sprintf("%d INVITE", dialog.CSeq))
		dialog.InviteMsg.RemoveHeader(sip.HdrAuthorization)
		dialog.InviteMsg.AddHeader(sip.HdrAuthorization, authHdr)
		dialog.InviteMsg.ReplaceHeader(sip.HdrVia, fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID()))

		sdpBody := dialog.InviteSDP
		if sdpBody == "" {
			sdpBody = BuildSDPWithOptions(a.localHost, rtpPort, SDPOptions{
				RTCPMux:         a.Config.IsRTCPMuxEnabled(),
				MediaSecurity:   dialog.MediaSecurity,
				SRTPCryptoLines: cryptoOfferLines(dialog.SRTPCryptoOffers),
			})
			dialog.InviteSDP = sdpBody
		}
		dialog.InviteMsg.ReplaceHeader(sip.HdrContentLength, fmt.Sprintf("%d", len(sdpBody)))
		return a.Send(dialog.InviteMsg, sdpBody)
	}
	return nil
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
	uri := a.uri(dialog.RemoteExt, a.Config.Domain)
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
			sdpBody = BuildSDPWithOptions(a.localHost, rtpPort, SDPOptions{
				RTCPMux:         a.Config.IsRTCPMuxEnabled(),
				MediaSecurity:   dialog.MediaSecurity,
				SRTPCryptoLines: cryptoOfferLines(dialog.SRTPCryptoOffers),
			})
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
	resp407, _, _ := sip.ParseMessage(raw407)

	// The Via branch MUST equal the top Via of the original INVITE.
	origVia := fmt.Sprintf("SIP/2.0/%s %s:%d;branch=%s", a.Config.SIPTransport, a.localHost, a.localPort, sip.CreateBranchID())
	if dialog.InviteMsg != nil {
		if v := dialog.InviteMsg.GetHeader(sip.HdrVia); len(v) > 0 {
			origVia = v[0]
		}
	}

	ack := sip.NewSipMessage()
	ack.SetRequestLine(fmt.Sprintf("ACK %s SIP/2.0", a.uri(dialog.RemoteExt, a.Config.Domain)))
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
		toBase := a.nameAddr(dialog.RemoteExt, a.Config.Domain)
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

func (a *ExtensionAgent) bufferEarlyResponseLocked(code, raw string) {
	if len(a.earlyResponses) >= maxEarlyResponses {
		a.earlyResponses = a.earlyResponses[1:]
	}
	a.earlyResponses = append(a.earlyResponses, earlyResponse{code: code, raw: raw})
}

func (a *ExtensionAgent) waitForEvent(codes ...string) chan string {
	ch := make(chan string, 8)
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
	for {
		select {
		case raw := <-ch:
			code, _ := sip.ClassifyMessage(raw)
			a.bufferEarlyResponseLocked(code, raw)
			slog.Debug("deregisterCh: drained stale event into earlyResponses",
				"ext", a.Ext, "eventCode", code, "earlyBufLen", len(a.earlyResponses))
		default:
			return
		}
	}
}

// RegisterDialogQueue creates a durable FIFO queue for a call/dialog. Call
// traffic registers this before sending INVITE so responses that arrive
// back-to-back remain available to the call state machine.
func (a *ExtensionAgent) RegisterDialogQueue(callID string) chan SipEvent {
	q := make(chan SipEvent, 32)
	a.handlerMu.Lock()
	a.dialogQueues[callID] = q
	a.handlerMu.Unlock()
	return q
}

// RemoveDialogQueue removes the durable queue for a finished call/dialog.
func (a *ExtensionAgent) RemoveDialogQueue(callID string) {
	a.handlerMu.Lock()
	delete(a.dialogQueues, callID)
	a.handlerMu.Unlock()
}

// WaitForDialogEvent waits on a durable per-dialog FIFO queue. Unlike
// WaitForSIPEvent, the queue outlives each individual wait, so events that
// arrive back-to-back (100 followed by 407_INVITE) are consumed in order.
func (a *ExtensionAgent) WaitForDialogEvent(ctx context.Context, callID string, timeout time.Duration, codes ...string) (SipEvent, error) {
	a.handlerMu.Lock()
	q := a.dialogQueues[callID]
	a.handlerMu.Unlock()
	if q == nil {
		return SipEvent{}, fmt.Errorf("dialog queue not registered for call_id=%s", callID)
	}

	tCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		select {
		case ev := <-q:
			for _, code := range codes {
				if ev.Code == code ||
					(code == "_FINAL_FAIL" && sip.IsFinalFailureCode(ev.Code)) {
					return ev, nil
				}
			}
			slog.Debug("WaitForDialogEvent: skipped unmatched event",
				"ext", a.Ext, "callID", callID, "eventCode", ev.Code)
		case <-tCtx.Done():
			return SipEvent{}, tCtx.Err()
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
			sipEvent := buildSipEvent(eventCode, raw)

			a.handlerMu.Lock()
			var dialogQ chan SipEvent
			if sipEvent.CallID != "" {
				dialogQ = a.dialogQueues[sipEvent.CallID]
			}
			queues := make([]chan string, len(a.handlers[eventCode]))
			copy(queues, a.handlers[eventCode])
			// Fan out to "_FINAL_FAIL" listeners for any 4xx/5xx/6xx
			// (excluding 401/407 which have dedicated codes). This lets the
			// CallEngine react to unsolicited final failures via a single
			// wildcard handler instead of enumerating every possible code.
			if sip.IsFinalFailureCode(eventCode) {
				queues = append(queues, a.handlers["_FINAL_FAIL"]...)
			}
			if len(queues) == 0 && dialogQ == nil {
				a.bufferEarlyResponseLocked(eventCode, raw)
				slog.Debug("dispatchLoop: no handler, buffered as earlyResponse",
					"ext", a.Ext, "eventCode", eventCode, "earlyBufLen", len(a.earlyResponses))
			} else {
				slog.Debug("dispatchLoop: dispatching to handler",
					"ext", a.Ext, "eventCode", eventCode, "handlers", len(queues))
			}
			wcs := make([]chan WildcardEvent, len(a.wildcards))
			copy(wcs, a.wildcards)
			a.handlerMu.Unlock()

			deliveredToDialog := false
			if dialogQ != nil {
				select {
				case dialogQ <- sipEvent:
					deliveredToDialog = true
					slog.Debug("dispatchLoop: queued dialog event",
						"ext", a.Ext, "callID", sipEvent.CallID, "eventCode", eventCode)
				default:
					slog.Warn("dispatchLoop: dialog queue full, dropping event",
						"ext", a.Ext, "callID", sipEvent.CallID, "eventCode", eventCode)
				}
			}

			anyDelivered := false
			for _, q := range queues {
				select {
				case q <- raw:
					anyDelivered = true
				default:
				}
			}
			if len(queues) > 0 && !anyDelivered && !deliveredToDialog {
				a.handlerMu.Lock()
				a.bufferEarlyResponseLocked(eventCode, raw)
				slog.Debug("dispatchLoop: handler channel full, buffered as earlyResponse",
					"ext", a.Ext, "eventCode", eventCode, "earlyBufLen", len(a.earlyResponses))
				a.handlerMu.Unlock()
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
	notify, _, _ := sip.ParseMessage(raw)
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
	if err := a.Send(resp, ""); err != nil {
		slog.Warn("NOTIFY 200 OK send failed", "ext", a.Ext, "err", err)
	}
}

func (a *ExtensionAgent) waitForSubscriptionNotify(ctx context.Context, wq chan WildcardEvent, st *SubscriptionState, requireTerminated bool) (string, error) {
	for {
		code, raw, err := a.WaitWildcard(ctx, wq, time.Until(deadlineFromContext(ctx)))
		if err != nil {
			return "", fmt.Errorf("subscribe event %s: wait NOTIFY: %w", st.Event, err)
		}
		if code != "NOTIFY" {
			continue
		}
		if !matchesSubscriptionNotify(raw, st) {
			continue
		}
		state := parseSubscriptionState(raw)
		if state == "" {
			return "", fmt.Errorf("subscribe event %s: NOTIFY missing Subscription-State", st.Event)
		}
		if requireTerminated && !strings.EqualFold(state, "terminated") {
			continue
		}
		return state, nil
	}
}

func deadlineFromContext(ctx context.Context) time.Time {
	if deadline, ok := ctx.Deadline(); ok {
		return deadline
	}
	return time.Now().Add(30 * time.Second)
}

func matchesSubscriptionNotify(raw string, st *SubscriptionState) bool {
	msg, _, _ := sip.ParseMessage(raw)
	if !strings.EqualFold(msg.GetMethod(), "NOTIFY") {
		return false
	}
	if msg.GetCallID() != st.CallID {
		return false
	}
	return normalizeEventToken(msg.GetEvent()) == normalizeEventToken(st.Event)
}

func parseSubscriptionState(raw string) string {
	msg, _, _ := sip.ParseMessage(raw)
	vals := msg.GetHeader(sip.HdrSubscriptionState)
	if len(vals) == 0 {
		return ""
	}
	return normalizeEventToken(vals[0])
}

func normalizeEventToken(v string) string {
	token := strings.TrimSpace(strings.ToLower(v))
	if before, _, ok := strings.Cut(token, ";"); ok {
		token = strings.TrimSpace(before)
	}
	return token
}

func (a *ExtensionAgent) respond200ToRequest(raw string) {
	req, _, _ := sip.ParseMessage(raw)
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
	req, _, _ := sip.ParseMessage(raw)
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

func buildSipEvent(eventCode, raw string) SipEvent {
	msg, _, _ := sip.ParseMessage(raw)
	ev := SipEvent{
		Code:       eventCode,
		Raw:        raw,
		CallID:     msg.GetCallID(),
		CSeqNum:    msg.GetCSeq(),
		CSeqMethod: msg.GetMethod(),
		ReceivedAt: time.Now(),
	}
	if msg.GetRequestLine() != "" {
		fields := strings.Fields(msg.GetRequestLine())
		if len(fields) > 0 {
			ev.Method = fields[0]
		}
	}
	if msg.GetResponseLine() != "" {
		fields := strings.Fields(msg.GetResponseLine())
		if len(fields) >= 2 {
			fmt.Sscanf(fields[1], "%d", &ev.Status)
		}
	}
	return ev
}

func firstLine(raw string) string {
	if idx := strings.Index(raw, "\r\n"); idx >= 0 {
		return raw[:idx]
	}
	return raw
}

func extractCallID(raw string) string {
	msg, _, err := sip.ParseMessage(raw)
	if err != nil {
		msg = sip.ParseHeaders(raw)
	}
	return msg.GetCallID()
}

func hasToTag(raw string) bool {
	msg, _, err := sip.ParseMessage(raw)
	if err != nil {
		msg = sip.ParseHeaders(raw)
	}
	return msg.GetToTag() != ""
}

// RemoveDialog removes a dialog from the active set by call ID and drains the
// early-response buffer so stale messages from the finished call cannot leak
// into the next call on the same agent.
func (a *ExtensionAgent) RemoveDialog(callID string) {
	a.mu.Lock()
	delete(a.ActiveDialogs, callID)
	a.mu.Unlock()
	a.RemoveDialogQueue(callID)
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
