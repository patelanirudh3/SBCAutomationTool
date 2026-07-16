package siptx

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/cci/traffic-engine/internal/sip"
)

// Sender is the minimal transport surface used by the transaction layer.
type Sender interface {
	Send(message string) error
	IsConnected() bool
}

// Timers contains the RFC 3261 transaction timer profile.
type Timers struct {
	T1     time.Duration
	T2     time.Duration
	T4     time.Duration
	TimerB time.Duration
	TimerF time.Duration
	TimerH time.Duration
	TimerJ time.Duration
}

// DefaultTimers returns the RFC defaults used by this traffic engine.
func DefaultTimers() Timers {
	t1 := 500 * time.Millisecond
	return Timers{
		T1:     t1,
		T2:     4 * time.Second,
		T4:     5 * time.Second,
		TimerB: 64 * t1,
		TimerF: 64 * t1,
		TimerH: 64 * t1,
		TimerJ: 64 * t1,
	}
}

func (t Timers) withDefaults() Timers {
	d := DefaultTimers()
	if t.T1 <= 0 {
		t.T1 = d.T1
	}
	if t.T2 <= 0 {
		t.T2 = d.T2
	}
	if t.T4 <= 0 {
		t.T4 = d.T4
	}
	if t.TimerB <= 0 {
		t.TimerB = 64 * t.T1
	}
	if t.TimerF <= 0 {
		t.TimerF = 64 * t.T1
	}
	if t.TimerH <= 0 {
		t.TimerH = 64 * t.T1
	}
	if t.TimerJ <= 0 {
		t.TimerJ = 64 * t.T1
	}
	return t
}

// Manager owns SIP client/server transaction retransmission for one agent and
// one currently selected controller transport. It intentionally has no
// failover hooks; transport ownership changes are handled by higher layers.
type Manager struct {
	sender Sender
	timers Timers

	mu     sync.Mutex
	client map[string]*clientTx
	server map[string]*serverTx
	closed bool

	onDuplicateInvite2xx func(raw string)
}

// NewManager creates a transaction manager for a single transport path.
func NewManager(sender Sender, timers Timers) *Manager {
	return &Manager{
		sender: sender,
		timers: timers.withDefaults(),
		client: make(map[string]*clientTx),
		server: make(map[string]*serverTx),
	}
}

// SetDuplicateInvite2xxHandler registers a callback invoked when a duplicate
// 2xx response to an INVITE is received while transaction state is retained.
// The owner should resend ACK idempotently and avoid business metric
// double-counting.
func (m *Manager) SetDuplicateInvite2xxHandler(fn func(raw string)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.onDuplicateInvite2xx = fn
}

// Send sends a SIP message and, when possible, starts the matching transaction
// timers. Retransmissions always reuse the exact raw bytes sent initially.
func (m *Manager) Send(raw string) error {
	if strings.TrimSpace(raw) == "" {
		return fmt.Errorf("siptx: empty SIP message")
	}
	msg, _, err := sip.ParseMessage(raw)
	if err != nil {
		if sendErr := m.sendRaw(raw); sendErr != nil {
			return sendErr
		}
		return nil
	}

	if err := m.sendRaw(raw); err != nil {
		return err
	}

	if msg.IsRequest() {
		m.startClientTransaction(msg, raw)
		return nil
	}
	m.startOrUpdateServerTransaction(msg, raw)
	return nil
}

// HandleInbound observes an inbound SIP message, updates transaction state, and
// returns true when the message was fully handled by the transaction layer and
// should not be delivered to business logic again.
func (m *Manager) HandleInbound(raw string) bool {
	msg, _, err := sip.ParseMessage(raw)
	if err != nil {
		return false
	}
	if msg.IsRequest() {
		return m.handleInboundRequest(msg)
	}
	return m.handleInboundResponse(msg)
}

// Shutdown terminates all retransmission loops for this manager.
func (m *Manager) Shutdown(reason string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	m.closed = true
	for key, tx := range m.client {
		tx.stop(reason)
		delete(m.client, key)
	}
	for key, tx := range m.server {
		tx.stop(reason)
		delete(m.server, key)
	}
}

func (m *Manager) sendRaw(raw string) error {
	if m.sender == nil {
		return fmt.Errorf("siptx: nil sender")
	}
	if !m.sender.IsConnected() {
		return fmt.Errorf("siptx: transport not connected")
	}
	return m.sender.Send(raw)
}

