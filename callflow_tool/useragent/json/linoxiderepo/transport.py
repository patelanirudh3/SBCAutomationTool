import socket
import ssl
from sipconstants import Transport 
import time
class SignalingSocket:
    
    def __init__(self, localip, localport, remoteip, remoteport, transtype:Transport) -> None:
        self.__rcvdBuffer = 2056        
        self.__remoteIP = remoteip
        self.__remotePort = 5061 if transtype == Transport.TLS.value else 5060
        self.__localIP = localip
        self.__localPort = localport
        self.__ephemeralPort = 5060
        self.__transType = transtype
        self.__rcvdAddr = None
        self.__clientSockId = socket.socket(socket.AF_INET,socket.SOCK_STREAM) if transtype in [Transport.TCP.value, Transport.TLS.value] else socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.__serverSockId = socket.socket(socket.AF_INET,socket.SOCK_STREAM) if transtype in [Transport.TCP.value, Transport.TLS.value] else socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.__ssl_clientsockId = None
        self.__connId =  None
        self.__connReset = False
        self.__stopRecv = False
        
    def setEphemeralPort(self, port):
        self.__ephemeralPort = port

    def getEphemeralPort(self):
        return self.__ephemeralPort

    def getRcvdAddress(self):
        return self.__rcvdAddr
    
    def connect(self):
        if self.__transType == Transport.TCP.value:
            # local_address = self.getLocalAddress()
            # self.__clientSockId.bind(local_address)
            self.__clientSockId = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            try:
                remote_address = (self.__remoteIP, self.__remotePort)
                self.__clientSockId.connect(remote_address)
                host, port = self.__clientSockId.getsockname()
                print("***connected socket address", (host, port))
                self.__ephemeralPort = port
                return True
            except Exception as e:
                print("***connection failed as",e)
                self.__clientSockId.close()
                print("***closed socket before retry")
        elif self.__transType == Transport.TLS.value:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            # require a certificate from the server
            self.__ssl_clientsockId = ssl.wrap_socket(s,cert_reqs=ssl.CERT_NONE)
            remote_address = (self.__remoteIP, self.__remotePort)
            self.__ssl_clientsockId.connect(remote_address)
            host, port = self.__ssl_clientsockId.getsockname()
            print("***connected socket address", (host, port))
            self.__ephemeralPort = port

            # context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
            # context.load_verify_locations('/etc/ssl/certs/ca-certificates.crt')
            # self.__ssl_clientsockId = context.wrap_socket(self.__clientSockId, server_hostname=self.__remoteIP)
            # remote_address = (self.__remoteIP, self.__remotePort)
            # self.__ssl_clientsockId.connect(remote_address)
            # host, port = self.__ssl_clientsockId.getsockname()
            # print("***connected socket address", (host, port))
            # # self.__ephemeralPort = port

            return True
        elif self.__transType == Transport.UDP.value:
            pass

    def reConnect(self):
        if self.__clientSockId:
            self.__clientSockId.close()
        self.__clientSockId = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        stop_time = time.time() + 30
        result = True
        while True:
            if time.time() >= stop_time:
                return False
            if self.__transType == Transport.TCP.value:
                # local_address = self.getLocalAddress()
                # self.__clientSockId.bind(local_address)
                try:
                    remote_address = (self.__remoteIP, self.__remotePort)
                    self.__clientSockId.connect(remote_address)
                    host, port = self.__clientSockId.getsockname()
                    print("***connected socket address", (host, port))
                    self.__ephemeralPort = port
                    self.setRemoteConnResumed()
                    return True
                except Exception as e:
                    print("***Client request failed as", e)
                    continue
            elif self.__transType == Transport.UDP.value:
                pass

    def sendMessage(self, message:str, isRequest = True):
        print("***In sendMessage*******")
        time.sleep(0.5)
        
        if self.__transType == Transport.TCP.value:
            ret_code = True
            try:
                print ("Sending Message %s" % message)                
                # print(message)
                message = message.encode('utf-8')
                if isRequest:
                    if self.__clientSockId:
                        print("****sending from client socket", self.__clientSockId.getsockname())
                        self.__clientSockId.sendall(bytes(message))
                        print("****message sent")
                else:
                    print("~~~~~~~~~~ CONN ID~~~~", self.__connId)
                    if self.__connId:
                        print("****sending from server_connection")
                        self.__connId.send(bytes(message))
                        print("****message sent")
                
                # print("=====send Success!") 
            except socket.error as e:
                print ("Socket error: %s" %str(e))
                ret_code = self.reConnect()
                if ret_code:
                    self.__clientSockId.sendall(bytes(message))
                    print("****message sent")
            except Exception as e:
                print ("Socket exception: %s" %str(e))
                ret_code = False
            return ret_code
        elif self.__transType == Transport.TLS.value:
            message = message.encode('utf-8')
            self.__ssl_clientsockId.sendall(bytes(message))
        elif self.__transType == Transport.UDP.value:
            pass
        
    def closeSocket(self):
        self.__clientSockId.close()
        self.__serverSockId.close()

    def closeClientSocket(self):
        self.__clientSockId.close()

    def closeServerSocket(self):
        self.__serverSockId.close()

    def getClientSockId(self):
        if self.__transType == Transport.TCP.value:
            return self.__clientSockId
        elif self.__transType == Transport.TLS.value:
            return self.__ssl_clientsockId
    
    def getServerSockId(self):
        return self.__serverSockId
    
    def setConnectionId(self, conn_id):
        self.__connId = conn_id

    def getConnectionId(self):
        return self.__connId

    def getLocalAddress(self):
        return (self.__localIP, self.__localPort)

    def setRemoteConnReset(self):
        self.__connReset = True

    def setRemoteConnResumed(self):
        self.__connReset = False

    def isRemoteConnReset(self):
         return  self.__connReset

    def setStopRecv(self, value:bool):
        self.__stopRecv = value

    def isStopRecv(self):
        return self.__stopRecv
 

    
    
        
