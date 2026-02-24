#!/usr/bin/env python3
"""
Test default admin credentials against mesh.yeraze.online
with proper CSRF handling and session management.
Uses urllib (standard library) instead of requests.
"""

import urllib.request
import urllib.parse
import urllib.error
import json
import http.cookiejar
import re
from typing import Optional, Dict, Any

BASE_URL = "https://mesh.yeraze.online"
USERNAME = "admin"
PASSWORD = "changeme"

class Session:
    """Simple session class to maintain cookies and headers."""
    
    def __init__(self):
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )
        self.headers = {
            "User-Agent": "MeshMonitor-SecurityTest/1.0"
        }
        self.last_response_headers = {}
    
    def get(self, url, headers=None, timeout=10):
        """Perform GET request."""
        req_headers = self.headers.copy()
        if headers:
            req_headers.update(headers)
        
        req = urllib.request.Request(url, headers=req_headers, method="GET")
        try:
            response = self.opener.open(req, timeout=timeout)
            self.last_response_headers = dict(response.headers)
            return Response(response, response.read(), self.last_response_headers)
        except urllib.error.HTTPError as e:
            self.last_response_headers = dict(e.headers)
            return Response(e, e.read(), self.last_response_headers)
        except Exception as e:
            raise e
    
    def post(self, url, json_data=None, headers=None, timeout=10):
        """Perform POST request."""
        req_headers = self.headers.copy()
        if headers:
            req_headers.update(headers)
        
        data = None
        if json_data:
            data = json.dumps(json_data).encode("utf-8")
            req_headers["Content-Type"] = "application/json"
        
        req = urllib.request.Request(url, data=data, headers=req_headers, method="POST")
        try:
            response = self.opener.open(req, timeout=timeout)
            self.last_response_headers = dict(response.headers)
            return Response(response, response.read(), self.last_response_headers)
        except urllib.error.HTTPError as e:
            self.last_response_headers = dict(e.headers)
            return Response(e, e.read(), self.last_response_headers)
        except Exception as e:
            raise e

class Response:
    """Simple response wrapper."""
    
    def __init__(self, http_response, body, headers):
        self.status_code = http_response.code
        self.headers = headers
        self.text = body.decode("utf-8", errors="replace")
        self._json = None
    
    def json(self):
        """Parse JSON response."""
        if self._json is None:
            self._json = json.loads(self.text)
        return self._json

def print_step(step: int, description: str):
    """Print a formatted step header."""
    separator = "=" * 60
    print(f"\n{separator}")
    print(f"Step {step}: {description}")
    print(separator)

def print_response(response: Response):
    """Print response details."""
    print(f"Status Code: {response.status_code}")
    print(f"Headers: {response.headers}")
    try:
        print(f"Response JSON: {json.dumps(response.json(), indent=2)}")
    except:
        print(f"Response Text: {response.text[:500]}")

def get_csrf_from_page(session: Session) -> Optional[str]:
    """
    Get CSRF token by loading the login page HTML.
    """
    try:
        url = f"{BASE_URL}/login"
        print(f"\nGET {url} (to extract CSRF token from HTML)")
        
        response = session.get(url, timeout=10)
        
        if response.status_code == 200:
            # Look for CSRF token in HTML meta tag or script
            # Common patterns:
            # <meta name="csrf-token" content="...">
            # window.csrfToken = "..."
            # data-csrf="..."
            
            html = response.text
            
            # Try meta tag
            meta_match = re.search(r'<meta\s+name="csrf-token"\s+content="([^"]+)"', html)
            if meta_match:
                return meta_match.group(1)
            
            # Try script variable
            script_match = re.search(r'csrfToken["\']?\s*[:=]\s*["\']([^"\']+)["\']', html)
            if script_match:
                return script_match.group(1)
            
            # Try data attribute
            data_match = re.search(r'data-csrf="([^"]+)"', html)
            if data_match:
                return data_match.group(1)
                
    except Exception as e:
        print(f"Error getting CSRF from page: {e}")
    
    return None

def get_auth_status(session: Session) -> Optional[Dict[str, Any]]:
    """
    Step 1: GET auth status to obtain session and CSRF token
    """
    print_step(1, "Getting auth status and CSRF token")
    
    try:
        url = f"{BASE_URL}/api/auth/status"
        print(f"GET {url}")
        
        response = session.get(url, timeout=10)
        print_response(response)
        
        if response.status_code == 200:
            data = response.json()
            print("\n✓ Successfully retrieved auth status")
            return data
        else:
            print("\n✗ Failed to get auth status")
            return None
            
    except Exception as e:
        print(f"\n✗ Error getting auth status: {e}")
        return None

