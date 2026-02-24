#!/usr/bin/env python3
"""
AUTH-VULN-04 Exploitation Test: Authentication Response Caching
Simulates shared computer scenario where cached authentication responses
could lead to unauthorized access.
"""

import requests
import json
from datetime import datetime

# Configuration
BASE_URL = "http://localhost:3000"
AUTH_STATUS_ENDPOINT = f"{BASE_URL}/api/auth/status"

def print_section(title):
    """Print a formatted section header."""
    print(f"\\n{'='*70}")
    print(f"  {title}")
    print(f"{'='*70}\\n")

def print_subsection(title):
    """Print a formatted subsection header."""
    print(f"\\n--- {title} ---\\n")

def analyze_response(response, request_num):
    """Analyze a response for caching and security issues."""
    print_subsection(f"Request #{request_num} Analysis")
    
    print(f"Status Code: {response.status_code}")
    print(f"URL: {response.url}")
    print(f"Timestamp: {datetime.now().isoformat()}")
    
    # Check caching headers
    print_subsection(f"Request #{request_num} - Caching Headers")
    cache_headers = [
        'Cache-Control',
        'ETag',
        'Last-Modified',
        'Expires',
        'Pragma',
        'Vary',
        'Age'
    ]
    
    found_cache_headers = {}
    for header in cache_headers:
        if header in response.headers:
            value = response.headers[header]
            found_cache_headers[header] = value
            print(f"  {header}: {value}")
    
    if not found_cache_headers:
        print("  No caching headers found")
    
    # Check cookies
    print_subsection(f"Request #{request_num} - Cookies")
    if response.cookies:
        print("  Cookies received:")
        for cookie in response.cookies:
            print(f"    Name: {cookie.name}")
            print(f"    Value: {cookie.value[:20]}..." if len(cookie.value) > 20 else f"    Value: {cookie.value}")
            print(f"    Domain: {cookie.domain}")
            print(f"    Path: {cookie.path}")
            print(f"    Secure: {cookie.secure}")
            print(f"    HttpOnly: {cookie.has_nonstandard_attr('HttpOnly')}")
            print()
    else:
        print("  No cookies in response")
    
    # Check response body
    print_subsection(f"Request #{request_num} - Response Body")
    try:
        if response.status_code == 304:
            print("  304 Not Modified - No body content")
            body = None
        else:
            body = response.json()
            print(f"  Content-Type: {response.headers.get('Content-Type', 'Not specified')}")
            print(f"  Response Body:")
            print(json.dumps(body, indent=2))
            
            # Check for sensitive data
            print_subsection(f"Request #{request_num} - Sensitive Data Check")
            sensitive_fields = ['userId', 'email', 'username', 'sessionId', 'token', 'authenticated']
            found_sensitive = []
            
            def check_sensitive(obj, path=""):
                if isinstance(obj, dict):
                    for key, value in obj.items():
                        current_path = f"{path}.{key}" if path else key
                        if any(field.lower() in key.lower() for field in sensitive_fields):
                            found_sensitive.append((current_path, value))
                        check_sensitive(value, current_path)
                elif isinstance(obj, list):
                    for i, item in enumerate(obj):
                        check_sensitive(item, f"{path}[{i}]")
            
            check_sensitive(body)
            
            if found_sensitive:
                print("  WARNING: Sensitive data found in response:")
                for field_path, value in found_sensitive:
                    print(f"    {field_path}: {value}")
            else:
                print("  No sensitive data detected")
    except json.JSONDecodeError:
        print(f"  Non-JSON response: {response.text[:200]}")
        body = None
    except Exception as e:
        print(f"  Error parsing response: {e}")
        body = None
    
    return {
        'status_code': response.status_code,
        'headers': dict(response.headers),
        'cache_headers': found_cache_headers,
        'cookies': {cookie.name: cookie.value for cookie in response.cookies},
        'body': body
    }

