from flask import render_template, Flask, request, jsonify
import  re
import json
import paramiko
import random
import time
import os
import importlib
import sys
import threading
import DBoperation
from flask_cors import CORS
import ReportingMechanismFile
import importlib.util
from ServiceExecutor import ConfigApiExecutor
spec = importlib.util.spec_from_file_location("config", sys.argv[1])
foo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(foo)
config = foo


PROXYDEVICES = ["SBC", "SM", "CM", "IPO"]
USERAGENTS = [ "A_ext", "B_ext", "C_ext", "A_rw", "B_rw", "C_rw","A_int", "B_int", "C_int", "A_EXT", "B_EXT", "C_EXT", "A_RW", "B_RW", "C_RW","A_INT", "B_INT", "C_INT","A_ext", "B_ext", "C_ext", "A_cs", "A_CS", "B_cs", "B_CS", "A_rw", "B_rw", "C_rw","A_int", "B_int", "C_int", "a_ext", "b_ext", "c_ext", "a_rw", "b_rw", "c_rw","a_int", "b_int", "c_int"]

KEYLIST = ["event", "method","direction","dialogid" ,"isOOD","hascontent","hascontentchanged","targetnodenames","mediadirection","nextnode", "INS_HDR", "REP_HDR", "REM_HDR", "REP_REQURI", "REM_REQURIPARAM", "INS_SDPMLINE", "INS_SDPSESSATTR", "audiocodecs", "EXP_HDR", "EXP_HDRVALUE", "EXP_REQURI", "EXP_REQURIPARAM", "SLEEP_TIMER", "transfertarget", "hasreplaces"]
app = Flask(__name__, static_folder="/home/pgokhe/venv/callflow/js-sequence-diagrams-master" ,template_folder="/home/pgokhe/venv/callflow/js-sequence-diagrams-master")
CORS(app)
#node ounters
EXT_CNT = 0
INT_CNT = 0
RW_CNT = 0
CS_CNT = 0
CALLFLOW = ""

##VM details
EXT_VM_IP = "10.133.48.63"
EXT2_VM_IP="10.133.48.64"
INT_VM_IP = "10.133.48.63"
INT2_VM_IP="10.133.48.64"
RW_VM_IP =  "10.133.48.63"
RW2_VM_IP = "10.133.48.64"
RW3_VM_IP = "10.133.48.65"
REMOTEJSONPATH = "/root/useragent/json/"            #this will be common on all the n
USERAGENTPATH = "/root/useragent/json/linoxiderepo/useragent.py"
CONFIGJSONPATHMASTER = "/root/JSON/SBC/"
CONFIGJSONPATHTMP = "/root/JSON/TMP/"

EXTJSON = "ext.json"
INTJSON = "int.json"
RWJSON = "rw.json"
RW2JSON = "rw2.json"
OUTBOUNDIP = "10.133.60.65"
SBCEXTIP = "10.133.60.65"
EXTTRKIP = "10.133.60.65"
SMIP = "192.168.1.80"
IPOIP = "x.y.z.w"
EXTNRW_1 = "4441000024"
EXTNRW_2 = "4441000025"
EXTNRW_3 = "9006"
EXTNINT_1 = "7001"
EXTNINT_2 = "7002"
EXTNINT_3 = "7003"
EXTNEXT_1 = "6002"
EXTNEXT_2 = "6003"
EXTNEXT_3 = "6006"
GLOBALDOMAIN = "sbcsv.com"
callidRW1 = "1234avaya"
callidRW2 = "3456cisco"
################################################################################################################
def getOutboundIp(usertype):
        if(usertype == "RW"):
                return config.SBCRWINTERFACE
        elif(usertype == "EXT"):
                return config.SBCEXTINTERFACE
        elif(usertype == "INT"):
                return config.SMIP
        elif(usertype == "CS"):
                return config.SBCCSINTERFACE

def getExtnname(type, count):
        if(type == "RW"):
                if(count == 1):
                        return config.RW_USER_1
                elif(count == 2):
                        return config.RW_USER_2
                elif(count == 3):
                        return config.RW_USER_3
        if (type == "EXT"):
                if (count == 1):
                        return config.TRK_USER_1
                elif (count == 2):
                        return config.TRK_USER_2
                elif (count == 3):
                        return config.TRK_USER_3
        if (type == "INT"):
                if (count == 1):
                        return config.INT_USER_1
                elif (count == 2):
                        return config.INT_USER_2
                elif (count == 3):
                        return config.INT_USER_3
        if (type == "CS"):
                if (count == 1):
                        return config.CS_USER_1
                elif (count == 2):
                        return config.CS_USER_2

