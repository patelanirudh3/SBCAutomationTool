package sip

import (
	"fmt"
	"strconv"
	"strings"
)

// CloneSipMessage performs a deep copy of a SipMessage, duplicating all headers
// and the body so the original is not mutated.
func CloneSipMessage(m *SipMessage) *SipMessage {
	clone := &SipMessage{
		reqLine:  m.reqLine,
		respLine: m.respLine,
		sdpBody:  m.sdpBody,
		isReq:    m.isReq,
		headers:  make(map[string][]string, len(m.headers)),
	}
	for k, vals := range m.headers {
		dup := make([]string, len(vals))
		copy(dup, vals)
		clone.headers[k] = dup
	}
	return clone
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

// BuildInitialRegister constructs the first REGISTER request for a given
// extension, including the full Avaya phone Contact header with feature tags.
func BuildInitialRegister(fromUser, domain, transport, localIP string, localPort int, expires int) *SipMessage {
	m := NewSipMessage()
	m.SetRequestLine(fmt.Sprintf("REGISTER sip:%s SIP/2.0", domain))

	m.AddHeader(HdrCallID, CreateCallID())

	fromTag := CreateFromTag()
	m.AddHeader(HdrFrom, fmt.Sprintf("<sip:%s@%s>;tag=%s", fromUser, domain, fromTag))
	m.AddHeader(HdrTo, fmt.Sprintf("<sip:%s@%s>", fromUser, domain))
	m.AddHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))

	contact := fmt.Sprintf(
		"<sip:%s@%s:%d;transport=%s;avaya-sc-enabled>;q=1;expires=%d;",
		fromUser, localIP, localPort, transport, expires,
	)
	contact += `avaya-actions="presence.initiate-pubsub,presence.redirect";`
	contact += `+avaya.gmtoffset="0:00";+avaya.js-ver="1.0";`
	contact += `+avaya.model="J179";+avaya.sn="n/a";`
	contact += `+avaya.firmware="FW_S_J179_R4_0_4_0_3b4033.bin";`
	contact += `+av.ip.mode=4;+av.sdp.anat;+av.sip.sig=4;+av.sip.media=4;`
	contact += `+av.sip.max-sim-reg=5;`
	contact += fmt.Sprintf(`+sip.instance="<urn:uuid:%s>";reg-id=1`, InstanceUUID(fromUser))
	m.AddHeader(HdrContact, contact)

	m.AddHeader(HdrAllow, "INVITE,ACK,OPTIONS,BYE,CANCEL,SUBSCRIBE,NOTIFY,MESSAGE,REFER,INFO,PUBLISH,UPDATE")
	m.AddHeader(HdrSupported, "eventlist,feature-ref,replaces,sdp-anat,tdialog")
	m.AddHeader(HdrUserAgent, "Avaya J179 IP Phone 4.0.11.0.1 10981904bda0")
	m.AddHeader(HdrMaxForwards, "70")
	m.AddHeader(HdrContentLength, "0")
	m.AddHeader(HdrCSeq, "1 REGISTER")

	return m
}

// BuildAuthRegister constructs an authenticated REGISTER (typically CSeq 2)
// by cloning a previous REGISTER and adding the Authorization header derived
// from a 401 challenge.
func BuildAuthRegister(prev *SipMessage, domain, transport, localIP, authHeader string, cseq int) *SipMessage {
	m := CloneSipMessage(prev)
	m.SetRequestLine(fmt.Sprintf("REGISTER sip:%s SIP/2.0", domain))
	m.ReplaceHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	m.ReplaceHeader(HdrCSeq, fmt.Sprintf("%d REGISTER", cseq))
	m.AddHeader(HdrAuthorization, authHeader)
	return m
}

