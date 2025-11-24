#!/bin/bash
# Security test for API endpoint protection
# Tests that sensitive data (Node IP, MQTT config) is hidden from anonymous users
# and visible to authenticated users

set -e  # Exit on any error

echo "=========================================="
echo "Security Test - Anonymous Data Protection"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Use port 8083 which is what quick-start test uses, or override with env var
BASE_URL="${BASE_URL:-http://localhost:8083}"
SENSITIVE_IP="192.168.5.106"
SENSITIVE_MQTT="mqtt.areyoumeshingwith.us"

# Test 1: Verify anonymous user CANNOT see Node IP in /api/poll
echo "Test 1: Anonymous user - Node IP hidden in /api/poll"
POLL_ANON=$(curl -s $BASE_URL/api/poll)

if echo "$POLL_ANON" | grep -q "$SENSITIVE_IP"; then
    echo -e "${RED}✗ FAIL${NC}: Node IP found in anonymous /api/poll response"
    echo "   Response contains: $SENSITIVE_IP"
    exit 1
else
    echo -e "${GREEN}✓ PASS${NC}: Node IP not exposed to anonymous users"
fi
echo ""

# Test 2: Verify anonymous user CANNOT see Node IP in /api/config
echo "Test 2: Anonymous user - Node IP hidden in /api/config"
CONFIG_ANON=$(curl -s $BASE_URL/api/config)

if echo "$CONFIG_ANON" | grep -q "$SENSITIVE_IP"; then
    echo -e "${RED}✗ FAIL${NC}: Node IP found in anonymous /api/config response"
    echo "   Response contains: $SENSITIVE_IP"
    exit 1
else
    echo -e "${GREEN}✓ PASS${NC}: Node IP not exposed to anonymous users"
fi
echo ""

# Test 3: Verify anonymous user CANNOT see MQTT config in /api/poll
echo "Test 3: Anonymous user - MQTT config hidden in /api/poll"

if echo "$POLL_ANON" | grep -q "$SENSITIVE_MQTT"; then
    echo -e "${RED}✗ FAIL${NC}: MQTT server found in anonymous /api/poll response"
    echo "   Response contains: $SENSITIVE_MQTT"
    exit 1
else
    echo -e "${GREEN}✓ PASS${NC}: MQTT config not exposed to anonymous users"
fi
echo ""

# Test 4: Get CSRF token for authentication
echo "Test 4: Fetch CSRF token for authentication"
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/csrf-token \
    -c /tmp/meshmonitor-security-cookies.txt)

HTTP_CODE=$(echo "$CSRF_RESPONSE" | tail -n1)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | head -n-1 | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

if [ "$HTTP_CODE" = "200" ] && [ -n "$CSRF_TOKEN" ]; then
    echo -e "${GREEN}✓ PASS${NC}: CSRF token obtained"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get CSRF token"
    exit 1
fi
echo ""

# Test 5: Login as admin
echo "Test 5: Login with admin credentials"
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST $BASE_URL/api/auth/login \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}' \
    -b /tmp/meshmonitor-security-cookies.txt \
    -c /tmp/meshmonitor-security-cookies.txt)

HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Login successful"
else
    echo -e "${RED}✗ FAIL${NC}: Login failed (HTTP $HTTP_CODE)"
    exit 1
fi
echo ""

# Test 6: Verify authenticated user CAN see Node IP in /api/poll
echo "Test 6: Authenticated user - Node IP visible in /api/poll"
POLL_AUTH=$(curl -s $BASE_URL/api/poll \
    -b /tmp/meshmonitor-security-cookies.txt)

if echo "$POLL_AUTH" | grep -q "$SENSITIVE_IP"; then
    echo -e "${GREEN}✓ PASS${NC}: Node IP visible to authenticated users"
else
    echo -e "${RED}✗ FAIL${NC}: Node IP not found in authenticated /api/poll response"
    echo "   Expected to find: $SENSITIVE_IP"
    exit 1
fi
echo ""

# Test 7: Verify authenticated user CAN see Node IP in /api/config
echo "Test 7: Authenticated user - Node IP visible in /api/config"
CONFIG_AUTH=$(curl -s $BASE_URL/api/config \
    -b /tmp/meshmonitor-security-cookies.txt)

if echo "$CONFIG_AUTH" | grep -q "$SENSITIVE_IP"; then
    echo -e "${GREEN}✓ PASS${NC}: Node IP visible to authenticated users"
else
    echo -e "${RED}✗ FAIL${NC}: Node IP not found in authenticated /api/config response"
    echo "   Expected to find: $SENSITIVE_IP"
    exit 1
fi
echo ""

# Test 8: Verify authenticated user CAN see MQTT config in /api/poll
echo "Test 8: Authenticated user - MQTT config visible in /api/poll"

if echo "$POLL_AUTH" | grep -q "$SENSITIVE_MQTT"; then
    echo -e "${GREEN}✓ PASS${NC}: MQTT config visible to authenticated users"
else
    echo -e "${RED}✗ FAIL${NC}: MQTT server not found in authenticated /api/poll response"
    echo "   Expected to find: $SENSITIVE_MQTT"
    exit 1
fi
echo ""

# Test 9: Verify /api/device-config is protected (requires authentication)
echo "Test 9: Anonymous user - /api/device-config returns 401/403"
DEVICE_CONFIG_ANON=$(curl -s -w "\n%{http_code}" $BASE_URL/api/device-config)

HTTP_CODE=$(echo "$DEVICE_CONFIG_ANON" | tail -n1)
if [ "$HTTP_CODE" = "401" ] || [ "$HTTP_CODE" = "403" ]; then
    echo -e "${GREEN}✓ PASS${NC}: /api/device-config protected from anonymous users (HTTP $HTTP_CODE)"
else
    echo -e "${RED}✗ FAIL${NC}: /api/device-config should return 401/403 for anonymous users, got HTTP $HTTP_CODE"
    exit 1
fi
echo ""

# Test 10: Verify authenticated user CAN access /api/device-config
echo "Test 10: Authenticated user - /api/device-config accessible"
DEVICE_CONFIG_AUTH=$(curl -s -w "\n%{http_code}" $BASE_URL/api/device-config \
    -b /tmp/meshmonitor-security-cookies.txt)

HTTP_CODE=$(echo "$DEVICE_CONFIG_AUTH" | tail -n1)
RESPONSE_BODY=$(echo "$DEVICE_CONFIG_AUTH" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ PASS${NC}: /api/device-config accessible to authenticated users"

    # Verify it contains MQTT config
    if echo "$RESPONSE_BODY" | grep -q "mqtt"; then
        echo -e "${GREEN}✓${NC} MQTT config present in device config"
    else
        echo -e "${YELLOW}⚠ WARN${NC}: MQTT config not found in device config (may not be configured)"
    fi
else
    echo -e "${RED}✗ FAIL${NC}: /api/device-config should be accessible to authenticated users, got HTTP $HTTP_CODE"
    exit 1
fi
echo ""

# Cleanup
rm -f /tmp/meshmonitor-security-cookies.txt

echo "=========================================="
echo -e "${GREEN}All security tests passed!${NC}"
echo "=========================================="
echo ""
echo "Security verification complete:"
echo "  • Node IP hidden from anonymous users"
echo "  • MQTT config hidden from anonymous users"
echo "  • Node IP visible to authenticated users"
echo "  • MQTT config visible to authenticated users"
echo "  • Protected endpoints require authentication"
echo ""