def getDisplayName(type, count):
        if(type == "RW"):
                if(count == 1):
                        return config.DISPLAY_RW_1
                elif(count == 2):
                        return config.DISPLAY_RW_2
                elif(count == 3):
                        return config.DISPLAY_RW_3
        if (type == "EXT"):
                if (count == 1):
                        return config.DISPLAY_EXT_1
                elif (count == 2):
                        return config.DISPLAY_EXT_2
                elif (count == 3):
                        return config.DISPLAY_EXT_3
        if (type == "INT"):
                if (count == 1):
                        return config.DISPLAY_INT_1
                elif (count == 2):
                        return config.DISPLAY_INT_2
                elif (count == 3):
                        return config.DISPLAY_INT_3
        if (type == "CS"):
                if (count == 1):
                        return config.DISPLAY_CS_1
                elif (count == 2):
                        return config.DISPLAY_CS_2

def generateCallid():
        num_digits = 7
        lower = 10 ** (num_digits - 1)
        upper = 10 ** num_digits - 1
        return random.randint(lower, upper)
        pass

def copyJsonToVM(filename, hostname):        #type can be ext, int,rw
        ssh_client = paramiko.SSHClient()
        ssh_client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        ssh_client.connect(hostname= hostname, username ="root", password = "SIPera_123")
        ftp_client = ssh_client.open_sftp()
        ftp_client.put(filename, REMOTEJSONPATH+filename)
        ftp_client.close()

def getVMIP(user_type, localcounter):
        if(user_type == "RW"):
                if(localcounter == 1):
                        return config.RW1_VM_IP
                elif(localcounter == 2):
                        return config.RW2_VM_IP
                elif(localcounter == 3):
                        return config.RW3_VM_IP
        elif(user_type == "INT"):
                if (localcounter == 1):
                        return config.INT1_VM_IP
                elif (localcounter == 2):
                        return config.INT2_VM_IP
                elif (localcounter == 3):
                        return config.INT3_VM_IP
        elif (user_type == "EXT"):
                if (localcounter == 1):
                        return config.EXT1_VM_IP
                elif (localcounter == 2):
                        return config.EXT2_VM_IP
                elif (localcounter == 3):
                        return config.EXT3_VM_IP
        elif (user_type == "CS"):
                if (localcounter == 1):
                        return config.CS1_VM_IP
                elif (localcounter == 2):
                        return config.CS2_VM_IP

def getPrivateIP(user_type, localcounter):
        if (user_type == "INT"):
                if (localcounter == 1):
                        return config.INT1_PRIVATE_IP
                elif (localcounter == 2):
                        return config.INT2_PRIVATE_IP
                elif (localcounter == 3):
                        return config.INT3_PRIVATE_IP
        elif (user_type == "CS"):
                if (localcounter == 1):
                        return config.CS1_PRIVATE_IP
                elif (localcounter == 2):
                        return config.CS2_PRIVATE_IP

def find_count_clients(callflow_str):
        client_list = []
        for line in callflow_str.splitlines():
                if(line != ""):
                        parts = re.split(":", line)
                        parts = re.split("->", parts[0])
                        #print(parts)
                        for i in parts:
                                if i not in PROXYDEVICES + client_list:
                                        client_list.append(i)

        return (client_list, len(client_list))
        pass
##########################################################
def FindsLineRequiredforNode(NodeName, callflow_str):
        global CALLFLOW
        CALLFLOW =  callflow_str
        related_lines = []
        
        for line in callflow_str.splitlines():
                if(line != ""):
                        parts = re.split(":", line)     #parts[0] is in format A->B , parts[1] is messege like INVITE,180etc
                        flow = re.split("->", parts[0])
                        if (NodeName in flow and NodeName not in PROXYDEVICES):
                                related_lines.append(line)

        return  related_lines
        pass

####################################################################
def findTargetNodeNames(nextLines, MyNodeName, MyMethod):
        print("findTargetNodeName")
        print(nextLines)
        print(MyNodeName)
        print(MyMethod)
        targets = []            #this is targetNode that is target phone type
        nextNode = []           #this should always be SBC/SM/IPO
        for line in nextLines:
                if (MyNodeName not in line):
                        print("the target is hidden in the ", line)
                        parts = re.split(":", line)
                        nodes = re.split("->", parts[0])
                        if(nodes[0] in PROXYDEVICES):
                                if(nodes[1] in USERAGENTS):
                                        targets.append(nodes[1])
                                nextNode.append(nodes[0])

        print("target for "+MyNodeName + " "+ MyMethod )
        print(targets)

        return targets, nextNode
                                
        pass
####################################################
copylocalcallflow = []
def FindTargetName(MyNodeName, myMethod, current_line):
        global copylocalcallflow
        print("callflow is")
        if(copylocalcallflow == []):
                localcallflow = CALLFLOW.splitlines()
                print("copylocalcallflow is empty")
        else:
                localcallflow = copylocalcallflow
                print("copylocalcall flow is not empty")
        print(localcallflow)

        if(current_line in localcallflow):
                index = localcallflow.index(current_line)
                desiredTargetLines = localcallflow[index+1:]
                print("DESIRED TARGET MAY BE FOUND IN ")
                print(desiredTargetLines)
                targetnames, nextnodenames = findTargetNodeNames(desiredTargetLines, MyNodeName, myMethod)
                localcallflow[index] = localcallflow[index] + "="
                print("ZZZZ")
                print(localcallflow[index])
                copylocalcallflow = localcallflow
                return targetnames, nextnodenames
                pass
        pass