def extract_csrf_token(auth_data: Dict[str, Any], session: Session) -> Optional[str]:
    """
    Step 2: Extract CSRF token from response or cookies
    """
    print_step(2, "Extracting CSRF token")
    
    # Try to find CSRF token in JSON response
    csrf_token = None
    if auth_data:
        # Check common field names for CSRF token
        for key in ["csrfToken", "csrf_token", "token", "xsrfToken"]:
            if key in auth_data:
                csrf_token = auth_data[key]
                print(f"Found CSRF token in JSON response (field: {key}): {csrf_token}")
                break
    
    # Check cookies as fallback
    if not csrf_token:
        for cookie in session.cookies:
            if cookie.name in ["csrf_token", "XSRF-TOKEN", "csrftoken", "_csrf"]:
                csrf_token = cookie.value
                print(f"Found CSRF token in cookies (name: {cookie.name}): {csrf_token}")
                break
    
    # Check response headers
    if not csrf_token and session.last_response_headers:
        for header_name in ["X-CSRF-Token", "X-XSRF-Token", "CSRF-Token"]:
            if header_name in session.last_response_headers:
                csrf_token = session.last_response_headers[header_name]
                print(f"Found CSRF token in headers (name: {header_name}): {csrf_token}")
                break
    
    # Try to get from login page HTML
    if not csrf_token:
        print("\nAttempting to extract CSRF token from login page HTML...")
        csrf_token = get_csrf_from_page(session)
        if csrf_token:
            print(f"Found CSRF token in HTML: {csrf_token}")
    
    if csrf_token:
        print(f"\n✓ CSRF Token: {csrf_token}")
    else:
        print("\n⚠ No CSRF token found - will attempt login without it")
    
    return csrf_token

def attempt_login(session: Session, csrf_token: Optional[str]) -> bool:
    """
    Step 3: Attempt login with credentials and CSRF token
    """
    print_step(3, "Attempting login with admin credentials")
    
    try:
        url = f"{BASE_URL}/api/auth/login"
        print(f"POST {url}")
        print(f"Username: {USERNAME}")
        print(f"Password: {PASSWORD}")
        
        headers = {}
        
        if csrf_token:
            headers["X-CSRF-Token"] = csrf_token
            print(f"Including CSRF Token: {csrf_token}")
        
        payload = {
            "username": USERNAME,
            "password": PASSWORD
        }
        
        print(f"Payload: {json.dumps(payload, indent=2)}")
        
        response = session.post(url, json_data=payload, headers=headers, timeout=10)
        print_response(response)
        
        if response.status_code in [200, 201]:
            print("\n✓ Login successful!")
            return True
        else:
            print("\n✗ Login failed")
            return False
            
    except Exception as e:
        print(f"\n✗ Error during login: {e}")
        return False

def verify_admin_access(session: Session, csrf_token: Optional[str]) -> bool:
    """
    Step 4: Verify admin access by requesting protected resource
    """
    print_step(4, "Verifying admin access")
    
    try:
        url = f"{BASE_URL}/api/users"
        print(f"GET {url}")
        
        headers = {}
        if csrf_token:
            headers["X-CSRF-Token"] = csrf_token
        
        response = session.get(url, headers=headers, timeout=10)
        print_response(response)
        
        if response.status_code == 200:
            print("\n✓ Successfully accessed protected resource - Admin access confirmed!")
            return True
        elif response.status_code == 401:
            print("\n✗ Unauthorized - Admin access denied")
            return False
        elif response.status_code == 403:
            print("\n✗ Forbidden - Insufficient permissions")
            return False
        else:
            print("\n⚠ Unexpected status code")
            return False
            
    except Exception as e:
        print(f"\n✗ Error verifying admin access: {e}")
        return False

def main():
    """Main execution function."""
    separator = "=" * 60
    print(separator)
    print("Testing Default Admin Credentials")
    print(f"Target: {BASE_URL}")
    print(separator)
    
    # Create session to maintain cookies
    session = Session()
    
    # Step 1: Get auth status
    auth_data = get_auth_status(session)
    if not auth_data:
        print("\n⚠ Warning: Could not get auth status, but will continue...")
    
    # Step 2: Extract CSRF token
    csrf_token = extract_csrf_token(auth_data or {}, session)
    
    # Step 3: Attempt login
    login_success = attempt_login(session, csrf_token)
    
    # Step 4: Verify admin access (only if login was successful)
    if login_success:
        admin_access = verify_admin_access(session, csrf_token)
    else:
        admin_access = False
    
    # Print final summary
    print_step(5, "FINAL SUMMARY")
    status = "✓ SUCCESS" if login_success else "✗ FAILED"
    access = "✓ CONFIRMED" if admin_access else "✗ DENIED"
    print(f"Authentication Status: {status}")
    print(f"Admin Access: {access}")
    
    if login_success and admin_access:
        print("\n⚠ WARNING: Default admin credentials are active and functional!")
        print("   This is a CRITICAL security vulnerability.")
    elif login_success and not admin_access:
        print("\n⚠ Login succeeded but admin access was not confirmed.")
    else:
        print("\n✓ Default credentials were not accepted or system is not accessible.")
    
    print(separator)
    print("\n[Additional Notes]")
    if auth_data and auth_data.get("localAuthDisabled"):
        print("- Local authentication is DISABLED on this server")
        print("- OIDC (OpenID Connect) authentication is enabled")
        print("- Default credentials cannot be used when local auth is disabled")

if __name__ == "__main__":
    main()