def main():
    print_section("AUTH-VULN-04: Authentication Response Caching Vulnerability Test")
    
    print("This test simulates a shared computer scenario where cached authentication")
    print("responses could allow unauthorized users to access sensitive information.")
    
    # Create a session to track cookies
    session = requests.Session()
    
    # Request 1: Initial request to /api/auth/status
    print_section("Step 1: Initial Authentication Status Request")
    print("Making GET request to /api/auth/status...")
    
    try:
        response1 = session.get(AUTH_STATUS_ENDPOINT)
        result1 = analyze_response(response1, 1)
    except requests.exceptions.RequestException as e:
        print(f"ERROR: Failed to connect to {AUTH_STATUS_ENDPOINT}")
        print(f"Error: {e}")
        print("\\nMake sure the application is running on localhost:3000")
        return
    
    # Request 2: Conditional request with If-None-Match (if ETag present)
    print_section("Step 2: Conditional Request with ETag")
    
    if 'ETag' in result1['cache_headers']:
        etag = result1['cache_headers']['ETag']
        print(f"ETag found: {etag}")
        print("Making conditional request with If-None-Match header...")
        
        headers = {'If-None-Match': etag}
        response2 = session.get(AUTH_STATUS_ENDPOINT, headers=headers)
        result2 = analyze_response(response2, 2)
        
        if response2.status_code == 304:
            print_subsection("VULNERABILITY CONFIRMED")
            print("  Server returned 304 Not Modified!")
            print("  This means the authentication status response is cacheable.")
            print("  In a shared computer scenario, this could allow:")
            print("    - Browser cache to store authentication state")
            print("    - Next user to see previous user's auth status")
            print("    - Potential session hijacking if session data is cached")
    else:
        print("No ETag header found in initial response.")
        print("Attempting conditional request anyway with made-up ETag...")
        headers = {'If-None-Match': '"test-etag-12345"'}
        response2 = session.get(AUTH_STATUS_ENDPOINT, headers=headers)
        result2 = analyze_response(response2, 2)
    
    # Request 3: Check Cache-Control directives
    print_section("Step 3: Cache-Control Analysis")
    
    cache_control = result1['cache_headers'].get('Cache-Control', 'Not present')
    print(f"Cache-Control header: {cache_control}")
    
    if cache_control == 'Not present':
        print("\\nVULNERABILITY: No Cache-Control header!")
        print("  Without explicit cache control, browsers may cache the response.")
        risk_level = "HIGH"
    elif 'no-store' in cache_control.lower():
        print("\\nGOOD: 'no-store' directive prevents caching")
        risk_level = "LOW"
    elif 'no-cache' in cache_control.lower():
        print("\\nWARNING: 'no-cache' allows caching but requires revalidation")
        print("  This can still be exploited in some scenarios")
        risk_level = "MEDIUM"
    elif 'private' in cache_control.lower():
        print("\\nWARNING: 'private' allows browser caching")
        print("  On shared computers, this could expose auth data")
        risk_level = "MEDIUM"
    elif 'public' in cache_control.lower():
        print("\\nVULNERABILITY: 'public' allows shared caching!")
        print("  This is highly inappropriate for authentication endpoints")
        risk_level = "CRITICAL"
    else:
        print("\\nWARNING: Cache-Control present but may not prevent caching")
        risk_level = "MEDIUM"
    
    # Request 4: Test with different session (simulating different user)
    print_section("Step 4: Cross-User Cache Test (Simulated)")
    print("Creating new session to simulate different user...")
    
    new_session = requests.Session()
    response3 = new_session.get(AUTH_STATUS_ENDPOINT)
    result3 = analyze_response(response3, 3)
    
    # Final vulnerability assessment
    print_section("Vulnerability Assessment Summary")
    
    vulnerabilities = []
    
    # Check for caching issues
    if result1.get('cache_headers', {}).get('ETag'):
        vulnerabilities.append("- ETag header present (enables conditional requests)")
    
    if cache_control == 'Not present':
        vulnerabilities.append("- No Cache-Control header (browser may cache)")
    elif 'no-store' not in cache_control.lower():
        vulnerabilities.append(f"- Cache-Control does not include 'no-store': {cache_control}")
    
    if 'public' in cache_control.lower():
        vulnerabilities.append("- Cache-Control allows public caching (CRITICAL)")
    
    # Check for sensitive data
    if result1.get('body') and any(key in str(result1['body']).lower() 
                                    for key in ['user', 'email', 'session', 'token', 'authenticated']):
        vulnerabilities.append("- Response contains sensitive authentication data")
    
    # Check for missing security headers
    if 'Vary' not in result1['headers']:
        vulnerabilities.append("- No 'Vary' header (cache may not differentiate users)")
    
    if 'Pragma' not in result1['headers'] or result1['headers'].get('Pragma') != 'no-cache':
        vulnerabilities.append("- Missing 'Pragma: no-cache' (HTTP/1.0 compatibility)")
    
    if vulnerabilities:
        print(f"RISK LEVEL: {risk_level}\\n")
        print("Vulnerabilities Found:")
        for vuln in vulnerabilities:
            print(vuln)
        
        print("\\nExploitation Scenario:")
        print("1. User A logs into the application on a shared computer")
        print("2. Browser caches the /api/auth/status response")
        print("3. User A logs out but doesn't clear browser cache")
        print("4. User B uses the same browser")
        print("5. Cached response may show User A's authentication status")
        print("6. If session cookies persist, User B could access User A's account")
        
        print("\\nRecommended Fixes:")
        print("1. Add Cache-Control: no-store, no-cache, must-revalidate")
        print("2. Add Pragma: no-cache")
        print("3. Remove ETag header from authentication endpoints")
        print("4. Add Vary: Cookie header")
        print("5. Ensure sensitive data is not cached by intermediaries")
        print("6. Set appropriate cookie attributes (Secure, HttpOnly, SameSite)")
    else:
        print("RISK LEVEL: LOW\\n")
        print("No significant caching vulnerabilities detected.")
        print("The endpoint appears to be properly configured.")
    
    print_section("Test Complete")

if __name__ == "__main__":
    main()
