package sip

import (
	"crypto/md5"
	"fmt"
	"strings"
)

// DigestChallenge holds parameters parsed from a WWW-Authenticate or
// Proxy-Authenticate header carrying an RFC 2617 Digest challenge.
type DigestChallenge struct {
	Realm     string
	Nonce     string
	Opaque    string
	QOP       string
	Algorithm string
}

// ParseDigestChallenge parses a Digest challenge header value (e.g.
// `Digest realm="example.com",nonce="abc",...`) into a DigestChallenge.
// Quoted parameter values are unquoted. If multiple challenges are present
// only the first is considered; prefer feeding an MD5-specific line.
func ParseDigestChallenge(headerValue string) DigestChallenge {
	val := strings.TrimSpace(headerValue)
	// Strip the leading "Digest" scheme token if present.
	if lower := strings.ToLower(val); strings.HasPrefix(lower, "digest ") {
		val = strings.TrimSpace(val[len("digest "):])
	}

	var dc DigestChallenge
	for _, param := range strings.Split(val, ",") {
		param = strings.TrimSpace(param)
		idx := strings.IndexByte(param, '=')
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(strings.ToLower(param[:idx]))
		value := strings.TrimSpace(param[idx+1:])
		value = strings.Trim(value, "\"")

		switch key {
		case "realm":
			dc.Realm = value
		case "nonce":
			dc.Nonce = value
		case "opaque":
			dc.Opaque = value
		case "qop":
			dc.QOP = value
		case "algorithm":
			dc.Algorithm = value
		}
	}
	return dc
}

// CalcDigestResponse computes an RFC 2617 MD5 Digest response and returns the
// complete header value suitable for a Proxy-Authorization or Authorization
// header.
//
//	HA1 = MD5(username:realm:password)
//	HA2 = MD5(method:uri)
//	response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
//
// [FIX-4] opaque is echoed back from the challenge per RFC 2617 §3.2.2.
// Revert FIX-4: replace opaque parameter with hardcoded "" in format string.
func CalcDigestResponse(username, password, realm, nonce, uri, method, cnonce, nc, qop, opaque string) string {
	ha1 := md5Hex(fmt.Sprintf("%s:%s:%s", username, realm, password))
	ha2 := md5Hex(fmt.Sprintf("%s:%s", method, uri))
	response := md5Hex(fmt.Sprintf("%s:%s:%s:%s:%s:%s", ha1, nonce, nc, cnonce, qop, ha2))

	return fmt.Sprintf(
		`Digest realm="%s",nonce="%s",uri="%s",opaque="%s",qop=%s,response="%s",username="%s",cnonce="%s",nc=%s`,
		realm, nonce, uri, opaque, qop, response, username, cnonce, nc,
	)
}

// Parse401Challenge extracts the WWW-Authenticate Digest challenge from a raw
// SIP 401 response. It prefers a challenge that explicitly specifies
// algorithm=MD5; if none is found the first challenge is used.
func Parse401Challenge(rawMessage string) DigestChallenge {
	return parseChallengeFromRaw(rawMessage, "www-authenticate")
}

// Parse407Challenge extracts the Proxy-Authenticate Digest challenge from a
// raw SIP 407 response. It prefers a challenge that explicitly specifies
// algorithm=MD5; if none is found the first challenge is used.
func Parse407Challenge(rawMessage string) DigestChallenge {
	return parseChallengeFromRaw(rawMessage, "proxy-authenticate")
}

// parseChallengeFromRaw is the shared implementation for Parse401Challenge and
// Parse407Challenge. headerName must be lowercase (e.g. "www-authenticate").
func parseChallengeFromRaw(rawMessage, headerName string) DigestChallenge {
	// SIP messages separate headers from body with CRLFCRLF.
	headerSection := rawMessage
	if idx := strings.Index(rawMessage, "\r\n\r\n"); idx >= 0 {
		headerSection = rawMessage[:idx]
	}

	var candidates []string
	for _, line := range strings.Split(headerSection, "\r\n") {
		colonIdx := strings.IndexByte(line, ':')
		if colonIdx < 0 {
			continue
		}
		name := strings.TrimSpace(strings.ToLower(line[:colonIdx]))
		if name == headerName {
			candidates = append(candidates, strings.TrimSpace(line[colonIdx+1:]))
		}
	}

	chosen := chooseMD5Challenge(candidates)
	if chosen == "" {
		return DigestChallenge{}
	}
	return ParseDigestChallenge(chosen)
}

// chooseMD5Challenge picks the first challenge line that mentions algorithm=MD5.
// Falls back to the first candidate when no explicit MD5 match exists.
func chooseMD5Challenge(candidates []string) string {
	for _, c := range candidates {
		lower := strings.ToLower(c)
		if strings.Contains(lower, "algorithm=md5") {
			return c
		}
	}
	if len(candidates) > 0 {
		return candidates[0]
	}
	return ""
}

func md5Hex(s string) string {
	h := md5.Sum([]byte(s))
	return fmt.Sprintf("%x", h)
}