// BuildUnregister constructs an unregister request (Contact: *, Expires: 0)
// by cloning the most recent REGISTER and overriding the relevant headers.
func BuildUnregister(prev *SipMessage, domain, transport, localIP, authHeader string) *SipMessage {
	m := CloneSipMessage(prev)
	m.SetRequestLine(fmt.Sprintf("REGISTER sip:%s SIP/2.0", domain))
	m.ReplaceHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	m.ReplaceHeader(HdrContact, "*")
	m.ReplaceHeader(HdrExpires, "0")
	m.ReplaceHeader(HdrCSeq, "3 REGISTER")
	m.ReplaceHeader(HdrAuthorization, authHeader)
	return m
}

// BuildSubscribe constructs a SUBSCRIBE request for the specified event.
func BuildSubscribe(callID, fromHeader, toHeader, domain, transport, localIP, contactHeader, event string, cseq int, supportedTags string) *SipMessage {
	m := NewSipMessage()

	toURI := extractURI(toHeader)
	m.SetRequestLine(fmt.Sprintf("SUBSCRIBE %s SIP/2.0", toURI))

	m.AddHeader(HdrCallID, callID)
	m.AddHeader(HdrFrom, fromHeader)
	m.AddHeader(HdrTo, toHeader)
	m.AddHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	m.AddHeader(HdrContact, contactHeader)
	m.AddHeader(HdrMaxForwards, "70")
	m.AddHeader(HdrExpires, "600")
	m.AddHeader(HdrEvent, event)
	m.AddHeader(HdrCSeq, fmt.Sprintf("%d SUBSCRIBE", cseq))
	m.AddHeader(HdrContentLength, "0")
	if supportedTags != "" {
		m.AddHeader(HdrSupported, supportedTags)
	}

	return m
}

// BuildInvite constructs an INVITE request with an SDP body targeting
// toUser@domain.
func BuildInvite(fromUser, toUser, domain, transport, localIP string, localPort int, callID, fromTag string, cseq int, routeSet []string, sdpBody string) *SipMessage {
	m := NewSipMessage()
	m.SetRequestLine(fmt.Sprintf("INVITE sip:%s@%s SIP/2.0", toUser, domain))

	m.AddHeader(HdrCallID, callID)
	m.AddHeader(HdrFrom, fmt.Sprintf("<sip:%s@%s>;tag=%s", fromUser, domain, fromTag))
	m.AddHeader(HdrTo, fmt.Sprintf("<sip:%s@%s>", toUser, domain))
	m.AddHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	m.AddHeader(HdrContact, fmt.Sprintf("<sip:%s@%s:%d;transport=%s>", fromUser, localIP, localPort, transport))
	for _, route := range routeSet {
		m.AddHeader(HdrRoute, route)
	}
	m.AddHeader(HdrMaxForwards, "70")
	m.AddHeader(HdrCSeq, fmt.Sprintf("%d INVITE", cseq))
	m.AddHeader(HdrContentType, "application/sdp")
	m.AddHeader(HdrContentLength, strconv.Itoa(len(sdpBody)))
	if sdpBody != "" {
		m.AddContent(sdpBody)
	}

	return m
}

// BuildInviteWithAuth constructs a re-INVITE with a Proxy-Authorization
// header after receiving a 407 challenge.
func BuildInviteWithAuth(prev *SipMessage, authHeader string, cseq int, transport, localIP string) *SipMessage {
	m := CloneSipMessage(prev)
	m.ReplaceHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	m.ReplaceHeader(HdrCSeq, fmt.Sprintf("%d INVITE", cseq))
	m.AddHeader(HdrProxyAuthorization, authHeader)
	return m
}

