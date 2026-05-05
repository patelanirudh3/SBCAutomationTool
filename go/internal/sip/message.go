package sip

import (
	"strconv"
	"strings"
)

// SipMessage represents a parsed SIP request or response with ordered headers
// and an optional SDP body.
type SipMessage struct {
	headers  map[string][]string
	reqLine  string
	respLine string
	sdpBody  string
	isReq    bool
}

// NewSipMessage creates an empty SipMessage defaulting to a request.
func NewSipMessage() *SipMessage {
	return &SipMessage{
		headers: make(map[string][]string),
		isReq:   true,
	}
}

// SetRequestLine sets the first line as a SIP request (e.g. "INVITE sip:bob@example.com SIP/2.0").
func (m *SipMessage) SetRequestLine(line string) {
	m.reqLine = line
	m.respLine = ""
	m.isReq = true
}

// GetRequestLine returns the request line, or empty string for responses.
func (m *SipMessage) GetRequestLine() string {
	return m.reqLine
}

// SetResponseLine sets the first line as a SIP response (e.g. "SIP/2.0 200 OK").
func (m *SipMessage) SetResponseLine(line string) {
	m.respLine = line
	m.reqLine = ""
	m.isReq = false
}

// GetResponseLine returns the response status line, or empty string for requests.
func (m *SipMessage) GetResponseLine() string {
	return m.respLine
}

// IsRequest returns true when the message is a SIP request.
func (m *SipMessage) IsRequest() bool {
	return m.isReq
}

// AddHeader appends a value under the normalized header name. Multiple values
// for the same header (e.g. multiple Via) are stored as separate slice entries.
func (m *SipMessage) AddHeader(name, value string) {
	name = NormalizeHeaderName(name)
	m.headers[name] = append(m.headers[name], value)
}

// RemoveHeader deletes all values for the given header.
func (m *SipMessage) RemoveHeader(name string) {
	name = NormalizeHeaderName(name)
	delete(m.headers, name)
}

// ReplaceHeader removes all existing values for the header then adds the new value.
func (m *SipMessage) ReplaceHeader(name, value string) {
	m.RemoveHeader(name)
	m.AddHeader(name, value)
}

// GetHeader returns all values for the header, or nil if absent.
func (m *SipMessage) GetHeader(name string) []string {
	return m.headers[name]
}

// GetAllHeaders returns the full header map. Callers must not mutate the
// returned map.
func (m *SipMessage) GetAllHeaders() map[string][]string {
	return m.headers
}

// GetCallID returns the Call-ID value, or empty string if absent.
func (m *SipMessage) GetCallID() string {
	vals := m.headers[HdrCallID]
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}

// GetCSeq returns the numeric CSeq sequence number, or 0 if absent/unparseable.
func (m *SipMessage) GetCSeq() int {
	vals := m.headers[HdrCSeq]
	if len(vals) == 0 {
		return 0
	}
	parts := strings.Fields(vals[0])
	if len(parts) == 0 {
		return 0
	}
	n, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0
	}
	return n
}

// GetRSeq returns the RSeq value, or 0 if absent/unparseable.
func (m *SipMessage) GetRSeq() int {
	vals := m.headers[HdrRSeq]
	if len(vals) == 0 {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(vals[0]))
	if err != nil {
		return 0
	}
	return n
}

// GetFromTag extracts the tag parameter from the From header.
func (m *SipMessage) GetFromTag() string {
	return extractTag(m.headers[HdrFrom])
}

// GetToTag extracts the tag parameter from the To header.
func (m *SipMessage) GetToTag() string {
	return extractTag(m.headers[HdrTo])
}

// extractTag finds "tag=<value>" in the first header value.
func extractTag(vals []string) string {
	if len(vals) == 0 {
		return ""
	}
	const prefix = "tag="
	hdr := vals[0]
	idx := strings.Index(hdr, prefix)
	if idx < 0 {
		return ""
	}
	tag := hdr[idx+len(prefix):]
	// tag ends at next ';' or end of string
	if semi := strings.IndexByte(tag, ';'); semi >= 0 {
		tag = tag[:semi]
	}
	return tag
}

// GetMethod returns the SIP method from CSeq (e.g. "INVITE", "BYE").
func (m *SipMessage) GetMethod() string {
	vals := m.headers[HdrCSeq]
	if len(vals) == 0 {
		return ""
	}
	parts := strings.Fields(vals[0])
	if len(parts) < 2 {
		return ""
	}
	return parts[len(parts)-1]
}

