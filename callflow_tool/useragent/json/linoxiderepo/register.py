from registration import UARegistration
from sipmessage import SipMessage
from util import createCallID, createBranchID, createFromTag, genCNonce, getMyHostIP
from sipconstants import SipHeaders, CRLF
from parserandbuilder import parseHeaders, buildMessage
import authenticate
import socket
from hashlib import md5
import copy

def sendInitialRegister(regSession:UARegistration, frm_user, proxy_domain, transport):
    sock_obj = regSession.getSigSocket()
    eph_port = sock_obj.getEphemeralPort()
    registerReq = buildInitialRegister(frm_user, proxy_domain, transport, eph_port)
    regSession.setCallID(registerReq.getCallID())
    regSession.setFromHeader(registerReq.getHeader(SipHeaders.FROM.value))
    regSession.setLocalTag(registerReq.getFromTag())
    regSession.setToHeader(registerReq.getHeader(SipHeaders.FROM.value))
    regSession.setLocalContact(registerReq.getHeader(SipHeaders.CONTACT.value)[0].split(":")[1])
    raw_message = buildMessage(registerReq,"")
    sock_obj.sendMessage(raw_message)    
    regSession.setCurrRegMessage(registerReq)

def buildInitialRegister(frm_user, proxy_domain, transport, eph_port):
    registerReq = SipMessage()       
    registerReq.setRequestLine(f'REGISTER sip:{proxy_domain} SIP/2.0')
    hdr_callid = createCallID()
    registerReq.addHeader(SipHeaders.CALLID.value,hdr_callid)
    f_tag = createFromTag()
    hdr_frm = f'<sip:{frm_user}@{proxy_domain}>;tag={f_tag}'
    registerReq.addHeader(SipHeaders.FROM.value, hdr_frm)
    hdr_to = f'<sip:{frm_user}@{proxy_domain}>'   
    registerReq.addHeader(SipHeaders.TO.value, hdr_to)     
    branch_id= createBranchID()
    hdr_via = f'SIP/2.0/{transport} {getMyHostIP()};branch={branch_id}'
    registerReq.addHeader(SipHeaders.VIA.value, hdr_via)
    host_ip = getMyHostIP()
    expires = 3600
    hdr_contact = f'<sip:{frm_user}@{host_ip}:{eph_port};transport={transport};avaya-sc-enabled>;q=1;expires={expires};'
    hdr_contact += 'avaya-actions="presence.initiate-pubsub,presence.redirect";'
    hdr_contact += '+avaya.gmtoffset="0:00";+avaya.js-ver="1.0";'
    hdr_contact += '+avaya.model="J179";+avaya.sn="n/a";'
    hdr_contact += '+avaya.firmware="FW_S_J179_R4_0_4_0_3b4033.bin";'
    hdr_contact += '+av.ip.mode=4;+av.sdp.anat;+av.sip.sig=4;+av.sip.media=4;'
    hdr_contact += '+av.sip.max-sim-reg=5;'
    hdr_contact += f'+sip.instance="<urn:uuid:b8b68b4c-4052-4253-b35d-d46b49364c87>";reg-id=1'
    registerReq.addHeader(SipHeaders.CONTACT.value, hdr_contact)
    hdr_allow = 'INVITE,ACK,OPTIONS,BYE,CANCEL,SUBSCRIBE,NOTIFY,MESSAGE,REFER,INFO,PUBLISH,UPDATE'
    registerReq.addHeader(SipHeaders.ALLOW.value, hdr_allow)
    registerReq.addHeader(SipHeaders.SUPPORTED.value, 'eventlist,feature-ref,replaces,sdp-anat,tdialog')
    registerReq.addHeader('User-Agent', 'Avaya J179 IP Phone 4.0.11.0.1 10981904bda0')
    registerReq.addHeader(SipHeaders.MAXFORWARDS.value, 70)
    registerReq.addHeader(SipHeaders.CONTENTLENGTH.value, 0)
    hdr_cseq = f'1 REGISTER'
    registerReq.addHeader(SipHeaders.CSEQ.value, hdr_cseq)
    return registerReq

def sendFinalRegister(regSession:UARegistration, frm_user, proxy_domain, transport):
    registerReq = buildFinalRegister(regSession, frm_user, proxy_domain, transport)
    raw_message = buildMessage(registerReq,"") 
    sock_obj = regSession.getSigSocket() 
    sock_obj.sendMessage(raw_message)      
    regSession.setCurrRegMessage(registerReq)
    return regSession


def buildFinalRegister(regSession:UARegistration,frm_user, proxy_domain, transport):
    
    regRequest1 = regSession.getCurrRegMessage()
    regRequest2 = copy.deepcopy(regRequest1)
    regRequest2.setRequestLine(f'REGISTER sip:{proxy_domain} SIP/2.0')    
    branch_id= createBranchID()
    hdr_via = f'SIP/2.0/{transport} {getMyHostIP()};branch={branch_id}'
    regRequest2.replaceHeader(SipHeaders.VIA.value, hdr_via)
    cseq = 2
    hdr_cseq = f'{cseq} REGISTER'
    regRequest2.replaceHeader(SipHeaders.CSEQ.value, hdr_cseq)
    hdr_auth = authenticate.calcDigestResp(regSession, regSession.getUserName(), regSession.getPassword(), 'REGISTER')
    regRequest2.addHeader(SipHeaders.AUTHORIZATION.value,hdr_auth)
    return regRequest2
    
def recvReg200OK():
    pass

def sendUnregister(regSession:UARegistration, frm_user, proxy_domain, transport):
    registerReq = buildUnregister(regSession, frm_user, proxy_domain, transport)
    raw_message = buildMessage(registerReq,"") 
    sock_obj = regSession.getSigSocket()
    sock_obj.sendMessage(raw_message)      
    regSession.setCurrRegMessage(registerReq)
    return regSession

def buildUnregister(regSession:UARegistration,frm_user, proxy_domain, transport):
    regRequest = regSession.getCurrRegMessage()
    unregRequest = copy.deepcopy(regRequest)
    unregRequest.setRequestLine(f'REGISTER sip:{proxy_domain} SIP/2.0')    
    branch_id= createBranchID()
    hdr_via = f'SIP/2.0/{transport} {frm_user}.{proxy_domain};branch={branch_id}'
    unregRequest.replaceHeader(SipHeaders.VIA.value, hdr_via)
    hdr_contact = '*'
    unregRequest.replaceHeader(SipHeaders.CONTACT.value, hdr_contact)
    unregRequest.replaceHeader(SipHeaders.EXPIRES.value,'0')
    hdr_cseq = f'3 REGISTER'
    unregRequest.replaceHeader(SipHeaders.CSEQ.value, hdr_cseq)
    hdr_auth = authenticate.calcDigestResp(regSession, regSession.getUserName(), regSession.getPassword(), 'REGISTER')    
    unregRequest.replaceHeader(SipHeaders.AUTHORIZATION.value, hdr_auth)
    return unregRequest

def recvUnreg200OK():
    pass