func (m *Manager) retransmit(raw, label, key string) bool {
	if m.sender == nil || !m.sender.IsConnected() {
		slog.Debug("SIP transaction retransmission stopped; transport down", "label", label, "key", key)
		return false
	}
	if err := m.sender.Send(raw); err != nil {
		slog.Debug("SIP transaction retransmission failed", "label", label, "key", key, "err", err)
		return false
	}
	slog.Debug("SIP transaction retransmitted", "label", label, "key", key)
	return true
}

func (m *Manager) startClientTransaction(msg *sip.SipMessage, raw string) {
	method := requestMethod(msg)
	if method == "" || strings.EqualFold(method, "ACK") {
		return
	}
	key := clientKey(msg)
	if key == "" {
		return
	}

	tx := newClientTx(m, key, method, raw)
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	if old := m.client[key]; old != nil {
		old.stop("replaced")
	}
	m.client[key] = tx
	m.mu.Unlock()

	if strings.EqualFold(method, "INVITE") {
		tx.startInvite()
	} else {
		tx.startNonInvite()
	}
}

func (m *Manager) handleInboundResponse(msg *sip.SipMessage) bool {
	key := clientKey(msg)
	if key == "" {
		return false
	}
	code := msg.GetResponseCode()
	method := msg.GetMethod()
	raw := sip.BuildMessage(msg, msg.GetContent())

	m.mu.Lock()
	tx := m.client[key]
	m.mu.Unlock()
	if tx == nil {
		return false
	}
	duplicateInvite2xx := tx.handleResponse(code)
	if duplicateInvite2xx {
		m.mu.Lock()
		fn := m.onDuplicateInvite2xx
		m.mu.Unlock()
		if fn != nil {
			fn(raw)
		}
		return true
	}

	if isFinal(code) {
		cleanup := m.timers.T4
		if !strings.EqualFold(method, "INVITE") {
			cleanup = m.timers.T4
		}
		go m.removeClientAfter(key, cleanup)
	}
	return false
}

func (m *Manager) startOrUpdateServerTransaction(msg *sip.SipMessage, raw string) {
	method := msg.GetMethod()
	if method == "" {
		return
	}
	key := serverKey(msg)
	if key == "" {
		return
	}

	code := msg.GetResponseCode()
	m.mu.Lock()
	tx := m.server[key]
	if tx == nil {
		tx = newServerTx(m, key, method, msg)
		m.server[key] = tx
	}
	m.mu.Unlock()
	tx.handleOutboundResponse(code, raw)
}

func (m *Manager) handleInboundRequest(msg *sip.SipMessage) bool {
	method := requestMethod(msg)
	key := serverKey(msg)
	if method == "" || key == "" {
		return false
	}

	if strings.EqualFold(method, "ACK") {
		m.mu.Lock()
		tx := m.server[key]
		if tx == nil {
			tx = m.findInviteServerTxForAckLocked(msg)
		}
		m.mu.Unlock()
		if tx != nil {
			tx.handleAck()
		}
		return false
	}

	m.mu.Lock()
	tx := m.server[key]
	m.mu.Unlock()
	if tx == nil {
		return false
	}
	return tx.handleDuplicateRequest()
}

func (m *Manager) findInviteServerTxForAckLocked(msg *sip.SipMessage) *serverTx {
	callID := msg.GetCallID()
	cseq := msg.GetCSeq()
	fromTag := msg.GetFromTag()
	if callID == "" || cseq == 0 {
		return nil
	}
	for _, tx := range m.server {
		if !strings.EqualFold(tx.method, "INVITE") {
			continue
		}
		if tx.callID == callID && tx.cseq == cseq {
			if fromTag == "" || tx.fromTag == "" || fromTag == tx.fromTag {
				return tx
			}
		}
	}
	return nil
}

func (m *Manager) removeClientAfter(key string, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	<-timer.C
	m.removeClientNow(key, nil, "cleanup")
}

func (m *Manager) removeClientNow(key string, expected *clientTx, reason string) {
	m.mu.Lock()
	if tx := m.client[key]; tx != nil {
		if expected != nil && tx != expected {
			m.mu.Unlock()
			return
		}
		tx.stop(reason)
		delete(m.client, key)
	}
	m.mu.Unlock()
}