#################################################
def GetInfo(data, line, NodeName):
        print("THE LINE currently being proccessed for getting data is :" + line)
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
        #####2 feb change
        met_list = met[0].strip().split("/")
        data["event"] = met_list[0].upper()

        if(len(met_list) > 2):
                data["method"] = met_list[1].upper()
                data["hascontent"] = True
        elif(len(met_list) > 1):
                if met_list[1].strip().lower() == 'sdp':
                        data["hascontent"] = True
                else:
                        data["method"] = met_list[1].upper()
        else:
                data["hascontent"] = False
        #print("HASCONTENT AND METHOD")
        #print(data["hascontent"])
        #print(data["method"])
        #data["event"] = met[0].strip().split("/")[0]

        parts = re.split("->", line)
        if(parts[0] == NodeName):
                data["direction"] = "send"
        else:
                data["direction"] = "recv"

        ###new edit 
        if(data["direction"] == "send"):
                targetnames, nextnodenames = FindTargetName(MyNodeName = NodeName, myMethod = data["event"], current_line = line)
                data["targetnodenames"] = targetnames
                '''if(targetnames[0] == "a_rw" or targetnames[0] == "A_rw"):
                        data["targetextn"] = "9001"
                elif (targetnames[0] == "b_rw" or targetnames[0] == "B_rw"):
                        data["targetextn"] = "9002"'''
                data["nextnode"] = "z" #nextnodenames[0]
        if(not data["nextnode"]):
                data["nextnode"] = ""
        ###new edit ends
        start = line.find("[") + 1
        end   = line.find("]")
        if((start != -1) and (end != -1)):
              #  parts = re.split(",", line[start:end])  commented on 7 jan
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])   #new regex used on 7jan
                x = {}
                y = {}
                z = {}
                INSHDR = []
                REPHDR = []
                REMHDR = []
                INSSDPMLINE = []
                INSSDPSESSATTR = []
                INSREQURIPARAM = []
                REMREQURIPARAM = []
                INSSDPAUDIOCODEC =[]
                EXPHDR = []
                EXPHDRVALUE = []
               # print("EEE")
                #print(parts)
                for i in parts:
                        i = i.strip()
                        print(i)
                        if ("REP_REQURI:" in i):
                                s = i.find('\"') + 1
                                e = i.rfind('\"')
                                if((s!=-1) and (e!=-1)):
                                        data["REP_REQURI"] = i[s:e]
                                else:
                                        data["REP_REQURI"] = ""
                        if("INS_HDR" in i):
                                print("HEER")
                                print(i)
                                if (i[3] == "_"):
                                        print("ALSO HEER")
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        print(s)
                                        print(e)
                                        print(k)
                                        if (s and e):
                                                print(k)
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        INSHDR.append(item)
                                        # print(x)
                                pass
                        if ("REP_HDR" in i):
                                print("REP_HDR")
                                if (i[3] == "_"):
                                        print("ALSO REP_HDR")
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        print(s)
                                        print(e)
                                        print(k)
                                        if (s and e):
                                                print(k)
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        REPHDR.append(item)
                                        # print(x)
                                pass
                        if ("REM_HDR" in i):
                                print("REM_HDR")
                                if (i[3] == "_"):
                                        print("ALSO REM_HDR")
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        print(s)
                                        print(e)
                                        print(k)
                                        if (s and e):
                                                print(k)
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        REMHDR.append(item)
                                        # print(x)
                                pass
                        if("INS_REQURIPARAM"in i):
                                print("INS_REQURIPARAM")
                                if(i[3] == "_"):
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if(s and e):
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        INSREQURIPARAM.append(item)

                                pass
                        if("REM_REQURIPARAM" in i):
                                print("REM_REQURIPARAM")
                                if (i[3] == "_"):
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s and e):
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        REMREQURIPARAM.append(item)
                                pass
                        if("INS_SDPSESSATTR" in i):
                                print("INS_SDPSESSATTR")
                                if (i[3] == "_"):
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s and e):
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        INSSDPSESSATTR.append(item)
                                pass

                        if("INS_SDPMLINE" in i):
                                if (i[3] == "_"):
                                        k = i[4:]
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s and e):
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        INSSDPMLINE.append(item)
                                              #  print(y)

                        if("INS_SDPAUDIOCODEC" in i):
                                if (i[3] == "_"):
                                        k = i[4:]
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s and e):
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        INSSDPAUDIOCODEC.append(item)

                        if("HASSDP:TRUE" in i):
                                print("If true HASSDP " + i)
                              #  data["hascontent"] = True
                        if ("HASSDPCHANGED:TRUE" in i):
                                data["hascontentchanged"] = True
                        if("isOOD:TRUE" in i):
                                data["isOOD"] = True
                        if("hasreplaces:TRUE" in i):
                                data["hasreplaces"] = True
                        if("dialogid:" in i):
                                print(i)
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                                if(s != -1 and e != -1):
                                        data["dialogid"] = k[s:e]
                        if ("MEDIADIRECTION:".lower() in i):
                                print("MEDIADIRECTION")
                                print(i)
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                                if (s !=-1 and e != -1):
                                        data["mediadirection"] = k[s:e]
                        if ("method:" in i):
                                #print("METHOD")
                                #print(i)
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                               # if (s  and e):
                                #        data["method"] = k[s:e]
                        if ("EXP_HDR:" in i):
                                print("EXP_HDR")
                                print(i)
                                if (i[3] == "_"):
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s != -1 and e != -1):
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        EXPHDR.append(item)
                        if ("EXP_HDRVALUE" in i):
                                print("EXP_HDRVALUE")
                                if (i[3] == "_"):
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s and e):
                                                a = k[s:e]
                                                a = a.replace(" ", "")
                                                subparts = a.split("|")
                                                for item in subparts:
                                                        EXPHDRVALUE.append(item)
                        if ("EXP_REQURI" in i):
                                print("EXP_REQURI")
                                if (i[3] == "_"):
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s and e):
                                                data["EXP_REQURI"] = k[s:e]
                        if ("EXP_REQURIPARAM" in i):
                                print("EXP_REQURIPARAM")
                                if (i[3] == "_"):
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if (s and e):
                                                data["EXP_REQURIPARAM"] = k[s:e]
                        if ("sleeptimer" in i):
                                print("sleeptimer")
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                                if (s != -1 and e != -1):
                                        data["SLEEP_TIMER"] = k[s:e]
                        if(data["event"] == "REFER"):
                                if("TRANSFERTARGET" in i):
                                        print("transfertarget for refer")
                                        k = i
                                        s = k.find('\"') + 1
                                        e = k.rfind('\"')
                                        if(s != -1 and e != -1):
                                                data["transfertarget"] = k[s:e]
                        print("DSDS")
                        print(x)
                        data["INS_HDR"] = INSHDR
                        data["REP_HDR"] = REPHDR
                        data["REM_HDR"] = REMHDR
                        data["INS_SDPMLINE"] = INSSDPMLINE
                        data["INS_SDPSESSATTR"] = INSSDPSESSATTR
                        data["INS_REQURIPARAM"] = INSREQURIPARAM
                        data["REM_REQURIPARAM"] = REMREQURIPARAM
                        data["audiocodecs"] = INSSDPAUDIOCODEC
                        data["EXP_HDR"] = EXPHDR
                        data["EXP_HDRVALUE"] = EXPHDRVALUE
                        if("" in INSHDR):
                                data["INS_HDR"] = []
                        if ("" in REPHDR):
                                data["REP_HDR"] = []
                        if ("" in REMHDR):
                                data["REM_HDR"] = []
                        if ("" in INSSDPMLINE):
                                data["INS_SDPMLINE"] = []
                        if ("" in INSSDPSESSATTR):
                                data["INS_SDPSESSATTR"] = []
                        if ("" in INSREQURIPARAM):
                                data["INS_REQURIPARAM"] = []
                        if ("" in REMREQURIPARAM):
                                data["REM_REQURIPARAM"] = []
                        if ("" in EXPHDR):
                                data["EXP_HDR"] = []
                        if ("" in EXPHDRVALUE):
                                data["EXP_HDRVALUE"] = []
                        if ("" in INSSDPAUDIOCODEC):
                                data["audiocodecs"] = []
                        if(data["mediadirection"] == None):
                                data["mediadirection"] = ""
                        if(data["EXP_REQURI"] == None):
                                data["EXP_REQURI"] = ""
                        if(data["EXP_REQURIPARAM"] == None):
                                data["EXP_REQURIPARAM"] = []
                        if(data["SLEEP_TIMER"] == None):
                                data["SLEEP_TIMER"] = "0"
                        if (data["transfertarget"] == None):
                                data["transfertarget"] = ""
                        pass
        elif((start == -1) or (end == -1)):
                data["INS_HDR"] = []
                data["REP_HDR"] = []
                data["REM_HDR"] = []
                data["INS_SDPMLINE"] = []
                data["INS_SDPSESSATTR"] = []
                data["INS_REQURIPARAM"] = []
                data["REP_REQURI"] = ""
                data["REM_REQURIPARAM"] = []
                data["audiocodecs"] = []
               # data["hascontent"] = False
                data["hascontentchanged"] = False
                data["isOOD"] = False
                data["hasreplaces"] = False
                data["mediadirection"] = ""
                data["EXP_HDR"] = []
                data["EXP_HDRVALUE"] = []
                data["EXP_REQURI"] = ""
                data["EXP_REQURIPARAM"] = ""
                data["SLEEP_TIMER"] = "0"
                data["transfertarget"] = ""
        if(data["dialogid"] == None):
                data["dialogid"] = ""#generateCallid()
        if (data["mediadirection"] == None):
                data["mediadirection"] = ""
        if (data["hascontentchanged"] == None):
                data["hascontentchanged"] = False
       # if (data["hascontent"] == None):
        #        data["hascontent"] = False
        if(data["isOOD"] == None):
                data["isOOD"] = False
        if(data["hasreplaces"] == None):
                data["hasreplaces"] = False
        if (data["method"] == None):
                data["method"] = ""
        if(data["SLEEP_TIMER"] == None):
                data["SLEEP_TIMER"] = "0"
        if(data["transfertarget"] == None):
                data["transfertarget"] = ""
        return  data
        pass
