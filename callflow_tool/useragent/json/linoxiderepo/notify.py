from sipconstants import CRLF, SipHeaders
import parserandbuilder
import util
import copy

        
def handleNotify(obj, data):
    data = data.split(CRLF+CRLF)
    sig_msg = data[0]
    content_msg = data[1]
    notify = parserandbuilder.parseHeaders(sig_msg)
    notify_200 = copy.deepcopy(notify)
    respline = f'SIP/2.0 200 OK'
    notify_200.setResponseLine(respline)
    my_ip = util.getMyHostIP()
    contact_hdr = f'sip:3000100@{my_ip}'
    notify_200.replaceHeader(SipHeaders.CONTACT.value, contact_hdr)
    raw_msg = parserandbuilder.buildMessage(notify_200, "")
    sock_obj = obj.getSigSocket()
    sock_obj.sendMessage(raw_msg)
    
    
            
    