func (m *Manager) removeServerAfter(key string, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	<-timer.C
	m.mu.Lock()
	if tx := m.server[key]; tx != nil {
		tx.stop("cleanup")
		delete(m.server, key)
	}
	m.mu.Unlock()
}

type clientTx struct {
	m      *Manager
	key    string
	method string
	raw    string

	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once

	mu          sync.Mutex
	gotResponse bool
	final       bool
	final2xx    bool
}

func newClientTx(m *Manager, key, method, raw string) *clientTx {
	ctx, cancel := context.WithCancel(context.Background())
	return &clientTx{m: m, key: key, method: method, raw: raw, ctx: ctx, cancel: cancel}
}

func (tx *clientTx) startInvite() {
	go tx.runTimerA()
	go tx.runClientDeadline(tx.m.timers.TimerB, "TimerB")
}

func (tx *clientTx) startNonInvite() {
	go tx.runTimerE()
	go tx.runClientDeadline(tx.m.timers.TimerF, "TimerF")
}

func (tx *clientTx) runTimerA() {
	interval := tx.m.timers.T1
	for {
		select {
		case <-tx.ctx.Done():
			return
		case <-time.After(interval):
			tx.mu.Lock()
			stop := tx.gotResponse || tx.final
			tx.mu.Unlock()
			if stop {
				return
			}
			if ok := tx.m.retransmit(tx.raw, "TimerA", tx.key); !ok {
				tx.stop("transport_down")
				return
			}
			interval *= 2
		}
	}
}

func (tx *clientTx) runTimerE() {
	interval := tx.m.timers.T1
	for {
		select {
		case <-tx.ctx.Done():
			return
		case <-time.After(interval):
			tx.mu.Lock()
			stop := tx.final
			tx.mu.Unlock()
			if stop {
				return
			}
			if ok := tx.m.retransmit(tx.raw, "TimerE", tx.key); !ok {
				tx.stop("transport_down")
				return
			}
			interval *= 2
			if interval > tx.m.timers.T2 {
				interval = tx.m.timers.T2
			}
		}
	}
}

func (tx *clientTx) runClientDeadline(d time.Duration, label string) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-tx.ctx.Done():
		return
	case <-timer.C:
		slog.Debug("SIP client transaction timed out", "timer", label, "method", tx.method, "key", tx.key)
		tx.stop(label)
		tx.m.removeClientNow(tx.key, tx, label)
	}
}

func (tx *clientTx) handleResponse(code string) bool {
	tx.mu.Lock()
	defer tx.mu.Unlock()
	duplicateInvite2xx := strings.EqualFold(tx.method, "INVITE") && strings.HasPrefix(code, "2") && tx.final2xx
	tx.gotResponse = true
	if isFinal(code) {
		tx.final = true
		if strings.EqualFold(tx.method, "INVITE") && strings.HasPrefix(code, "2") {
			tx.final2xx = true
		}
		tx.stop("final_response")
		return duplicateInvite2xx
	}
	if strings.EqualFold(tx.method, "INVITE") {
		return false
	}
	return false
}

func (tx *clientTx) stop(_ string) {
	tx.once.Do(tx.cancel)
}

type serverTx struct {
	m       *Manager
	key     string
	method  string
	callID  string
	cseq    int
	fromTag string

	ctx    context.Context
	cancel context.CancelFunc
	once   sync.Once

	mu        sync.Mutex
	lastProv  string
	finalResp string
	finalCode string
}

func newServerTx(m *Manager, key, method string, msg *sip.SipMessage) *serverTx {
	ctx, cancel := context.WithCancel(context.Background())
	return &serverTx{
		m:       m,
		key:     key,
		method:  method,
		callID:  msg.GetCallID(),
		cseq:    msg.GetCSeq(),
		fromTag: msg.GetFromTag(),
		ctx:     ctx,
		cancel:  cancel,
	}
}

