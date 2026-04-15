package sip

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	recvBufSize = 65536
	recvChSize  = 256
)

// Reconnect backoff bounds (TCP/TLS).
const (
	initialBackoff = 500 * time.Millisecond
	maxBackoff     = 30 * time.Second
)

// Transport is the common interface for SIP transports (UDP, TCP, TLS).
// A Transport is created in an unconnected state; call Connect before use.
type Transport interface {
	Connect(ctx context.Context) error
	Send(message string) error
	RecvChan() <-chan string
	Close() error
	LocalPort() int
}

// ---------------------------------------------------------------------------
// UDP
// ---------------------------------------------------------------------------

// UDPTransport sends and receives SIP messages over a single UDP socket.
// Each received datagram is treated as one complete SIP message (RFC 3261 §18.1).
type UDPTransport struct {
	localHost  string
	remoteHost string
	remotePort int

	conn      *net.UDPConn
	recvCh    chan string
	localPort int
}

// NewUDPTransport returns an unconnected UDPTransport.
func NewUDPTransport(localHost, remoteHost string, remotePort int) *UDPTransport {
	return &UDPTransport{
		localHost:  localHost,
		remoteHost: remoteHost,
		remotePort: remotePort,
		recvCh:     make(chan string, recvChSize),
	}
}

func (t *UDPTransport) Connect(ctx context.Context) error {
	raddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(t.remoteHost, strconv.Itoa(t.remotePort)))
	if err != nil {
		return fmt.Errorf("resolve remote: %w", err)
	}
	laddr, err := net.ResolveUDPAddr("udp", net.JoinHostPort(t.localHost, "0"))
	if err != nil {
		return fmt.Errorf("resolve local: %w", err)
	}

	conn, err := net.DialUDP("udp", laddr, raddr)
	if err != nil {
		return fmt.Errorf("dial udp: %w", err)
	}
	t.conn = conn
	t.localPort = conn.LocalAddr().(*net.UDPAddr).Port

	slog.Debug("UDP socket bound",
		"local", conn.LocalAddr().String(),
		"remote", conn.RemoteAddr().String(),
	)

	go t.readLoop()
	return nil
}

func (t *UDPTransport) readLoop() {
	buf := make([]byte, recvBufSize)
	for {
		n, err := t.conn.Read(buf)
		if err != nil {
			// Connection closed — stop silently.
			return
		}
		msg := string(buf[:n])
		select {
		case t.recvCh <- msg:
		default:
			slog.Warn("UDP recv channel full, dropping message")
		}
	}
}

func (t *UDPTransport) Send(message string) error {
	if t.conn == nil {
		return fmt.Errorf("UDP transport not connected")
	}
	_, err := t.conn.Write([]byte(message))
	return err
}

func (t *UDPTransport) RecvChan() <-chan string { return t.recvCh }

func (t *UDPTransport) Close() error {
	if t.conn != nil {
		return t.conn.Close()
	}
	return nil
}

func (t *UDPTransport) LocalPort() int { return t.localPort }

// ---------------------------------------------------------------------------
// TCP / TLS
// ---------------------------------------------------------------------------

// TCPTransport sends and receives SIP messages over a persistent TCP (or TLS)
// connection with Content-Length framing and automatic reconnect on failure.
type TCPTransport struct {
	localHost  string
	remoteHost string
	remotePort int

	useTLS    bool
	tlsConfig *tls.Config
	resolver  *net.Resolver

	conn      net.Conn
	recvCh    chan string
	localPort int
	closed    atomic.Bool
	mu        sync.Mutex
	done      chan struct{} // signals readLoop to exit cleanly
}

// NewTCPTransport returns an unconnected TCPTransport.
// Set useTLS to true for TLS; tlsConfig may be nil for a default insecure config.
func NewTCPTransport(localHost, remoteHost string, remotePort int, useTLS bool, tlsConfig *tls.Config) *TCPTransport {
	if useTLS && tlsConfig == nil {
		tlsConfig = &tls.Config{InsecureSkipVerify: true} //nolint:gosec
	}
	return &TCPTransport{
		localHost:  localHost,
		remoteHost: remoteHost,
		remotePort: remotePort,
		useTLS:     useTLS,
		tlsConfig:  tlsConfig,
		recvCh:     make(chan string, recvChSize),
		done:       make(chan struct{}),
	}
}

func (t *TCPTransport) Connect(ctx context.Context) error {
	if err := t.dial(ctx); err != nil {
		return err
	}
	go t.readLoop()
	return nil
}

// dial establishes the TCP (or TLS) connection, binding to localHost.
func (t *TCPTransport) dial(ctx context.Context) error {
	remoteAddr := net.JoinHostPort(t.remoteHost, strconv.Itoa(t.remotePort))
	localAddr, err := net.ResolveTCPAddr("tcp", net.JoinHostPort(t.localHost, "0"))
	if err != nil {
		return fmt.Errorf("resolve local: %w", err)
	}

	netDialer := &net.Dialer{LocalAddr: localAddr, Resolver: t.resolver}

	if t.useTLS {
		dialer := &tls.Dialer{
			NetDialer: netDialer,
			Config:    t.tlsConfig,
		}
		conn, dialErr := dialer.DialContext(ctx, "tcp", remoteAddr)
		if dialErr != nil {
			return fmt.Errorf("tls dial: %w", dialErr)
		}
		t.setConn(conn)
	} else {
		conn, dialErr := netDialer.DialContext(ctx, "tcp", remoteAddr)
		if dialErr != nil {
			return fmt.Errorf("tcp dial: %w", dialErr)
		}
		t.setConn(conn)
	}

	proto := "TCP"
	if t.useTLS {
		proto = "TLS"
	}
	slog.Debug(proto+" connected",
		"local", t.conn.LocalAddr().String(),
		"remote", t.conn.RemoteAddr().String(),
	)
	return nil
}

