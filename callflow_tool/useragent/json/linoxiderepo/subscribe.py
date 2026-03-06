
from email.headerregistry import UniqueAddressHeader
from uasession import UASession
from sipmessage import SipMessage
from util import createBranchID, createFromTag, createToTag, getMyHostIP, genCNonce, genRSeq, createCallID
from sipconstants import SipHeaders, CRLF, SipRespCodeMap, SDPState
from parserandbuilder import parseHeaders, parseContent, parseInputAndModifyMessage
import authenticate
import socket, copy
#from hashlib import md5
  
def sendSubscribe(uaSession:UASession):          
    subscribe_msg = buildSubscribe(uaSession)    
    uaSession.setCurSipMessage(subscribe_msg)       
    return subscribe_msg
    

def buildSubscribe(uaSession:UASession):
    subscribe_msg = SipMessage()       
    subscribe_msg.setRequestLine(f'SUBSCRIBE sip:{uaSession.getTargetExtn()}@{uaSession.getDomain()} SIP/2.0')
    hdr_callid = uaSession.getCallID()
    subscribe_msg.addHeader(SipHeaders.CALLID.value, hdr_callid)
    hdr_frm = f'{uaSession.getFromHeader()}'
    subscribe_msg.addHeader(SipHeaders.FROM.value, hdr_frm)
    subscribe_msg.addHeader(SipHeaders.TO.value, uaSession.getToHeader()) 
    hdr_via = f'SIP/2.0/{uaSession.getTransport()} {getMyHostIP()};branch={createBranchID()}'
    subscribe_msg.addHeader(SipHeaders.VIA.value, hdr_via)
    if uaSession.getUserType() in ["RW", "INT"]:
        port = uaSession.getSigSocket().getEphemeralPort()
    hdr_contact = f'{uaSession.getLocalContact()}'
    subscribe_msg.addHeader(SipHeaders.CONTACT.value, hdr_contact)
    subscribe_msg.addHeader(SipHeaders.MAXFORWARDS.value, '70')
    subscribe_msg.addHeader(SipHeaders.EXPIRES.value, 600)
    subscribe_msg.addHeader(SipHeaders.EVENT.value, uaSession.getEvent())
    cseq = uaSession.getLastCSeq() + 1
    hdr_cseq = f'{cseq} SUBSCRIBE'
    subscribe_msg.addHeader(SipHeaders.CSEQ.value, hdr_cseq) 
    uaSession.setCSeq(cseq)
    subscribe_msg.addHeader(SipHeaders.CONTENTLENGTH.value, 0)
    featuretags = uaSession.getFeatureTags()    
    if uaSession.isReliable():
        if "100rel" not in featuretags:
            featuretags.append("100rel")           
    if featuretags:  
        supported_tags = ",".join(featuretags)              
        subscribe_msg.addHeader(SipHeaders.SUPPORTED.value, supported_tags)  
    allowedmethods = uaSession.getAllowedMethods()
    if allowedmethods:
        subscribe_msg.addHeader(SipHeaders.ALLOW.value, allowedmethods)        
    return subscribe_msg


def recvSubscribe(uaSession:UASession, recv_subscribe):
    recv_subscribe = recv_subscribe.split(CRLF+CRLF)
    recv_subscribe = parseHeaders(recv_subscribe[0])
    return recv_subscribe

def send200Subscribe(uaSession:UASession):
    subscribe200_msg = build200Subscribe(uaSession)
    return subscribe200_msg

def build200Subscribe(uaSession:UASession):
    last_msg = uaSession.getMsgObj('SUBSCRIBE')
    subscribe200_msg = copy.deepcopy(last_msg)
    subscribe200_msg.setRequestLine(f'SIP/2.0 200 OK')
    hdr_contact = uaSession.getLocalContact()
    subscribe200_msg.replaceHeader(SipHeaders.CONTACT.value, hdr_contact)
    return subscribe200_msg

def recv200Subscribe(uaSession:UASession, recv_subscribe):
    recv_200subscribe = recv_subscribe.split(CRLF+CRLF)
    subscribe200_msg = parseHeaders(recv_200subscribe[0])
    return subscribe200_msg


def sendSubscribeNotify(uaSession:UASession):
    pass

def buildSubscribeNotify(uaSession:UASession):
    pass