##################################################
def GetInfoaboutAllows(data, line, NodeName, Dict):
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
        #data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        if (start and end):
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                for i in parts:
                        if ("allow" in i):
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                                if (s and e):
                                        print("ALLOW "+k[s:e])
                                        return k[s:e]
        return ""
        pass


def GetInfoaboutreliable(data, line, NodeName, Dict):
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
        #data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        print("DICT")
        print(Dict)
        if (start and end):
                #  parts = re.split(",", line[start:end])  commented on 7 jan
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                print (parts)
                print("UUUU")
                print(Dict.get("isreliable"))
                if ("isreliable:true" in parts  or Dict.get("isreliable") == True):
                        print("IsReliable")
                    #    print(parts)
                        return True
                      #  print("IsReliable")
                      #  print(parts)
                #if (Dict["isreliable"] == True):
                 #       return True

        return False
        pass


def GetInfoAboutTransport(data, line, NodeName, Dict):
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
        #data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        print("DICT")
        print(Dict)
        if (start and end):
                #  parts = re.split(",", line[start:end])  commented on 7 jan
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                print (parts)
                print("UUUU")
                print(Dict.get("transport"))
                if ("transport:udp" in parts  or Dict.get("transport") == "udp"):
                        print("TransType is UDP")
                        print(parts)
                        return "udp" 
                elif ("transport:tls" in parts  or Dict.get("transport") == "tls"):
                        print("TransType is TLS")
                        print(parts)
                        return "tls"
                else:
                        return "tcp"

        return "tcp"
           




