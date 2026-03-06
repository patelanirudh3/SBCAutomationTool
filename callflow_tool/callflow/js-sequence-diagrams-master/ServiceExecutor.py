import glob
import json
import os
import sys
import requests
import urllib3
from requests.auth import HTTPBasicAuth

import importlib.util
spec = importlib.util.spec_from_file_location("config", sys.argv[1])
foo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(foo)
con = foo
SBCE_FQDN = con.SBC_MANAGEMENT_IP
AUTH_CREDENTIALS = con.SBC_CONFIG_API_CREDENTIALS
TEMP_FILE_PATH = con.CONFIGJSONPATHTMP
#from con import SBC_MANAGEMENT_IP as SBCE_FQDN
#from con import SBC_CONFIG_API_CREDENTIALS as AUTH_CREDENTIALS
#from con import CONFIGJSONPATHTMP as TEMP_FILE_PATH

from urllib3.exceptions import InsecureRequestWarning as requestWarning

API_TOKEN_URL = "https://" + SBCE_FQDN +"/api/auth/v1/token"
API_TOKEN_VERIFY_URL = API_TOKEN_URL + "/verify"

CONFIG_SERVICE_BASE_URL = "https://" + SBCE_FQDN + "/api/config/v1/"
DEFAULT_META_DATA = { "idKey" : None }

class ConfigApiExecutor:
    def __init__(self):
        self.__token = "dummy"
        urllib3.disable_warnings(requestWarning)

    def execute(self, directory_path):
        files = glob.glob(directory_path + os.sep + "*.json")
        for f in files:
            with open(f) as file:
                file_data = json.load(file)
                service_urls = self.__extract_service_urls(f, file_data)
                for key, url in service_urls.items():
                    req_body = self.__prepare_the_request_body(key, file_data)
                    result = self.__call_service(url, req_body)
                    if(result != 0):
                        return 1
        return 0

    def __extract_service_urls(self, name_str, file_data):
        service_urls = {}
        name_start_index = name_str.rfind(os.sep) + 1
        name_end_index = name_str.rfind('.json')
        
        service_name = name_str[name_start_index: name_end_index]
        service_url = CONFIG_SERVICE_BASE_URL + self.__camelcase_to_hyphencase(service_name)

        meta_data = file_data.get("metaData", DEFAULT_META_DATA)
        id_key = meta_data.get("idKey")
        sub_service_keys = meta_data.get("subServiceKeys")
        include_main_service = meta_data.get("includeMainService", False)
        ignore_camelcase = meta_data.get("ignoreCamelcase", False)

        if id_key:
            id = file_data.get("requestBody").get(id_key)
            service_url += "/" + str(id)
        if sub_service_keys:
            for service_key in sub_service_keys:
                _url = service_url + "/" + (service_key if (ignore_camelcase == True) else self.__camelcase_to_hyphencase(service_key))
                service_urls [service_key] = _url
        
        if not service_urls or include_main_service:
            service_urls["requestBody"] = service_url
    
        return service_urls 

    def __camelcase_to_hyphencase(self, str):
        res = [str[0].lower()]
        for c in str[1:]:
            res.append('-' + c.lower()) if c in ('ABCDEFGHIJKLMNOPQRSTUVWXYZ') else res.append(c)
        return ''.join(res)

    def __prepare_the_request_body(self, key, json_file_data):
        return json_file_data.get("requestBody") if key == "requestBody" else json_file_data.get("requestBody").get(key)
    
    def __get_auth_token(self):
        #verify token
        __http_basic_auth = HTTPBasicAuth(AUTH_CREDENTIALS.get("user"), AUTH_CREDENTIALS.get("password"))
        verifyRes = requests.post(API_TOKEN_VERIFY_URL, auth=__http_basic_auth, data ={'token' : self.__token}, verify=False)
        if (verifyRes.status_code == 404):
            token = requests.post(API_TOKEN_URL, auth=__http_basic_auth, verify=False)
            if (token.status_code != 200):
                print("not able to generate token.")
                print("request status:%s" % token.status_code)
                print("response: %s" % token.json())
                sys.exit(1)
            self.__token = token.json()
        return self.__token
    
    def __call_service(self, service_url, json_body = None):
        auth_header = {'Authorization': 'Bearer ' + self.__get_auth_token()}
        response = requests.post(service_url, headers=auth_header, json = json_body, verify= False)
        if(response.status_code != 200):
            print(u'\u274C', "update failed for service:", service_url, json_body)
            print("response code:", response.status_code)
            print("error response:", response.text)
            return 1

        print(service_url, json_body, "- success", u'\u2713')
        return 0

if __name__ == '__main__':
    config_api_exe = ConfigApiExecutor()
    result = config_api_exe.execute(TEMP_FILE_PATH)
    print ("result:", result)