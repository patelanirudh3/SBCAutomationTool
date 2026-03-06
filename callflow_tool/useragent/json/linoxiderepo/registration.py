from sipmessage import SipMessage
from transport import SignalingSocket

class UARegistration:
    def __init__(self):
        self.__usrName = ""
        self.__password = str('123456')
        self.__callID = None
        self.__fromHeader = None
        self.__localContact = None
        self.__localTag = None
        self.__toHeader = None
        self.__seqNo = 1
        self.__sdpVersion = 1
        self.__nonce = None
        self.__cnonce = None
        self.__ncAuth = str('00000001')
        self.__ncUnreg = str('00000003')
        self.__opaque = str('1234567890abcdef')
        self.__uri = str('sip:sbcsv.com')
        self.__realm = str('sbcsv.com')
        self.__qop = str('auth')
        self.__response = None
        self.__prevRegMessage = None
        self.__currRegMessage = None
        self.__sockId = None


    def setUserName(self, name):
        self.__usrName = name

    def getUserName(self):
        return self.__usrName

    def setPassword(self, pw):
        self.__password = pw

    def getPassword(self):
        return self.__password
    
    def setCallID(self, callId):
        self.__callID = callId
        
    def getCallID(self):
        return self.__callID

    def setFromHeader(self, uri):
        self.__fromHeader = uri
        
    def getFromHeader(self):
        return self.__fromHeader

    def setLocalContact(self, contact):
        self.__localContact = contact
    
    def getLocalContact(self):
        return self.__localContact

    def setLocalTag(self, tag):
        self.__localTag = tag
        
    def getLocalTag(self):
        return self.__localTag

    def setToHeader(self, uri):
        self.__toHeader = uri
        
    def getToHeader(self):
        return self.__toHeader

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

    def getNCUnreg(self):
        return self.__ncUnreg

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

    def setCurrRegMessage(self, message):
        self.__currRegMessage = message

    def getCurrRegMessage(self):
        return self.__currRegMessage
    
    def setSigSocket(self, sockid):
        self.__sockId = sockid
        
    def getSigSocket(self)->SignalingSocket:
        return self.__sockId