###SRTP
def GetInfoaboutSRTP(data, line, NodeName, Dict):
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
        #data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        print("DICT")
        print(Dict)
        if (start and end):
                #  parts = re.split(",", line[start:end])  commented on 7 jan
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                print (parts)
                print("UUUU")
                print(Dict.get("issrtp"))
                if ("isSrtp:TRUE" in parts  or Dict.get("issrtp") == True):
                        print("IsSrtp")
                    #    print(parts)
                        return True
                      #  print("IsReliable")
                      #  print(parts)
                #if (Dict["isreliable"] == True):
                 #       return True

        return False
        pass
####

def GetInfoaboutfeaturetag(data, line, NodeName, Dict):
        print("~~~~~~~~PRINTING LINE~~~~", line)
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
       # data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        if (start and end):
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                print("############################################", parts)
                for i in parts:
                        if("featuretags" in i):
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                                if (s and e):
                                        print("FEATURE TAG "+ k[s:e])
                                        return k[s:e]
        return ""
        pass


def GetInfoAboutClientTimeOut(data, line, NodeName, Dict):
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
       # data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        if (start and end):
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                for i in parts:
                        if("clienttimeout" in i):
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                                if (s and e):
                                        print("CLIENT TIMEOUT "+ k[s:e])
                                        return k[s:e]
        return ""
        pass



def GetInfoAboutTimeLapseBeforeBye(data, line, NodeName, Dict):
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
       # data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        if (start and end):
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                for i in parts:
                        if("timelapsebeforebye" in i):
                                k = i
                                s = k.find('\"') + 1
                                e = k.rfind('\"')
                                if (s and e):
                                        print("TIME LAPSE BEFORE BYE "+ k[s:e])
                                        return k[s:e]
        return ""
        pass











def GetTrasnport(data, line, NodeName):
        parts = re.split(":", line)
        met = re.split(r"\[", parts[1])
       # data["event"] = met[0]
        parts = re.split("->", line)
        start = line.find("[") + 1
        end = line.find("]")
        if (start and end):
                parts = re.split(",(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)", line[start:end])
                for i in parts:
                        if ("transport:tls" in i):
                                return "tls"
                        elif("transport:UDP" in i):
                                return "udp"
                        else:
                                return "tcp"


