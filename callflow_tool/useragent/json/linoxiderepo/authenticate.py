from uasession import UASession
from registration import UARegistration
from util import genCNonce
from parserandbuilder import parseHeaders
from sipconstants import SipHeaders, CRLF
from hashlib import md5

def _parse_digest_challenge(header_value: str) -> dict:
    """Parse Digest challenge params from WWW-Authenticate or Proxy-Authenticate.
    Returns dict with nonce, realm (and optionally qop, opaque).
    Prefers MD5 algorithm if multiple challenges present."""
    params = [p.strip() for p in header_value.split(',')]
    out = {}
    for p in params:
        if '=' not in p:
            continue
        key = p.split('=', 1)[0].strip().lower()
        val = p.split('=', 1)[1].strip().strip('"')
        out[key] = val
    return out


def recv407ProxyAuth(uaSession: UASession, raw_message):
    """Parse 407 Proxy-Authenticate, set nonce/realm on uaSession.
    Prefer MD5 challenge (calcDigestResp uses MD5)."""
    sip_msg = raw_message.split(CRLF + CRLF)
    msg_407 = parseHeaders(sip_msg[0])
    headers = msg_407.getHeader(SipHeaders.PROXYAUTHENTICATE.value) or []

    chosen = None
    for hdr in headers:
        stripped = hdr.strip()
        if 'algorithm=MD5' in stripped or 'algorithm=md5' in stripped.lower():
            chosen = stripped
            break
    if chosen is None and headers:
        chosen = headers[0].strip()
    if chosen is None:
        return msg_407

    params = _parse_digest_challenge(chosen)
    if 'nonce' in params:
        uaSession.setNonce(params['nonce'])
    if 'realm' in params:
        uaSession.setRealm(params['realm'])
    uaSession.setProxyAuth(True)
    return msg_407

def calcDigestResp(obj, usr_name, password, method:str):
    usr_name = str(usr_name)
    password = str(password)    
    obj.setCNonce(genCNonce())
    
    A1 = md5("{}:{}:{}".format(usr_name,obj.getRealm(),password).encode('utf-8')).hexdigest()
    A2 = md5("{}:{}".format(method,obj.getURI()).encode('utf-8')).hexdigest()
    
    A3 = md5("{}:{}:{}:{}:{}:{}".format(A1,obj.getNonce(),obj.getNCAuth(),obj.getCNonce(),obj.getQOP(),A2).encode('utf-8')).hexdigest()
    
    response = f'"{A3}"'

    hdr_proxy_authorization = f'Digest realm="{obj.getRealm()}",nonce="{obj.getNonce()}",uri="{obj.getURI()}",opaque="{obj.getOpaque()}"'
    hdr_proxy_authorization += f',qop={obj.getQOP()},response={response}'
    hdr_proxy_authorization += f',username="{obj.getUserName()}",cnonce="{obj.getCNonce()}",nc={obj.getNCAuth()}'

    obj.setUserName(usr_name)
    obj.setResponse(response)
    
    return hdr_proxy_authorization

def recv401Unauthorised(regSession:UARegistration, raw_message):
    sip_msg = raw_message.split(CRLF+CRLF)
    sig_msg = sip_msg[0]
    sipMessage = parseHeaders(sig_msg)
    authenticate_headers = sipMessage.getHeader(SipHeaders.WWWAUTHENTICATE.value) or []

    # Prefer the MD5 challenge — calcDigestResp uses MD5.
    # Fall back to the first header if no explicit MD5 challenge is present.
    chosen = None
    for hdr in authenticate_headers:
        stripped = hdr.strip()
        if 'algorithm=MD5' in stripped or stripped.lower().find('algorithm=md5') != -1:
            chosen = stripped
            break
    if chosen is None and authenticate_headers:
        chosen = authenticate_headers[0].strip()
    if chosen is None:
        return

    # Parse comma-separated parameters; strip leading/trailing whitespace from each.
    params = [p.strip() for p in chosen.split(',')]

    for p in params:
        key_part = p.split('=', 1)[0].strip().lower()
        val_part = p.split('=', 1)[1].strip().strip('"') if '=' in p else ''
        if key_part == 'nonce':
            regSession.setNonce(val_part)
        elif key_part.endswith('realm'):
            regSession.setRealm(val_part)
