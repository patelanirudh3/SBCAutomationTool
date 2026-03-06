from sdp import SDP
from transport import SignalingSocket
from media import Media
from sipmessage import SipMessage
from sipconstants import SipCallState, SDPState, SipHeaders, Direction, Event
import re

class UASession:
    def __init__(self):
        self.__usrName = ""
        self.__usrDisplayName = ""
        self.__usrType = ""
        self.__password = str('123456')
        self.__callID = None
        self.__localTag = None
        self.__remoteTag = None
        self.__isDlgOwner = False
        self.__remoteTarget = None
        self.__remoteURL = None
        self.__fromHeader = None
        self.__toHeader = None
        self.__localContact = None
        self.__cSeq = 0
        self.__rSeq = 1
        self.__rAck = None  
        self.__nonce = None
        self.__cnonce = None
        self.__ncAuth = str('00000001')
        self.__opaque = str('1234567890abcdef')
        self.__uri = str('sip:sbcsv.com')
        self.__realm = str('sbcsv.com')
        self.__qop = str('auth')
        self.__response = None             
        self.__sdpVersion = 100
        self.__prevSipMessage = None
        self.__currSipMessage = None  
        self.__msgObjMap = {}      
        self.__sigSocket = None 
        self.__mediaObject = None       
        self.__mydomain = None
        self.__targetextn = None       
        self.__transport = 'tcp'
        self.__prevSDP = None
        self.__curSDP = None
        self.__localSDP = None
        self.__remoteSDP = None
        self.__scheme = 'sip'
        self.__proxyAuth = ""
        self.__routeset = []
        self.__isReliable = False
        self.__featureTags = []
        self.__allowedMethods = []
        self.__replaces = None
        self.__referTo = None
        self.__refrdBy = None
        self.__event = Event.NONE
        self.__isActiveCall = False
        self.__sipCallState = SipCallState.IDLE.value
        self.__prevSipCallState = SipCallState.IDLE.value
        self.__sdpState = SDPState.IDLE.value
        self.__prevSDPState = SDPState.IDLE.value

    def setPassword(self, pw):
        self.__password = pw

    def getPassword(self):
        return self.__password
     
    def isKnownDialog(self, callid, frm_tag, to_tag):
        if callid == self.__callID:
            if frm_tag == self.__localTag:
                if to_tag == self.__remoteTag:
                    return True

    def isDialogOwner(self):
        return self.__isDlgOwner
    
    def setDialogOwner(self,var):
        self.__isDlgOwner = var

    def setLocalTag(self, tag):
        self.__localTag = tag
        
    def getLocalTag(self):
        return self.__localTag
    
    def setRemoteTag(self, tag):
        self.__remoteTag = tag
        
    def getRemoteTag(self):
        return self.__remoteTag
    
    def setCallID(self, callId):
        self.__callID = callId
        
    def getCallID(self):
        return self.__callID
    
    def setRemoteTarget(self, rem_target):
        if rem_target:
            self.__remoteTarget = rem_target
            self.__remoteURL = re.search('<(.*)>',rem_target[0]).group(1) if re.search('<(.*)>',rem_target[0]) else ""
        
    def getRemoteTarget(self):
        return self.__remoteTarget[0]

    def getRemoteURL(self):
        return self.__remoteURL


    def setFromHeader(self, val):
        self.__fromHeader = val
        
    def getFromHeader(self):
        return self.__fromHeader[0]
    
    def setToHeader(self, uri):
        self.__toHeader = uri
        
    def getToHeader(self):
        return self.__toHeader[0]
    
    def setLocalContact(self, contact):
        self.__localContact = contact
    
    def getLocalContact(self):
        return self.__localContact

    def setProxyAuth(self, flag:bool):
        self.__proxyAuth = flag

    def getProxyAuth(self):
        return self.__proxyAuth

    def setCSeq(self,cseq):
        self.__cSeq = cseq

    def getLastCSeq(self):
        return self.__cSeq

    def setRSeq(self, val):
        self.__rSeq = val

    def getRSeq(self):
        return self.__rSeq
    
    def setRAck(self, rack):
        self.__rAck = rack
        
    def getRAck(self):
        return self.__rAck

    def setRealm(self, realm):
        self.__realm = realm

    def setURI(self, uri):
        self.__uri = uri

    def setNonce(self, nonce):
        self.__nonce = nonce

    def getNonce(self):
        return self.__nonce

    def setCNonce(self, val):
        self.__cnonce = str(val)

    def getCNonce(self):
        return self.__cnonce

    def getNCAuth(self):
        return self.__ncAuth

    def getOpaque(self):
        return self.__opaque

    def getURI(self):
        return self.__uri

    def getRealm(self):
        return self.__realm

    def getQOP(self):
        return self.__qop

    def setResponse(self, response):
        self.__response = response

    def getResponse(self):
        return self.__response

    def setEvent(self, evt):
        self.__event = evt

    def getEvent(self):
        return self.__event
        
    def setCurSipMessage(self, message):
        self.__prevSipMessage = self.__currSipMessage
        self.__currSipMessage = message
        
    def getCurSipMessage(self) -> SipMessage:
        return self.__currSipMessage
    
    def setPrevSipMessage(self, message):
        self.__prevSipMessage = message
        
    def getPrevSipMessage(self):
        return self.__prevSipMessage 
    
    def AddMsgObj(self, msg, msg_obj):
        self.__msgObjMap[msg] = msg_obj   
        
    def getMsgObj(self, evt) -> SipMessage:
        return self.__msgObjMap.get(evt)

    def setSigSocket(self, socket:SignalingSocket):
        self.__sigSocket = socket

    def getSigSocket(self) -> SignalingSocket:
        return self.__sigSocket
    
    def setMediaObject(self, obj:Media):
        self.__mediaObject = obj
        
    def getMediaObject(self) -> Media:
        return self.__mediaObject
    
    def setUserName(self, extn):
        self.__usrName = extn
        
    def getUserName(self):
        return self.__usrName
    
    def setDomain(self, domain):
        self.__mydomain = domain
        
    def getDomain(self):
        return self.__mydomain
    
    def setTargetExtn(self, extn):
        self.__targetextn = extn
        
    def getTargetExtn(self):
        return self.__targetextn   
    
    def setTransport(self, transport):
        self.__transport = transport
        
    def getTransport(self):
        return self.__transport

    def setUserDisplayName(self, displayName):
        self.__usrDisplayName = displayName

    def getUserDisplayName(self):
        return self.__usrDisplayName

    def setUserType(self, usrType):
        self.__usrType = usrType

    def getUserType(self):
        return self.__usrType
    
    def setSDPVersion(self,vers):
        self.__sdpVersion = vers
        
    def getSDPVersion(self):
        return self.__sdpVersion
    
    def setCurSDP(self, content):
        self.__prevSDP = self.__curSDP
        self.__curSDP = content
        
    def getCurSDP(self) ->SDP :
        return self.__curSDP
    
    def setPrevSDP(self, content):
        self.__prevSDP = content
    
    def getPrevSDP(self):
        return self.__prevSDP
    
    def getLocalSDP(self):
        return self.__localSDP
    
    def setLocalSDP(self, sdp):
        self.__localSDP = sdp
    
    def setRemoteSDP(self, sdp):
        self.__remoteSDP = sdp
        
    def getRemoteSDP(self) -> SDP:
        return self.__remoteSDP
    
    def getScheme(self):
        return self.__scheme
    
    def setScheme(self, scheme):
        self.__scheme = scheme
        
    def setRouteSet(self, rs):
        if self.__routeset:
            return
        self.__routeset = rs
        
    def getRouteSet(self):
        return self.__routeset
    
    def setReliable(self, flag):
        self.__isReliable = flag
        
    def isReliable(self):
        return self.__isReliable
    
    def setFeatureTags(self, tags):
        tags = tags.split(",") if tags else []
        self.__featureTags = tags
        
    def getFeatureTags(self) -> list:
        return self.__featureTags
    
    def setAllowedMethods(self, methods):
        methods = methods.split(',')
        self.__allowedMethods = ",".join(methods)
        
    def getAllowedMethods(self)->str:
        return self.__allowedMethods
        
    def setReplaces(self, replaces):
        self.__replaces = replaces
        # self.__isReplaces = True

    def getReplaces(self):
        return self.__replaces

    def setReferTo(self, refer_to):
        self.__referTo = refer_to

    def getReferTo(self):
        return self.__referTo

    def setReferredBy(self, refrd_by):
        self.__refrdBy = refrd_by

    def getReferredBy(self):
        return self.__refrdBy

    def setActiveCall(self, value):
        self.__isActiveCall = value
        
    def hasActiveCall(self):
        return self.__isActiveCall
    
    def setSipCallState(self, state:SipCallState):
        self.__prevSipCallState = self.__sipCallState
        self.__sipCallState = state
        
    def getSipCallState(self):
        return self.__sipCallState

    def getPrevSipCallState(self):
        return self.__prevSipCallState

    def setSDPstate(self, state:SDPState):
        if state == SDPState.SDP_SENT.value:
            if self.__sdpState in [SDPState.IDLE.value, SDPState.COMPLETE.value] :
                self.__prevSDPState = self.__sdpState
                self.__sdpState = SDPState.SDP_SENT.value
            elif self.__sdpState == SDPState.SDP_RCVD.value:
                self.__prevSDPState = self.__sdpState
                self.__sdpState = SDPState.COMPLETE.value

        elif state == SDPState.SDP_RCVD.value:
            if self.__sdpState in [SDPState.IDLE.value, SDPState.COMPLETE.value] :
                self.__prevSDPState = self.__sdpState
                self.__sdpState = SDPState.SDP_RCVD.value
            elif self.__sdpState == SDPState.SDP_SENT.value:
                self.__prevSDPState = self.__sdpState
                self.__sdpState = SDPState.COMPLETE.value

    def getSDPState(self):
        return self.__sdpState

    def getPrevSDPState(self):
        return self.__prevSDPState
        
    
    
        