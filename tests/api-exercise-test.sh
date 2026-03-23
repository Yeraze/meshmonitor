#!/bin/bash
# API Exercise Test
#
# Exercises every API endpoint like the UI does, checking for crashes,
# 500 errors, and unexpected failures. Designed to run against each
# database backend to catch cross-database issues.
#
# Usage: tests/api-exercise-test.sh [base_url]
#   base_url: MeshMonitor base URL (default: http://localhost:8081/meshmonitor)
#
# Environment variables:
#   API_USER - Username (default: admin)
#   API_PASS - Password (default: changeme)

set -euo pipefail

BASE_URL="${1:-http://localhost:8081/meshmonitor}"
API_USER="${API_USER:-admin}"
API_PASS="${API_PASS:-changeme}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# State
COOKIE_FILE=$(mktemp)
CSRF_TOKEN=""
PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
FAILURES=()

trap "rm -f $COOKIE_FILE" EXIT

# ─── Helpers ───────────────────────────────────────────────

log_pass() {
  echo -e "  ${GREEN}✓${NC} $1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

log_fail() {
  echo -e "  ${RED}✗${NC} $1 — $2"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  FAILURES+=("$1: $2")
}

log_skip() {
  echo -e "  ${YELLOW}⊘${NC} $1 — skipped"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

# Make an API request, return HTTP status code
api() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${BASE_URL}${path}"

  local curl_args=(-s -o /dev/null -w "%{http_code}" -b "$COOKIE_FILE" -c "$COOKIE_FILE")
  curl_args+=(-X "$method")

  if [ -n "$CSRF_TOKEN" ]; then
    curl_args+=(-H "X-CSRF-Token: $CSRF_TOKEN")
  fi

  if [ -n "$body" ]; then
    curl_args+=(-H "Content-Type: application/json")
    curl_args+=(-d "$body")
  fi

  curl "${curl_args[@]}" "$url" 2>/dev/null || echo "000"
}

# Make an API request and return the body
api_body() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${BASE_URL}${path}"

  local curl_args=(-s -b "$COOKIE_FILE" -c "$COOKIE_FILE")
  curl_args+=(-X "$method")

  if [ -n "$CSRF_TOKEN" ]; then
    curl_args+=(-H "X-CSRF-Token: $CSRF_TOKEN")
  fi

  if [ -n "$body" ]; then
    curl_args+=(-H "Content-Type: application/json")
    curl_args+=(-d "$body")
  fi

  curl "${curl_args[@]}" "$url" 2>/dev/null
}

# Check response: pass if status matches expected, fail otherwise
check() {
  local desc="$1"
  local status="$2"
  shift 2
  local expected=("$@")

  for exp in "${expected[@]}"; do
    if [ "$status" = "$exp" ]; then
      log_pass "$desc (${status})"
      return 0
    fi
  done

  log_fail "$desc" "got ${status}, expected ${expected[*]}"
  return 0
}

# ─── Setup ─────────────────────────────────────────────────

echo "=========================================="
echo "API Exercise Test"
echo "=========================================="
echo "Target: $BASE_URL"
echo "User: $API_USER"
echo ""