// BuildAck constructs an ACK for a 200 OK response to an INVITE. The
// Request-URI is taken from the Contact header of the response.
func BuildAck(invite *SipMessage, resp *SipMessage, transport, localIP string, routeSet []string) *SipMessage {
	m := NewSipMessage()

	reqURI := extractURI(firstHeader(resp, HdrContact))
	if reqURI == "" {
		reqURI = invite.requestURI()
	}
	m.SetRequestLine(fmt.Sprintf("ACK %s SIP/2.0", reqURI))

	m.AddHeader(HdrCallID, invite.GetCallID())
	m.AddHeader(HdrFrom, firstHeader(invite, HdrFrom))

	toHdr := firstHeader(resp, HdrTo)
	if toHdr == "" {
		toHdr = firstHeader(invite, HdrTo)
	}
	m.AddHeader(HdrTo, toHdr)

	m.AddHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	for _, route := range routeSet {
		m.AddHeader(HdrRoute, route)
	}
	m.AddHeader(HdrCSeq, fmt.Sprintf("%d ACK", invite.GetCSeq()))
	m.AddHeader(HdrMaxForwards, "70")
	m.AddHeader(HdrContentLength, "0")

	return m
}

// BuildPrack constructs a PRACK request acknowledging a reliable provisional
// response. The RAck header is set to "{rseq} {invite-cseq} INVITE".
func BuildPrack(invite *SipMessage, resp *SipMessage, transport, localIP string, rseq int, routeSet []string) *SipMessage {
	m := NewSipMessage()

	reqURI := extractURI(firstHeader(resp, HdrContact))
	if reqURI == "" {
		reqURI = invite.requestURI()
	}
	m.SetRequestLine(fmt.Sprintf("PRACK %s SIP/2.0", reqURI))

	m.AddHeader(HdrCallID, invite.GetCallID())
	m.AddHeader(HdrFrom, firstHeader(invite, HdrFrom))

	toHdr := firstHeader(resp, HdrTo)
	if toHdr == "" {
		toHdr = firstHeader(invite, HdrTo)
	}
	m.AddHeader(HdrTo, toHdr)

	m.AddHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	for _, route := range routeSet {
		m.AddHeader(HdrRoute, route)
	}

	invCSeq := invite.GetCSeq()
	m.AddHeader(HdrCSeq, fmt.Sprintf("%d PRACK", invCSeq+1))
	m.AddHeader(HdrRAck, fmt.Sprintf("%d %d INVITE", rseq, invCSeq))
	m.AddHeader(HdrMaxForwards, "70")
	m.AddHeader(HdrContentLength, "0")

	return m
}

// BuildBye constructs a BYE request to tear down an established dialog.
func BuildBye(callID, fromHeader, toHeader, transport, localIP string, cseq int, routeSet []string) *SipMessage {
	m := NewSipMessage()

	reqURI := extractURI(toHeader)
	m.SetRequestLine(fmt.Sprintf("BYE %s SIP/2.0", reqURI))

	m.AddHeader(HdrCallID, callID)
	m.AddHeader(HdrFrom, fromHeader)
	m.AddHeader(HdrTo, toHeader)
	m.AddHeader(HdrVia, fmt.Sprintf("SIP/2.0/%s %s;branch=%s", transport, localIP, CreateBranchID()))
	for _, route := range routeSet {
		m.AddHeader(HdrRoute, route)
	}
	m.AddHeader(HdrMaxForwards, "70")
	m.AddHeader(HdrCSeq, fmt.Sprintf("%d BYE", cseq))
	m.AddHeader(HdrContentLength, "0")

	return m
}

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

// Build200OK constructs a 200 OK response for an INVITE, optionally carrying
// an SDP body.
func Build200OK(req *SipMessage, localIP string, localPort int, sdpBody string) *SipMessage {
	m := NewSipMessage()
	m.SetResponseLine("SIP/2.0 200 OK")

	copyVias(req, m)
	m.AddHeader(HdrFrom, firstHeader(req, HdrFrom))
	m.AddHeader(HdrTo, firstHeader(req, HdrTo))
	m.AddHeader(HdrCallID, req.GetCallID())
	m.AddHeader(HdrCSeq, firstHeader(req, HdrCSeq))
	m.AddHeader(HdrContact, fmt.Sprintf("<sip:%s:%d>", localIP, localPort))

	if sdpBody != "" {
		m.AddHeader(HdrContentType, "application/sdp")
		m.AddHeader(HdrContentLength, strconv.Itoa(len(sdpBody)))
		m.AddContent(sdpBody)
	} else {
		m.AddHeader(HdrContentLength, "0")
	}

	return m
}