def MakeDictionaryWithInfo(NodeName, related_lines):
        seq_count = 0
        Dict = {}
        global  EXT_CNT, INT_CNT, RW_CNT, CS_CNT
        print("MakeDictionaryWithInfo")
        print("LINES RELATED TO " + NodeName + " ARE " + str(related_lines))
        if(NodeName[-3:] == "ext" or NodeName[-3:] == "EXT"):
                print("WE ARE ALLOCATIONG EXTENSION TO EXT")
                Dict["type"] = "EXT"
                EXT_CNT = EXT_CNT + 1
                Dict["extn"] = getExtnname(Dict["type"], EXT_CNT)
                Dict["displayname"] = getDisplayName(Dict["type"], EXT_CNT)
                Dict["domain"] = config.GLOBALDOMAIN
                Dict["outboundip"] = getOutboundIp(Dict["type"])
        elif (NodeName[-3:] == "int" or NodeName[-3:] == "INT"):
                print("WE ARE ALLOCATIONG EXTENSION TO INT")
                Dict["type"] = "INT"
                INT_CNT = INT_CNT + 1
                Dict["extn"] = getExtnname(Dict["type"], INT_CNT)
                Dict["displayname"] = getDisplayName(Dict["type"], INT_CNT)
                Dict["domain"] = config.GLOBALDOMAIN
                Dict["outboundip"] = getOutboundIp(Dict["type"])
        elif (NodeName[-2:] == "rw" or NodeName[-2:] == "RW"):
                print("WE ARE ALLOCATIONG EXTENSION TO RW")
                Dict["type"] = "RW"
                RW_CNT = RW_CNT + 1
                Dict["extn"] = getExtnname(Dict["type"], RW_CNT)
                Dict["displayname"] = getDisplayName(Dict["type"], RW_CNT)
                Dict["domain"] = config.GLOBALDOMAIN
                Dict["outboundip"] = getOutboundIp(Dict["type"])
        elif (NodeName[-2:] == "cs" or NodeName[-2:] == "CS"):
                print("WE ARE ALLOCATIONG EXTENSION TO CS")
                Dict["type"] = "CS"
                CS_CNT = CS_CNT + 1
                Dict["extn"] = getExtnname(Dict["type"], CS_CNT)
                Dict["displayname"] = getDisplayName(Dict["type"], CS_CNT)
                Dict["domain"] = config.GLOBALDOMAIN
                Dict["outboundip"] = getOutboundIp(Dict["type"])

        for line in related_lines:
                data_for_node = {key: None for key in KEYLIST}
                print("QQQ")
               # print(data_for_node)
                #Dict["transport"] = GetTrasnport(data_for_node, line, NodeName)
                data_for_node = GetInfo(data_for_node, line, NodeName)
                if not Dict.get("allowmethods"):
                        Dict["allowmethods"] = GetInfoaboutAllows(data_for_node, line, NodeName, Dict)
                if not Dict.get("featuretags"):
                        Dict["featuretags"] = GetInfoaboutfeaturetag(data_for_node, line, NodeName, Dict)
                if not Dict.get("clienttimeout"):
                        Dict["clienttimeout"] = GetInfoAboutClientTimeOut(data_for_node, line, NodeName, Dict)
                if not Dict.get("timelapsebeforebye"):
                        Dict["timelapsebeforebye"] = GetInfoAboutTimeLapseBeforeBye(data_for_node, line, NodeName, Dict)
                if not Dict.get("transport"):
                        Dict["transport"] = GetInfoAboutTransport(data_for_node, line, NodeName, Dict)
                if(Dict.get("isreliable") != True):
                        Dict["isreliable"] = GetInfoaboutreliable(data_for_node, line, NodeName, Dict)
                if(Dict.get("issrtp") != True):
                        Dict["issrtp"] = GetInfoaboutSRTP(data_for_node, line, NodeName, Dict)
                #print("PPPPPPP")
                print(Dict["isreliable"])
                Dict[seq_count] = data_for_node
                seq_count = seq_count + 1
        print("^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",Dict)
        return Dict
        #print(Dict)
            
        pass
###################################################
def processNode(NodeName, callflow_str):
        lines_related_to_node = FindsLineRequiredforNode(NodeName, callflow_str)

        if (len(lines_related_to_node) > 0):
                nodeDict = MakeDictionaryWithInfo(NodeName, lines_related_to_node)
                return nodeDict
                pass
        else:
                print("Node "+ NodeName +" has no related flow in diagram" )
        pass
#########################################################
mapipPid = {}
def killUA():
        for ip in mapipPid:
                pid = mapipPid[ip]
                client = paramiko.SSHClient()
                client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                client.connect(ip, username="root", password="SIPera_123")
                cmd = f'kill -9 {pid}'
                stdin, stdout, stderr = client.exec_command(cmd)
                client.close()

def executeApps(UAnodes, mapNodeIP):
        print(mapNodeIP)
#start the timer

        t_start = time.time()
        timeout = 300   #CONFIG TIMEOUT
        while(1):
               # if(time.time() > t_start+timeout):

                        #killUA()
                #        break
                sleepduration = 1
                for i in UAnodes:

                        print("executeApps+++++++++")
                        print(i)
                        print(mapNodeIP[i])
                        client = paramiko.SSHClient()
                        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
                        client.connect(mapNodeIP[i][0], username="root", password="SIPera_123")
                        #stdin, stdout, stderr = client.exec_command("killall python3")
                        stdin, stdout, stderr = client.exec_command("killall python3; nohup python3 "+ USERAGENTPATH + " " + mapNodeIP[i][1] + " >/dev/null 2>&1")
                        #stdin, stdout, stderr = client.exec_command("python3 " + USERAGENTPATH + " " + mapNodeIP[i] + " -bg")
                        print("EXECUTED")
                        #print(stdout)
                        #res = stdout.read().decode('ascii').strip()
                        pid = 2#int(res.split('[')[-1].split(']')[0])
                    #    mapipPid[mapNodeIP[i]] = pid
                        #print(stderr)

                        #stdin, stdout, stderr = client.exec_command('python3 /root/useragent/json/linoxiderepo/useragent.py '+mapNodeIP[i])
                        #for line in stdout:
                                #print(line.strip('\n'))
                        client.close()
                        time.sleep(sleepduration)
                        sleepduration += 1
                break
        pass