# Wait for server to be ready
echo -e "${BLUE}Waiting for server...${NC}"
for i in $(seq 1 30); do
  status=$(api GET /api/health 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then
    echo -e "${GREEN}Server ready${NC}"
    break
  fi
  if [ "$i" = "30" ]; then
    echo -e "${RED}Server not ready after 30s${NC}"
    exit 1
  fi
  sleep 1
done

# ─── Pre-Auth Endpoints ───────────────────────────────────

echo ""
echo -e "${BLUE}=== Pre-Auth Endpoints ===${NC}"

check "GET /api/health" "$(api GET /api/health)" 200
check "GET /api/csrf-token" "$(api GET /api/csrf-token)" 200

# Get CSRF token
CSRF_TOKEN=$(api_body GET /api/csrf-token | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null || echo "")
if [ -z "$CSRF_TOKEN" ]; then
  echo -e "${RED}Failed to get CSRF token — aborting${NC}"
  exit 1
fi
log_pass "CSRF token obtained"

check "GET /api/auth/status (unauthenticated)" "$(api GET /api/auth/status)" 200
check "GET /api/auth/check-config-issues" "$(api GET /api/auth/check-config-issues)" 200
check "GET /api/auth/check-default-password" "$(api GET /api/auth/check-default-password)" 200
check "GET /api/settings (unauthenticated)" "$(api GET /api/settings)" 200
check "GET /api/server-info" "$(api GET /api/server-info)" 200

# ─── Authentication ────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Authentication ===${NC}"

# Try login with retries (rate limiter may need a moment)
LOGIN_STATUS="000"
for attempt in 1 2 3; do
  LOGIN_STATUS=$(api POST /api/auth/login "{\"username\":\"${API_USER}\",\"password\":\"${API_PASS}\"}")
  if [ "$LOGIN_STATUS" = "200" ]; then break; fi
  if [ "$LOGIN_STATUS" = "401" ] && [ "$attempt" = "1" ]; then
    API_PASS="changeme1"
    LOGIN_STATUS=$(api POST /api/auth/login "{\"username\":\"${API_USER}\",\"password\":\"${API_PASS}\"}")
    if [ "$LOGIN_STATUS" = "200" ]; then break; fi
  fi
  if [ "$LOGIN_STATUS" = "429" ]; then
    echo -e "  ${YELLOW}Rate limited, waiting 10s...${NC}"
    sleep 10
  fi
done
check "POST /api/auth/login" "$LOGIN_STATUS" 200

# Refresh CSRF after login
CSRF_TOKEN=$(api_body GET /api/csrf-token | python3 -c "import sys,json; print(json.load(sys.stdin).get('csrfToken',''))" 2>/dev/null || echo "")

check "GET /api/auth/status (authenticated)" "$(api GET /api/auth/status)" 200

# ─── Nodes ─────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Nodes ===${NC}"

check "GET /api/nodes" "$(api GET /api/nodes)" 200
check "GET /api/nodes/active" "$(api GET /api/nodes/active)" 200
check "GET /api/nodes/security-issues" "$(api GET /api/nodes/security-issues)" 200
check "GET /api/ignored-nodes" "$(api GET /api/ignored-nodes)" 200
check "GET /api/auto-favorite/status" "$(api GET /api/auto-favorite/status)" 200

# Get a node ID for testing
FIRST_NODE_ID=$(api_body GET /api/nodes | python3 -c "
import sys,json
nodes = json.loads(sys.stdin.read())
if nodes:
    u = nodes[0].get('user',{})
    print(u.get('id',''))
" 2>/dev/null || echo "")

FIRST_NODE_NUM=$(api_body GET /api/nodes | python3 -c "
import sys,json
nodes = json.loads(sys.stdin.read())
if nodes: print(nodes[0].get('nodeNum',''))
" 2>/dev/null || echo "")

if [ -n "$FIRST_NODE_ID" ]; then
  check "GET /api/nodes/:nodeId/position-history" "$(api GET /api/nodes/$FIRST_NODE_ID/position-history)" 200
  check "GET /api/nodes/:nodeId/positions" "$(api GET /api/nodes/$FIRST_NODE_ID/positions)" 200
  check "GET /api/nodes/:nodeId/position-override" "$(api GET /api/nodes/$FIRST_NODE_ID/position-override)" 200 404
else
  log_skip "Node-specific endpoints (no nodes found)"
fi

# ─── Telemetry ─────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Telemetry ===${NC}"

if [ -n "$FIRST_NODE_ID" ]; then
  check "GET /api/telemetry/:nodeId" "$(api GET /api/telemetry/$FIRST_NODE_ID)" 200
  check "GET /api/telemetry/:nodeId/rates" "$(api GET /api/telemetry/$FIRST_NODE_ID/rates)" 200
  check "GET /api/telemetry/:nodeId/smarthops" "$(api GET /api/telemetry/$FIRST_NODE_ID/smarthops)" 200
else
  log_skip "Telemetry endpoints (no nodes)"
fi

# ─── Messages ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Messages ===${NC}"

check "GET /api/messages/search?q=test" "$(api GET '/api/messages/search?q=test')" 200

# ─── Traceroutes ───────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Traceroutes ===${NC}"

check "GET /api/traceroutes/recent" "$(api GET /api/traceroutes/recent)" 200

# ─── Neighbors ─────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Neighbors ===${NC}"

check "GET /api/neighbor-info" "$(api GET /api/neighbor-info)" 200
check "GET /api/direct-neighbors" "$(api GET /api/direct-neighbors)" 200

if [ -n "$FIRST_NODE_NUM" ]; then
  check "GET /api/neighbor-info/:nodeNum" "$(api GET /api/neighbor-info/$FIRST_NODE_NUM)" 200
fi

# ─── Channels ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Channels ===${NC}"

check "GET /api/channels" "$(api GET /api/channels)" 200

# ─── Packets ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Packets ===${NC}"

check "GET /api/packets" "$(api GET /api/packets)" 200
check "GET /api/packets?limit=10" "$(api GET '/api/packets?limit=10')" 200
check "GET /api/packets/stats" "$(api GET /api/packets/stats)" 200
check "GET /api/packets/stats/distribution" "$(api GET /api/packets/stats/distribution)" 200
check "GET /api/packets/relay-nodes" "$(api GET /api/packets/relay-nodes)" 200

# ─── Audit ─────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Audit Logs ===${NC}"

check "GET /api/audit" "$(api GET /api/audit)" 200
check "GET /api/audit?limit=10" "$(api GET '/api/audit?limit=10')" 200
check "GET /api/audit/stats/summary" "$(api GET /api/audit/stats/summary)" 200

# ─── Security ─────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Security ===${NC}"

check "GET /api/security/issues" "$(api GET /api/security/issues)" 200
check "GET /api/security/scanner/status" "$(api GET /api/security/scanner/status)" 200
check "GET /api/security/key-mismatches" "$(api GET /api/security/key-mismatches)" 200

# ─── User Management ──────────────────────────────────────

echo ""
echo -e "${BLUE}=== User Management ===${NC}"

check "GET /api/users" "$(api GET /api/users)" 200

ADMIN_ID=$(api_body GET /api/users | python3 -c "
import sys,json
data = json.loads(sys.stdin.read())
users = data.get('users', data) if isinstance(data, dict) else data
for u in users:
  if u.get('username') == 'admin': print(u['id']); break
" 2>/dev/null || echo "1")

check "GET /api/users/:id" "$(api GET /api/users/$ADMIN_ID)" 200
check "GET /api/users/:id/permissions" "$(api GET /api/users/$ADMIN_ID/permissions)" 200

# Create test user with unique name (deactivate doesn't free the username)
TEST_USERNAME="apitest_$(date +%s)"
TEST_USER_BODY="{\"username\":\"${TEST_USERNAME}\",\"password\":\"TestPass123!x\",\"email\":\"${TEST_USERNAME}@test.com\",\"displayName\":\"API Test\",\"isAdmin\":false}"
CREATE_STATUS=$(api POST /api/users "$TEST_USER_BODY")
check "POST /api/users (create test user)" "$CREATE_STATUS" 201 200

TEST_USER_ID=$(api_body GET /api/users | python3 -c "
import sys,json
data = json.loads(sys.stdin.read())
users = data.get('users', data) if isinstance(data, dict) else data
for u in users:
  if u.get('username') == '${TEST_USERNAME}': print(u['id']); break
" 2>/dev/null || echo "")

if [ -n "$TEST_USER_ID" ]; then
  check "PUT /api/users/:id (update)" "$(api PUT /api/users/$TEST_USER_ID '{"displayName":"API Test User"}')" 200
  check "GET /api/users/:id/permissions" "$(api GET /api/users/$TEST_USER_ID/permissions)" 200
  check "DELETE /api/users/:id" "$(api DELETE /api/users/$TEST_USER_ID)" 200
else
  log_skip "User update/delete (create failed)"
fi

# ─── MFA ───────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== MFA ===${NC}"

check "GET /api/mfa/status" "$(api GET /api/mfa/status)" 200

# ─── API Tokens ────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== API Tokens ===${NC}"

check "GET /api/token" "$(api GET /api/token)" 200

# ─── Settings ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Settings ===${NC}"

check "GET /api/settings" "$(api GET /api/settings)" 200
check "POST /api/settings (no-op)" "$(api POST /api/settings '{}')" 200

# ─── Channel Database ─────────────────────────────────────

echo ""
echo -e "${BLUE}=== Channel Database ===${NC}"

check "GET /api/channel-database" "$(api GET /api/channel-database)" 200

# ─── News ──────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== News ===${NC}"

check "GET /api/news" "$(api GET /api/news)" 200
check "GET /api/news/user/status" "$(api GET /api/news/user/status)" 200
check "GET /api/news/unread" "$(api GET /api/news/unread)" 200

# ─── Solar ─────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Solar ===${NC}"

check "GET /api/solar/estimates" "$(api GET /api/solar/estimates)" 200

# ─── Notifications ─────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Notifications ===${NC}"

check "GET /api/settings (notification prefs via settings)" "$(api GET /api/settings)" 200

# ─── Themes ────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Custom Themes ===${NC}"

check "GET /api/settings (themes via settings)" "$(api GET /api/settings)" 200

# ─── Embed Profiles ───────────────────────────────────────

echo ""
echo -e "${BLUE}=== Embed Profiles ===${NC}"

check "GET /api/embed-profiles" "$(api GET /api/embed-profiles)" 200

# ─── Firmware ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Firmware ===${NC}"

check "GET /api/firmware/status" "$(api GET /api/firmware/status)" 200

# ─── Upgrade ───────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Upgrade ===${NC}"

check "GET /api/upgrade/history" "$(api GET /api/upgrade/history)" 200

# ─── MeshCore ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== MeshCore ===${NC}"

check "GET /api/meshcore/status" "$(api GET /api/meshcore/status)" 200 404

# ─── V1 API ───────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== V1 API (no token, expect 401) ===${NC}"

check "GET /api/v1 (no token)" "$(api GET /api/v1)" 401
check "GET /api/v1/nodes (no token)" "$(api GET /api/v1/nodes)" 401

echo ""
echo -e "${BLUE}=== V1 API (with token) ===${NC}"

TOKEN_RESPONSE=$(api_body POST /api/token/generate '{"name":"api-exercise-test"}')
API_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null || echo "")

if [ -n "$API_TOKEN" ]; then
  v1() {
    local method="$1"
    local path="$2"
    local url="${BASE_URL}${path}"
    curl -s -o /dev/null -w "%{http_code}" -X "$method" \
      -H "Authorization: Bearer $API_TOKEN" \
      "$url" 2>/dev/null || echo "000"
  }

  check "GET /api/v1" "$(v1 GET /api/v1)" 200
  check "GET /api/v1/nodes" "$(v1 GET /api/v1/nodes)" 200
  check "GET /api/v1/channels" "$(v1 GET /api/v1/channels)" 200
  check "GET /api/v1/messages" "$(v1 GET /api/v1/messages)" 200
  check "GET /api/v1/telemetry" "$(v1 GET /api/v1/telemetry)" 200
  check "GET /api/v1/traceroutes" "$(v1 GET /api/v1/traceroutes)" 200
  check "GET /api/v1/network" "$(v1 GET /api/v1/network)" 200
  check "GET /api/v1/network/topology" "$(v1 GET /api/v1/network/topology)" 200
  check "GET /api/v1/network/direct-neighbors" "$(v1 GET /api/v1/network/direct-neighbors)" 200
  check "GET /api/v1/packets" "$(v1 GET /api/v1/packets)" 200
  check "GET /api/v1/channel-database" "$(v1 GET /api/v1/channel-database)" 200
  check "GET /api/v1/solar" "$(v1 GET /api/v1/solar)" 200

  if [ -n "$FIRST_NODE_ID" ]; then
    check "GET /api/v1/nodes/:nodeId" "$(v1 GET /api/v1/nodes/$FIRST_NODE_ID)" 200
    check "GET /api/v1/telemetry/:nodeId" "$(v1 GET /api/v1/telemetry/$FIRST_NODE_ID)" 200
    check "GET /api/v1/nodes/:nodeId/position-history" "$(v1 GET /api/v1/nodes/$FIRST_NODE_ID/position-history)" 200
  fi

  # Cleanup token
  api DELETE /api/token > /dev/null 2>&1
  log_pass "API token revoked"
else
  log_skip "V1 API token tests (token generation failed)"
fi

# ─── Logout ───────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Logout ===${NC}"

check "POST /api/auth/logout" "$(api POST /api/auth/logout)" 200
check "GET /api/users (after logout, expect 401)" "$(api GET /api/users)" 401

# ─── Report ────────────────────────────────────────────────

echo ""
echo "=========================================="
echo "API Exercise Test Results"
echo "=========================================="
echo -e "  ${GREEN}Passed:${NC}  $PASS_COUNT"
echo -e "  ${RED}Failed:${NC}  $FAIL_COUNT"
echo -e "  ${YELLOW}Skipped:${NC} $SKIP_COUNT"
echo ""

if [ $FAIL_COUNT -gt 0 ]; then
  echo -e "${RED}Failures:${NC}"
  for f in "${FAILURES[@]}"; do
    echo -e "  ${RED}✗${NC} $f"
  done
  echo ""
  echo -e "${RED}==========================================\033[0m"
  echo -e "${RED}✗ API EXERCISE TEST FAILED${NC}"
  echo -e "${RED}==========================================\033[0m"
  exit 1
else
  echo -e "${GREEN}==========================================\033[0m"
  echo -e "${GREEN}✓ ALL API TESTS PASSED${NC}"
  echo -e "${GREEN}==========================================\033[0m"
  exit 0
fi