// Build180Ringing constructs a 180 Ringing response with 100rel support
// (Require and RSeq headers).
func Build180Ringing(req *SipMessage, localIP string, toTag string, rseq int) *SipMessage {
	m := NewSipMessage()
	m.SetResponseLine("SIP/2.0 180 Ringing")

	copyVias(req, m)
	m.AddHeader(HdrFrom, firstHeader(req, HdrFrom))

	toHdr := firstHeader(req, HdrTo)
	if toTag != "" && !strings.Contains(toHdr, "tag=") {
		toHdr += ";tag=" + toTag
	}
	m.AddHeader(HdrTo, toHdr)

	m.AddHeader(HdrCallID, req.GetCallID())
	m.AddHeader(HdrCSeq, firstHeader(req, HdrCSeq))
	m.AddHeader(HdrRequire, "100rel")
	m.AddHeader(HdrRSeq, strconv.Itoa(rseq))
	m.AddHeader(HdrContentLength, "0")

	return m
}

// Build100Trying constructs a 100 Trying response by copying the essential
// headers from the request.
func Build100Trying(req *SipMessage) *SipMessage {
	m := NewSipMessage()
	m.SetResponseLine("SIP/2.0 100 Trying")

	copyVias(req, m)
	m.AddHeader(HdrFrom, firstHeader(req, HdrFrom))
	m.AddHeader(HdrTo, firstHeader(req, HdrTo))
	m.AddHeader(HdrCallID, req.GetCallID())
	m.AddHeader(HdrCSeq, firstHeader(req, HdrCSeq))
	m.AddHeader(HdrContentLength, "0")

	return m
}

// Build200Bye constructs a 200 OK response for a BYE request.
func Build200Bye(req *SipMessage) *SipMessage {
	m := NewSipMessage()
	m.SetResponseLine("SIP/2.0 200 OK")

	copyVias(req, m)
	m.AddHeader(HdrFrom, firstHeader(req, HdrFrom))
	m.AddHeader(HdrTo, firstHeader(req, HdrTo))
	m.AddHeader(HdrCallID, req.GetCallID())
	m.AddHeader(HdrCSeq, firstHeader(req, HdrCSeq))
	m.AddHeader(HdrContentLength, "0")

	return m
}

// Build200Prack constructs a 200 OK response for a PRACK request.
func Build200Prack(req *SipMessage) *SipMessage {
	m := NewSipMessage()
	m.SetResponseLine("SIP/2.0 200 OK")

	copyVias(req, m)
	m.AddHeader(HdrFrom, firstHeader(req, HdrFrom))
	m.AddHeader(HdrTo, firstHeader(req, HdrTo))
	m.AddHeader(HdrCallID, req.GetCallID())
	m.AddHeader(HdrCSeq, firstHeader(req, HdrCSeq))
	m.AddHeader(HdrContentLength, "0")

	return m
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// firstHeader returns the first value for the named header, or empty string.
func firstHeader(m *SipMessage, name string) string {
	vals := m.GetHeader(name)
	if len(vals) == 0 {
		return ""
	}
	return vals[0]
}

// copyVias copies all Via headers from src to dst, preserving order.
func copyVias(src, dst *SipMessage) {
	for _, v := range src.GetHeader(HdrVia) {
		dst.AddHeader(HdrVia, v)
	}
}

// extractURI returns the SIP URI from a header value, stripping angle brackets
// and display names. For example, '"Alice" <sip:alice@host>' returns
// "sip:alice@host".
func extractURI(headerValue string) string {
	if start := strings.IndexByte(headerValue, '<'); start >= 0 {
		if end := strings.IndexByte(headerValue[start:], '>'); end >= 0 {
			return headerValue[start+1 : start+end]
		}
	}
	return strings.TrimSpace(headerValue)
}