// GetResponseCode returns the 3-digit response code string (e.g. "200"),
// or empty string for requests.
func (m *SipMessage) GetResponseCode() string {
	if m.respLine == "" {
		return ""
	}
	parts := strings.SplitN(m.respLine, " ", 3)
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

// GetResponseText returns the reason phrase (e.g. "OK"), or empty string.
func (m *SipMessage) GetResponseText() string {
	if m.respLine == "" {
		return ""
	}
	parts := strings.SplitN(m.respLine, " ", 3)
	if len(parts) < 3 {
		return ""
	}
	return parts[2]
}

// GetReqURIUserPart extracts the user part from the Request-URI.
// For "INVITE sip:alice@example.com:5060;transport=tcp SIP/2.0" returns "alice".
func (m *SipMessage) GetReqURIUserPart() string {
	uri := m.requestURI()
	if uri == "" {
		return ""
	}
	// Strip URI params (everything after first ';')
	if semi := strings.IndexByte(uri, ';'); semi >= 0 {
		uri = uri[:semi]
	}
	// Skip scheme ("sip:" or "sips:")
	if idx := strings.Index(uri, ":"); idx >= 0 {
		uri = uri[idx+1:]
	}
	// user@host — take user
	if at := strings.IndexByte(uri, '@'); at >= 0 {
		return uri[:at]
	}
	return uri
}

// GetReqURIHostPart extracts the host from the Request-URI (without port).
func (m *SipMessage) GetReqURIHostPart() string {
	uri := m.requestURI()
	if uri == "" {
		return ""
	}
	if semi := strings.IndexByte(uri, ';'); semi >= 0 {
		uri = uri[:semi]
	}
	if idx := strings.Index(uri, ":"); idx >= 0 {
		uri = uri[idx+1:]
	}
	if at := strings.IndexByte(uri, '@'); at >= 0 {
		uri = uri[at+1:]
	}
	// Strip port if present
	if colon := strings.IndexByte(uri, ':'); colon >= 0 {
		uri = uri[:colon]
	}
	return uri
}

// requestURI returns the URI portion of the request line (second token).
func (m *SipMessage) requestURI() string {
	if !m.isReq || m.reqLine == "" {
		return ""
	}
	parts := strings.SplitN(m.reqLine, " ", 3)
	if len(parts) < 2 {
		return ""
	}
	return parts[1]
}

// GetRequestURI is the public form of requestURI, used by callers that must
// echo the exact original Request-URI of a stored request (e.g. CANCEL must
// reuse the INVITE Request-URI byte-for-byte per RFC 3261 §9.1).
func (m *SipMessage) GetRequestURI() string {
	return m.requestURI()
}

// ReplaceRequestURI replaces the URI portion of the request line.
func (m *SipMessage) ReplaceRequestURI(uri string) {
	if !m.isReq || m.reqLine == "" {
		return
	}
	parts := strings.SplitN(m.reqLine, " ", 3)
	if len(parts) < 3 {
		return
	}
	m.reqLine = parts[0] + " " + uri + " " + parts[2]
}

// AddContent sets the SDP (or other) body.
func (m *SipMessage) AddContent(sdp string) {
	m.sdpBody = sdp
}

// GetContent returns the message body, or empty string if none.
func (m *SipMessage) GetContent() string {
	return m.sdpBody
}

// IsResponseReliable returns true when the message carries 100rel signaling
// (Supported or Require contains "100rel" and RSeq is present).
func (m *SipMessage) IsResponseReliable() bool {
	has100rel := false

	if vals := m.headers[HdrSupported]; len(vals) > 0 {
		for _, tok := range strings.Split(vals[0], ",") {
			if strings.TrimSpace(tok) == "100rel" {
				has100rel = true
				break
			}
		}
	}
	if !has100rel {
		if vals := m.headers[HdrRequire]; len(vals) > 0 {
			for _, tok := range strings.Split(vals[0], ",") {
				if strings.TrimSpace(tok) == "100rel" {
					has100rel = true
					break
				}
			}
		}
	}

	if !has100rel {
		return false
	}
	rseq := m.headers[HdrRSeq]
	return len(rseq) > 0 && strings.TrimSpace(rseq[0]) != ""
}

// GetRecordRoutes returns Record-Route header values. When isDlgOwner is true
// the routes are returned in reverse order (caller's perspective).
func (m *SipMessage) GetRecordRoutes(isDlgOwner bool) []string {
	routes := m.headers[HdrRecordRoute]
	if len(routes) == 0 {
		return nil
	}
	// Copy to avoid mutating the stored slice.
	out := make([]string, len(routes))
	copy(out, routes)
	if isDlgOwner {
		for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
			out[i], out[j] = out[j], out[i]
		}
	}
	return out
}