def procRequest(callflow_str):
        configsbc()
        processCallflow(callflow_str)
        #monitorclient() once done
        insertinDB(callflow_str, config)
        rollbacksbc()
        testreporting()
        pass
def processCallflow(callflow_str):
        global copylocalcallflow
        copylocalcallflow = []
        #callflow_str = callflow_str.upper()
        callflow_str = callflow_str.replace(" ", "")
        clients, number_of_clients = find_count_clients(callflow_str)
        NodeInfo = {}
        mapNodeVm = {}                  #this will store nodename:VMIP
        global EXT_CNT, INT_CNT, RW_CNT, CS_CNT
        EXT_CNT = 0
        INT_CNT = 0
        RW_CNT = 0
        CS_CNT = 0
        print("NUMBER OF NODES is "+ str(number_of_clients))
        print(clients)
        for i in clients:
                NodeInfo[i] = processNode(i, callflow_str)


        print("JJJJ")
     #   print(NodeInfo)
        for j in NodeInfo:
                #Len = j.len()
                for x in NodeInfo[j]:
                        print("KKKKK")
                       # print(NodeInfo[j])
                        #print(x)
                        if(x not in ["type", "extn", "domain", "transport", "allowmethods", "isreliable", "featuretags", "outboundip", "displayname", "issrtp","clienttimeout","timelapsebeforebye"]):
                               if(NodeInfo[j][x]["direction"] == "send"):
                                 #      print(NodeInfo[j][x]["event"])
                                 #      print(NodeInfo[j][x])
                                       print("SDSDSD")
                                       if(len(NodeInfo[j][x]["targetnodenames"]) > 0 ):
                                               tname = NodeInfo[j][x]['targetnodenames'][0]
                                               NodeInfo[j][x]['targetextn'] = NodeInfo[tname]["extn"]
                                       if(NodeInfo[j][x]["event"] == "REFER"):
                                               print("HEEELO")
                                               tname = NodeInfo[j][x]['transfertarget']
                                              # print(NodeInfo[j][x])
                                               print(tname)
                                               if(tname == ""):
                                                       tname = "C_RW"
                                               if(NodeInfo[tname]):
                                                        NodeInfo[j][x]['targetextn'] = NodeInfo[tname]["extn"]
                                        #print(NodeInfo[tname])
                                        #print(NodeInfo[j][x]['targetnodenames'][0])
                               #print(NodeInfo[j][x])

                pass
        for j in NodeInfo:
                for x in NodeInfo[j]:
                        if (x not in ["type", "extn", "domain", "transport", "allowmethods", "isreliable", "featuretags", "outboundip", "displayname", "issrtp","clienttimeout","timelapsebeforebye"]):
                                del NodeInfo[j][x]['targetnodenames']
                                del NodeInfo[j][x]['nextnode']
	    ###     determine sequence start
        clientNodes = []
        serverNodes = []
        for j in NodeInfo:
                value = NodeInfo.get(j)
                print("YOGESH")
             #   print(value)

                # Len = j.len()
                if (value[0]["direction"] == "send"):
                        clientNodes.append(j)
                else:
                        serverNodes.append(j)
        print("+++clientNode")
        print(clientNodes)
        print("+++serverNode")
        print(serverNodes)
        serverNodes.extend(clientNodes)

        print("+++UAnodes")
        print(serverNodes)
	    ###     determine sequence ends
        localcounter_rw = 1
        localcounter_int = 1
        localcounter_ext = 1
        localcounter_cs = 1
        print(clients)
        for i in clients:
                if("_ext" in i or "_EXT" in i):  #write to to ext.json
                        print("+++++++++++++++++++++")
                        filname = f'ext{localcounter_ext}.json'
                        with open(filname, 'w') as f:
                                json.dump({i: NodeInfo[i]}, f, indent=4)
                                remotevm_ip = getVMIP("EXT", localcounter_ext)
                                print(remotevm_ip)
                        copyJsonToVM(filname, remotevm_ip)
                        mapNodeVm[i] = [remotevm_ip, remotevm_ip]
                        localcounter_ext = localcounter_ext + 1
                        pass
                elif("_cs" in i or "_CS" in i):  #write to int.json
                        print("+++++++++++++++++++++")
                        filname = f'cs{localcounter_cs}.json'
                        with open(filname, 'w') as f:
                                json.dump({i: NodeInfo[i]}, f, indent=4)
                                remotevm_ip = getVMIP("CS", localcounter_cs)
                                print(remotevm_ip)
                        copyJsonToVM(filname, remotevm_ip)
                        nattedIP = getPrivateIP("CS", localcounter_cs)
                        mapNodeVm[i] = [remotevm_ip, nattedIP]
                        #mapNodeVm[i] = getNatted
                        localcounter_cs = localcounter_cs + 1
                        pass
                elif("_int" in i or "_INT" in i):  #write to int.json
                        print("+++++++++++++++++++++")
                        filname = f'int{localcounter_int}.json'
                        with open(filname, 'w') as f:
                                json.dump({i: NodeInfo[i]}, f, indent=4)
                                remotevm_ip = getVMIP("INT", localcounter_int)
                                print(remotevm_ip)
                        copyJsonToVM(filname, remotevm_ip)
                        nattedIP = getPrivateIP("INT", localcounter_int)
                        mapNodeVm[i] = [remotevm_ip, nattedIP]
                        #mapNodeVm[i] = getNatted
                        localcounter_int = localcounter_int + 1

                        pass
                elif("_rw" in i or "_RW" in i):   #write to rw.json

                        print("+++++++++++++++++++++")
                        filname= f'rw{localcounter_rw}.json'
                        with open(filname, 'w') as f:
                             json.dump({i:NodeInfo[i]}, f, indent=4)
                             remotevm_ip = getVMIP("RW",localcounter_rw)
                             print(remotevm_ip)
                        copyJsonToVM(filname, remotevm_ip)
                        mapNodeVm[i] = [remotevm_ip, remotevm_ip]
                        localcounter_rw = localcounter_rw + 1
                        pass

        executeApps(serverNodes, mapNodeVm)
        print("NODE INFO is")
        print(json.dumps(NodeInfo, indent=4))