func (t *TCPTransport) setConn(conn net.Conn) {
	t.conn = conn
	if addr, ok := conn.LocalAddr().(*net.TCPAddr); ok {
		t.localPort = addr.Port
	}
}

func (t *TCPTransport) Send(message string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conn == nil {
		return fmt.Errorf("TCP transport not connected")
	}
	_, err := t.conn.Write([]byte(message))
	return err
}

func (t *TCPTransport) RecvChan() <-chan string { return t.recvCh }

func (t *TCPTransport) Close() error {
	t.closed.Store(true)
	close(t.done)
	t.mu.Lock()
	conn := t.conn
	t.mu.Unlock()
	if conn != nil {
		return conn.Close()
	}
	return nil
}

func (t *TCPTransport) LocalPort() int { return t.localPort }

// readLoop continuously reads from the TCP connection, frames complete SIP
// messages using Content-Length, and pushes them onto recvCh.
// On EOF or error it reconnects with exponential backoff unless closed.
func (t *TCPTransport) readLoop() {
	buf := make([]byte, 0, recvBufSize)
	tmp := make([]byte, recvBufSize)

	for {
		if t.closed.Load() {
			return
		}

		n, err := t.conn.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}

		// Extract as many complete SIP messages as the buffer holds.
		for {
			msg, consumed := extractSIPMessage(buf)
			if consumed == 0 {
				break
			}
			buf = buf[consumed:]
			if msg == "" {
				continue
			}
			select {
			case t.recvCh <- msg:
			default:
				slog.Warn("TCP recv channel full, dropping message")
			}
		}

		if err != nil {
			if t.closed.Load() {
				return
			}
			slog.Warn("TCP read error, reconnecting", "err", err,
				"remote", net.JoinHostPort(t.remoteHost, strconv.Itoa(t.remotePort)))
			t.reconnect()
			buf = buf[:0]
		}
	}
}

// reconnect closes the current connection and re-dials with exponential backoff.
func (t *TCPTransport) reconnect() {
	t.mu.Lock()
	if t.conn != nil {
		t.conn.Close()
		t.conn = nil
	}
	t.mu.Unlock()

	backoff := initialBackoff
	for {
		if t.closed.Load() {
			return
		}

		ctx, cancel := context.WithTimeout(context.Background(), backoff)
		err := t.dial(ctx)
		cancel()
		if err == nil {
			slog.Info("TCP reconnected",
				"local", t.conn.LocalAddr().String(),
				"remote", t.conn.RemoteAddr().String(),
			)
			return
		}

		slog.Warn("TCP reconnect failed, retrying",
			"err", err,
			"remote", net.JoinHostPort(t.remoteHost, strconv.Itoa(t.remotePort)),
			"backoff", backoff,
		)

		select {
		case <-time.After(backoff):
		case <-t.done:
			return
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// ---------------------------------------------------------------------------
// SIP Content-Length framing (ported from Python _extract_message)
// ---------------------------------------------------------------------------

var crlfcrlfBytes = []byte(CRLFCRLF)

// extractSIPMessage tries to pull one complete SIP message from buf.
// It returns the decoded message string and the number of bytes consumed.
// If the buffer does not yet contain a complete message, consumed is 0.
func extractSIPMessage(buf []byte) (msg string, consumed int) {
	// RFC 3261 §7.5: ignore any CRLF appearing before the start-line
	// on stream-oriented transports.
	skip := 0
	for skip+1 < len(buf) && buf[skip] == '\r' && buf[skip+1] == '\n' {
		skip += 2
	}
	if skip > 0 {
		slog.Debug("extractSIPMessage: stripped leading CRLF", "bytes", skip, "bufRemaining", len(buf)-skip)
		buf = buf[skip:]
	}
	if len(buf) == 0 {
		return "", skip
	}

	sepIdx := bytes.Index(buf, crlfcrlfBytes)
	if sepIdx < 0 {
		return "", 0
	}

	headerEnd := sepIdx + len(crlfcrlfBytes)
	headerBlock := string(buf[:headerEnd])

	contentLength := 0
	for _, line := range strings.Split(headerBlock, CRLF) {
		if len(line) > 0 && strings.HasPrefix(strings.ToLower(line), "content-length") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				if v, err := strconv.Atoi(strings.TrimSpace(parts[1])); err == nil {
					contentLength = v
				}
			}
			break
		}
	}

	totalNeeded := headerEnd + contentLength
	if len(buf) < totalNeeded {
		return "", 0
	}

	return string(buf[:totalNeeded]), skip + totalNeeded
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// CreateTransport creates the appropriate Transport for the given type string
// ("TCP", "UDP", or "TLS"). The returned transport is unconnected; call
// Connect before use.
// CreateTransport builds the appropriate Transport for the given type.
// The resolver parameter is optional — when non-nil it is used for FQDN
// resolution of remoteHost (custom DNS servers); nil falls back to system DNS.
func CreateTransport(transportType, localHost, remoteHost string, remotePort int, resolver *net.Resolver) (Transport, error) {
	switch strings.ToUpper(transportType) {
	case "UDP":
		return NewUDPTransport(localHost, remoteHost, remotePort), nil
	case "TCP":
		t := NewTCPTransport(localHost, remoteHost, remotePort, false, nil)
		t.resolver = resolver
		return t, nil
	case "TLS":
		t := NewTCPTransport(localHost, remoteHost, remotePort, true, nil)
		t.resolver = resolver
		return t, nil
	default:
		return nil, fmt.Errorf("unknown SIP transport type: %q", transportType)
	}
}