func (tx *serverTx) handleOutboundResponse(code, raw string) {
	if code == "" {
		return
	}
	tx.mu.Lock()
	if isFinal(code) {
		tx.finalResp = raw
		tx.finalCode = code
	} else {
		tx.lastProv = raw
	}
	tx.mu.Unlock()

	if !isFinal(code) {
		return
	}
	if strings.EqualFold(tx.method, "INVITE") {
		if strings.HasPrefix(code, "2") {
			go tx.runInvite2xx()
		} else {
			go tx.runTimerG()
			go tx.runServerDeadline(tx.m.timers.TimerH, "TimerH")
		}
		return
	}
	go tx.m.removeServerAfter(tx.key, tx.m.timers.TimerJ)
}

func (tx *serverTx) handleDuplicateRequest() bool {
	tx.mu.Lock()
	resp := tx.finalResp
	if resp == "" && strings.EqualFold(tx.method, "INVITE") {
		resp = tx.lastProv
	}
	tx.mu.Unlock()
	if resp == "" {
		return false
	}
	_ = tx.m.retransmit(resp, "cached_response", tx.key)
	return true
}

func (tx *serverTx) handleAck() {
	if !strings.EqualFold(tx.method, "INVITE") {
		return
	}
	tx.stop("ack")
	go tx.m.removeServerAfter(tx.key, tx.m.timers.T4)
}

func (tx *serverTx) runTimerG() {
	interval := tx.m.timers.T1
	for {
		select {
		case <-tx.ctx.Done():
			return
		case <-time.After(interval):
			tx.mu.Lock()
			resp := tx.finalResp
			tx.mu.Unlock()
			if resp == "" {
				return
			}
			if ok := tx.m.retransmit(resp, "TimerG", tx.key); !ok {
				tx.stop("transport_down")
				return
			}
			interval *= 2
			if interval > tx.m.timers.T2 {
				interval = tx.m.timers.T2
			}
		}
	}
}

func (tx *serverTx) runInvite2xx() {
	interval := tx.m.timers.T1
	deadline := time.NewTimer(tx.m.timers.TimerH)
	defer deadline.Stop()
	for {
		select {
		case <-tx.ctx.Done():
			return
		case <-deadline.C:
			tx.stop("2xx_ack_timeout")
			return
		case <-time.After(interval):
			tx.mu.Lock()
			resp := tx.finalResp
			tx.mu.Unlock()
			if resp == "" {
				return
			}
			if ok := tx.m.retransmit(resp, "INVITE_2xx", tx.key); !ok {
				tx.stop("transport_down")
				return
			}
			interval *= 2
			if interval > tx.m.timers.T2 {
				interval = tx.m.timers.T2
			}
		}
	}
}

func (tx *serverTx) runServerDeadline(d time.Duration, label string) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-tx.ctx.Done():
		return
	case <-timer.C:
		slog.Debug("SIP server transaction timed out", "timer", label, "method", tx.method, "key", tx.key)
		tx.stop(label)
	}
}

func (tx *serverTx) stop(_ string) {
	tx.once.Do(tx.cancel)
}

func clientKey(msg *sip.SipMessage) string {
	return keyFromMessage(msg)
}

func serverKey(msg *sip.SipMessage) string {
	return keyFromMessage(msg)
}

func keyFromMessage(msg *sip.SipMessage) string {
	branch := topViaBranch(msg)
	method := msg.GetMethod()
	if method == "" && msg.IsRequest() {
		method = requestMethod(msg)
	}
	callID := msg.GetCallID()
	cseq := msg.GetCSeq()
	fromTag := msg.GetFromTag()
	if branch == "" || method == "" || callID == "" || cseq == 0 {
		return ""
	}
	return strings.Join([]string{branch, strings.ToUpper(method), fmt.Sprintf("%d", cseq), callID, fromTag}, "|")
}

func requestMethod(msg *sip.SipMessage) string {
	line := msg.GetRequestLine()
	if line == "" {
		return ""
	}
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return ""
	}
	return strings.ToUpper(fields[0])
}

func topViaBranch(msg *sip.SipMessage) string {
	vias := msg.GetHeader(sip.HdrVia)
	if len(vias) == 0 {
		return ""
	}
	parts := strings.Split(vias[0], ";")
	for _, part := range parts[1:] {
		k, v, ok := strings.Cut(strings.TrimSpace(part), "=")
		if ok && strings.EqualFold(strings.TrimSpace(k), "branch") {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

func isFinal(code string) bool {
	return len(code) == 3 && code[0] >= '2' && code[0] <= '6'
}