@app.route('/', methods=["GET", "POST"])
def button():
        global config
        arr = os.listdir("/root/JSON/SBC/")
        name = request.get_json()
        print(type(name))
        if (name):
                #copyJsonToVM(hostname="10.133.48.63")
               # CONFIGSBC()
                if (name['temp_controller_config'] != ""):
                        with open("temp_config.py", "w+") as f:
                                f.write(name['temp_controller_config'])
                        spec = importlib.util.spec_from_file_location("temp_config", location="temp_config.py")
                        foo = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(foo)
                        config = foo

                else:
                        spec = importlib.util.spec_from_file_location("config", location=sys.argv[1])
                        foo = importlib.util.module_from_spec(spec)
                        spec.loader.exec_module(foo)
                        config = foo
                print(config.RW3_VM_IP)
                configsbc()
                processCallflow(name['ajson'])
                rollbacksbc()
        return render_template("index_js.html", configfiles=arr)

def configsbc():
        print("Configuring sbc based on /root/JSON/TMP directory")
        arr = os.listdir("/root/JSON/TMP/")
        if(arr == []):
                print("no need to configure tmp directory is empty")
        else:
                config_api_exe = ConfigApiExecutor()
                result = config_api_exe.execute(CONFIGJSONPATHTMP)
                if(result == 1):
                        print("CONFIGURATION SUCCESSFUL")
                else:
                        print("CONFIG failed")
        pass
def rollbacksbc():
        print("ROLLING BACK configuration as testcase is executed")
        arr = os.listdir("/root/JSON/TMP/")
        if(arr == []):
                print("No need to rollbalck as tmp is empty")
        else:
                config_api_exe = ConfigApiExecutor()
                result = config_api_exe.execute(CONFIGJSONPATHMASTER)
                if(result == 1):
                        print("ROLLING BACK successful")
                else:
                        print("ROLLBACK FAILED")
        pass

@app.route('/background_process_test', methods=["GET", "POST"])
def background_process_test():
        print("Doing SBCE configuration in background")
        master_file_name_token = request.args.get('que_token', '')

        print(master_file_name_token)
        filename = CONFIGJSONPATHMASTER + master_file_name_token
        with open(filename, 'r') as f:
                main_copy_text = f.read()
        return jsonify({"var": main_copy_text})


@app.route("/savejsontotemp", methods=['GET', 'POST'])
def savejsontotemp():
        newcontent = request.args.get('newconfig_temp', '')
        masterfilename = request.args.get('masterfilename', '')
        tempfilename =  masterfilename
        print(masterfilename)
        filename = CONFIGJSONPATHTMP + tempfilename
        with open(filename, "w") as f:
                f.write(newcontent)
        print(newcontent)
        return jsonify({"response": "OK"})

@app.route("/savetestcasetoDB", methods=["GET", "POST"])
def savetestcasetoDB():
        testdesc = request.args.get('test_description', '')
        call_str = request.args.get('call_str', '')
        call_str = call_str.replace(" ", "")
        print(testdesc)
        DBoperation.insertinDB(call_str, testdesc)
        return jsonify({"response": "OK"})
        pass
if __name__ == '__main__':
        import socket
        host = config.CONTROLLERIP
        port = 7000
        # If CONTROLLERIP is not valid on this machine (e.g. lab IP on a laptop), bind to localhost
        try:
                s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s.bind((host, 0))  # port 0 = just check if host is valid
                s.close()
        except OSError:
                if host != "127.0.0.1":
                        print("Binding to %s not valid on this host. Using 127.0.0.1 for local access." % host)
                        host = "127.0.0.1"
                else:
                        raise
        app.run(host=host, port=port)
