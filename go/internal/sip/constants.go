// Package sip provides SIP message parsing, building, and classification
// for the CCI Traffic Engine.
package sip

// Line terminators per RFC 3261.
const (
	CRLF     = "\r\n"
	CRLFCRLF = "\r\n\r\n"
)

// SIP header name constants. These are the canonical forms used as map keys
// throughout the engine; incoming header names are normalized to these via
// NormalizeHeaderName.
const (
	HdrCallID             = "Call-ID"
	HdrFrom               = "From"
	HdrTo                 = "To"
	HdrCSeq               = "CSeq"
	HdrVia                = "Via"
	HdrRecordRoute        = "Record-Route"
	HdrRoute              = "Route"
	HdrContact            = "Contact"
	HdrMaxForwards        = "Max-Forwards"
	HdrContentType        = "Content-Type"
	HdrContentLength      = "Content-Length"
	HdrSupported          = "Supported"
	HdrWWWAuthenticate    = "WWW-Authenticate"
	HdrAuthorization      = "Authorization"
	HdrProxyAuthenticate  = "Proxy-Authenticate"
	HdrProxyAuthorization = "Proxy-Authorization"
	HdrExpires            = "Expires"
	HdrRequire            = "Require"
	HdrRSeq               = "RSeq"
	HdrRAck               = "RAck"
	HdrAllow              = "Allow"
	HdrEvent              = "Event"
	HdrSubscriptionState  = "Subscription-State"
	HdrMinExpires         = "Min-Expires"
	HdrUserAgent          = "User-Agent"
	HdrServer             = "Server"
)

const UserAgentValue = "Nexus-Traffic-Engine"

// SipRespCodeMap maps SIP response code strings to their reason phrases.
var SipRespCodeMap = map[string]string{
	"100": "Trying",
	"180": "Ringing",
	"181": "Call Is Being Forwarded",
	"182": "Queued",
	"183": "Session Progress",
	"200": "OK",
	"202": "Accepted",
	"301": "Moved Permanently",
	"302": "Moved Temporarily",
	"380": "Alternative Service",
	"400": "Bad Request",
	"401": "Unauthorised",
	"402": "Payment Required",
	"403": "Forbidden",
	"404": "Not Found",
	"405": "Method Not Allowed",
	"406": "Not Acceptable",
	"407": "Proxy Authentication Required",
	"408": "Request Timeout",
	"410": "Gone",
	"413": "Request Entity Too Large",
	"414": "Request-URI Too Large",
	"415": "Unsupported Media Type",
	"416": "Unsupported URI Scheme",
	"420": "Bad Extension",
	"421": "Extension Required",
	"423": "Interval Too Brief",
	"480": "Temporary Not Available",
	"481": "Call Leg Does Not Exist",
	"482": "Loop Detected",
	"483": "Too Many Hops",
	"484": "Address Incomplete",
	"485": "Ambiguous",
	"486": "Busy Here",
	"487": "Request Terminated",
	"488": "Not Acceptable Here",
	"491": "Request Pending",
	"500": "Internal Server Error",
	"501": "Not Implemented",
	"502": "Bad Gateway",
	"503": "Service Unavailable",
	"504": "Server Timeout",
}
