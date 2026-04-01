#!/bin/bash
# Test script for proxy authentication
# Simulates various reverse proxy authentication scenarios

set -e

BASE_URL="http://localhost:8081/meshmonitor"
echo "Testing proxy authentication against $BASE_URL"
echo ""

# Test 1: Cloudflare Access JWT
echo "=== Test 1: Cloudflare Access JWT ==="
PAYLOAD='{"email":"cloudflare@example.com","groups":["admins"]}'
ENCODED_PAYLOAD=$(echo -n "$PAYLOAD" | base64 | tr '+/' '-_' | tr -d '=')
FAKE_JWT="header.${ENCODED_PAYLOAD}.signature"

curl -s -H "Cf-Access-Jwt-Assertion: $FAKE_JWT" \
  "$BASE_URL/api/auth/status" | jq -r '.authenticated, .user.email, .user.isAdmin'
echo ""

# Test 2: oauth2-proxy
echo "=== Test 2: oauth2-proxy ==="
curl -s -H "X-Auth-Request-Email: oauth2@example.com" \
  -H "X-Auth-Request-Groups: users,developers" \
  "$BASE_URL/api/auth/status" | jq -r '.authenticated, .user.email, .user.isAdmin'
echo ""

# Test 3: Generic proxy
echo "=== Test 3: Generic proxy ==="
curl -s -H "Remote-User: generic@example.com" \
  -H "Remote-Groups: mesh-users" \
  "$BASE_URL/api/auth/status" | jq -r '.authenticated, .user.email, .user.isAdmin'
echo ""

# Test 4: Admin user (via email list)
echo "=== Test 4: Admin via email list ==="
curl -s -H "X-Auth-Request-Email: admin@example.com" \
  "$BASE_URL/api/auth/status" | jq -r '.authenticated, .user.email, .user.isAdmin'
echo ""

# Test 5: No proxy headers (fallback to local auth)
echo "=== Test 5: No proxy headers (anonymous fallback) ==="
curl -s "$BASE_URL/api/auth/status" | jq -r '.authenticated, .user.username'
echo ""

echo "=== Tests complete ==="
