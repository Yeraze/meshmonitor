#\!/usr/bin/env python3
"""
Test AUTH-VULN-04: Transport Exposure via missing Cache-Control headers
Tests authentication endpoints for proper cache control headers.
"""

import urllib.request
import urllib.error
import json
import ssl

# Create SSL context that ignores certificate verification
ssl_context = ssl.create_default_context()
ssl_context.check_hostname = False
ssl_context.verify_mode = ssl.CERT_NONE

BASE_URL = "https://mesh.yeraze.online"

def test_endpoint(method, path, body=None):
    """Test an endpoint for cache control headers."""
    url = f"{BASE_URL}{path}"
    print()
    print("=" * 80)
    print(f"Testing: {method} {path}")
    print("=" * 80)
    
    try:
        if method == "GET":
            request = urllib.request.Request(url, method="GET")
        elif method == "POST":
            json_data = json.dumps(body).encode('utf-8')
            request = urllib.request.Request(url, data=json_data, method="POST")
            request.add_header('Content-Type', 'application/json')
        
        with urllib.request.urlopen(request, context=ssl_context, timeout=10) as response:
            status_code = response.status
            headers = response.headers
            body_text = response.read().decode('utf-8', errors='replace')
            
            print()
            print(f"HTTP Status Code: {status_code}")
            
            # Check Cache-Control header
            cache_control = headers.get('Cache-Control')
            print()
            print(f"Cache-Control: {cache_control if cache_control else 'MISSING WARNING'}")
            
            # Check all caching-related headers
            print()
            print("--- Caching-Related Headers ---")
            caching_headers = {
                'Cache-Control': headers.get('Cache-Control', 'MISSING'),
                'Pragma': headers.get('Pragma', 'MISSING'),
                'Expires': headers.get('Expires', 'MISSING'),
                'ETag': headers.get('ETag', 'MISSING')
            }
            
            for header, value in caching_headers.items():
                print(f"  {header}: {value}")
            
            # Check HSTS header
            print()
            print("--- Security Headers ---")
            hsts = headers.get('Strict-Transport-Security')
            print(f"  HSTS (Strict-Transport-Security): {hsts if hsts else 'MISSING WARNING'}")
            
            # Vulnerability assessment
            print()
            print("--- Vulnerability Assessment ---")
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
            print()
            print("--- Response Body (first 500 chars) ---")
            print(body_text[:500])
            if len(body_text) > 500:
                print("... (truncated)")
                
    except urllib.error.HTTPError as e:
        status_code = e.code
        headers = e.headers
        
        print()
        print(f"HTTP Status Code: {status_code}")
        
        # Check Cache-Control header even on errors
        cache_control = headers.get('Cache-Control')
        print()
        print(f"Cache-Control: {cache_control if cache_control else 'MISSING WARNING'}")
        
        # Check all caching-related headers
        print()
        print("--- Caching-Related Headers ---")
        caching_headers = {
            'Cache-Control': headers.get('Cache-Control', 'MISSING'),
            'Pragma': headers.get('Pragma', 'MISSING'),
            'Expires': headers.get('Expires', 'MISSING'),
            'ETag': headers.get('ETag', 'MISSING')
        }
        
        for header, value in caching_headers.items():
            print(f"  {header}: {value}")
        
        # Check HSTS header
        print()
        print("--- Security Headers ---")
        hsts = headers.get('Strict-Transport-Security')
        print(f"  HSTS (Strict-Transport-Security): {hsts if hsts else 'MISSING WARNING'}")
        
        # Vulnerability assessment
        print()
        print("--- Vulnerability Assessment ---")
        if not cache_control:
            print("  VULNERABLE: Missing Cache-Control header")
            print("     Risk: Authentication responses may be cached by intermediaries")
        elif 'no-store' in cache_control.lower() and 'no-cache' in cache_control.lower():
            print("  SECURE: Proper cache control configured")
        else:
            print(f"  PARTIAL: Cache-Control present but may be insufficient")
        
        # Show error response body
        print()
        print("--- Response Body ---")
        try:
            error_body = e.read().decode('utf-8', errors='replace')
            print(error_body[:500])
            if len(error_body) > 500:
                print("... (truncated)")
        except:
            print("(unable to read error body)")
            
    except Exception as e:
        print()
        print(f"Error testing endpoint: {e}")

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
    print()
    print("=" * 80)
    print("TEST SUMMARY")
    print("=" * 80)
    print()
    print("All authentication endpoints should include:")
    print("  Cache-Control: no-store, no-cache, must-revalidate, private")
    print("  Pragma: no-cache")
    print("  Expires: 0 (or past date)")
    print()
    print("This prevents sensitive authentication data from being cached by:")
    print("  - Browser caches")
    print("  - Proxy servers")
    print("  - CDN caches")
    print("  - Intermediate network devices")
    print("=" * 80)

if __name__ == "__main__":
    main()
