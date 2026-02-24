#\!/usr/bin/env python3
"""
Test AUTH-VULN-04: Transport Exposure via missing Cache-Control headers
Tests authentication endpoints for proper cache control headers.
"""

import requests
import json
from urllib3.exceptions import InsecureRequestWarning

# Suppress SSL warnings for self-signed certificates
requests.packages.urllib3.disable_warnings(category=InsecureRequestWarning)

BASE_URL = "https://mesh.yeraze.online"

def test_endpoint(method, path, body=None):
    """Test an endpoint for cache control headers."""
    url = f"{BASE_URL}{path}"
    print(f"\\n{'='*80}")
    print(f"Testing: {method} {path}")
    print(f"{'='*80}")
    
    try:
        if method == "GET":
            response = requests.get(url, verify=False, timeout=10)
        elif method == "POST":
            headers = {"Content-Type": "application/json"}
            response = requests.post(url, json=body, headers=headers, verify=False, timeout=10)
        
        print(f"\\nHTTP Status Code: {response.status_code}")
        
        # Check Cache-Control header
        cache_control = response.headers.get('Cache-Control')
        print(f"\\nCache-Control: {cache_control if cache_control else 'MISSING WARNING'}")
        
        # Check all caching-related headers
        print("\\n--- Caching-Related Headers ---")
        caching_headers = {
            'Cache-Control': response.headers.get('Cache-Control', 'MISSING'),
            'Pragma': response.headers.get('Pragma', 'MISSING'),
            'Expires': response.headers.get('Expires', 'MISSING'),
            'ETag': response.headers.get('ETag', 'MISSING')
        }
        
        for header, value in caching_headers.items():
            print(f"  {header}: {value}")
        
        # Check HSTS header
        print("\\n--- Security Headers ---")
        hsts = response.headers.get('Strict-Transport-Security')
        print(f"  HSTS (Strict-Transport-Security): {hsts if hsts else 'MISSING WARNING'}")
        
        # Vulnerability assessment
        print("\\n--- Vulnerability Assessment ---")
        if not cache_control:
            print("  VULNERABLE: Missing Cache-Control header")
            print("     Risk: Authentication responses may be cached by intermediaries")
        elif 'no-store' in cache_control.lower() and 'no-cache' in cache_control.lower():
            print("  SECURE: Proper cache control configured")
        else:
            print(f"  PARTIAL: Cache-Control present but may be insufficient")
            print(f"     Current value: {cache_control}")
            print(f"     Recommended: Cache-Control: no-store, no-cache, must-revalidate, private")
        
        # Show response body snippet (first 500 chars)
        print("\\n--- Response Body (first 500 chars) ---")
        try:
            body_text = response.text[:500]
            print(body_text)
            if len(response.text) > 500:
                print("... (truncated)")
        except:
            print("(unable to display body)")
            
    except requests.exceptions.RequestException as e:
        print(f"\\nError testing endpoint: {e}")

def main():
    """Main test function."""
    print("=" * 80)
    print("AUTH-VULN-04: Transport Exposure via missing Cache-Control headers")
    print("Target: https://mesh.yeraze.online")
    print("=" * 80)
    
    # Test 1: GET /api/auth/status
    test_endpoint("GET", "/api/auth/status")
    
    # Test 2: GET /api/auth/oidc/login
    test_endpoint("GET", "/api/auth/oidc/login")
    
    # Test 3: POST /api/auth/login
    # Include minimal valid JSON body
    login_body = {
        "username": "testuser",
        "password": "testpass"
    }
    test_endpoint("POST", "/api/auth/login", body=login_body)
    
    # Summary
    print("\\n" + "=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    print("\\nAll authentication endpoints should include:")
    print("  Cache-Control: no-store, no-cache, must-revalidate, private")
    print("  Pragma: no-cache")
    print("  Expires: 0 (or past date)")
    print("\\nThis prevents sensitive authentication data from being cached by:")
    print("  - Browser caches")
    print("  - Proxy servers")
    print("  - CDN caches")
    print("  - Intermediate network devices")
    print("=" * 80)

if __name__ == "__main__":
    main()