// IsHeaderPresent returns true when at least one value exists for the header.
func (m *SipMessage) IsHeaderPresent(name string) bool {
	return len(m.headers[name]) > 0
}

// GetGrantedExpiry reads the server-granted Expires value from a REGISTER 200
// OK. It first checks the top-level Expires header, then falls back to the
// first Contact header's expires parameter. Returns 0 if neither is present.
func (m *SipMessage) GetGrantedExpiry() int {
	if vals := m.headers[HdrExpires]; len(vals) > 0 {
		if n, err := strconv.Atoi(strings.TrimSpace(vals[0])); err == nil && n > 0 {
			return n
		}
	}
	if contacts := m.headers[HdrContact]; len(contacts) > 0 {
		c := contacts[0]
		lower := strings.ToLower(c)
		if idx := strings.Index(lower, "expires="); idx >= 0 {
			rest := c[idx+len("expires="):]
			end := strings.IndexAny(rest, ";, \t>")
			if end < 0 {
				end = len(rest)
			}
			if n, err := strconv.Atoi(strings.TrimSpace(rest[:end])); err == nil && n > 0 {
				return n
			}
		}
	}
	return 0
}

// GetEvent returns the first Event header value, or empty string.
func (m *SipMessage) GetEvent() string {
	vals := m.headers[HdrEvent]
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}

// NormalizeHeaderName maps a raw header name to its canonical constant using
// prefix matching, mirroring the Python getHeaderName function. Unknown
// headers are returned as-is.
//
// RFC 3261 §20 compact form short names are normalized first so that headers
// arriving as "v:", "f:", "t:", etc. are stored under the same canonical key
// as their full-form counterparts.
func NormalizeHeaderName(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "i":
		return HdrCallID
	case "m":
		return HdrContact
	case "l":
		return HdrContentLength
	case "c":
		return HdrContentType
	case "f":
		return HdrFrom
	case "t":
		return HdrTo
	case "v":
		return HdrVia
	case "k":
		return HdrSupported
	}
	switch {
	case strings.HasPrefix(name, "Call-ID"):
		return HdrCallID
	case strings.HasPrefix(name, "From"):
		return HdrFrom
	case strings.HasPrefix(name, "To"):
		return HdrTo
	case strings.HasPrefix(name, "Via"):
		return HdrVia
	case strings.HasPrefix(name, "CSeq"):
		return HdrCSeq
	case strings.HasPrefix(name, "Max-Forwards"):
		return HdrMaxForwards
	case strings.HasPrefix(name, "Contact"):
		return HdrContact
	case strings.HasPrefix(name, "Content-Type"):
		return HdrContentType
	case strings.HasPrefix(name, "Content-Length"):
		return HdrContentLength
	case strings.HasPrefix(name, "Supported"):
		return HdrSupported
	case strings.HasPrefix(name, "WWW-Authenticate"):
		return HdrWWWAuthenticate
	case strings.HasPrefix(name, "Authorization"):
		return HdrAuthorization
	case strings.HasPrefix(name, "Proxy-Authenticate"):
		return HdrProxyAuthenticate
	case strings.HasPrefix(name, "Proxy-Authorization"):
		return HdrProxyAuthorization
	case strings.HasPrefix(name, "Allow"):
		return HdrAllow
	case strings.HasPrefix(name, "Require"):
		return HdrRequire
	case strings.HasPrefix(name, "Record-Route"):
		return HdrRecordRoute
	case strings.HasPrefix(name, "Route"):
		return HdrRoute
	case strings.HasPrefix(name, "RSeq"):
		return HdrRSeq
	case strings.HasPrefix(name, "RAck"):
		return HdrRAck
	case strings.HasPrefix(name, "Event"):
		return HdrEvent
	case strings.HasPrefix(name, "Subscription-State"):
		return HdrSubscriptionState
	case strings.HasPrefix(name, "Expires"):
		return HdrExpires
	case strings.HasPrefix(name, "User-Agent"):
		return HdrUserAgent
	case strings.HasPrefix(name, "Server"):
		return HdrServer
	}
	return name
}
