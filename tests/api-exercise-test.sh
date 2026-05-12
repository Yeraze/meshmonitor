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

# Make an API request returning both status and body (separated by newline)
api_full() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local url="${BASE_URL}${path}"

  local curl_args=(-s -w "\n%{http_code}" -b "$COOKIE_FILE" -c "$COOKIE_FILE")
  curl_args+=(-X "$method")

  if [ -n "$CSRF_TOKEN" ]; then
    curl_args+=(-H "X-CSRF-Token: $CSRF_TOKEN")
  fi

  if [ -n "$body" ]; then
    curl_args+=(-H "Content-Type: application/json")
    curl_args+=(-d "$body")
  fi

  curl "${curl_args[@]}" "$url" 2>/dev/null || echo -e "\n000"
}

# Check response status AND validate JSON body structure using Python
# Usage: check_json "description" "METHOD" "/path" "python_validation_expr"
# The python expression receives the parsed JSON as 'data' and should return True/False
# Example: check_json "GET /api/nodes" "GET" "/api/nodes" "isinstance(data, list) and len(data) >= 0"
check_json() {
  local desc="$1"
  local method="$2"
  local path="$3"
  local validation="$4"
  local expected_status="${5:-200}"

  local response
  response=$(api_full "$method" "$path")
  local status
  status=$(echo "$response" | tail -1)
  local body
  body=$(echo "$response" | sed '$d')

  if [ "$status" != "$expected_status" ]; then
    log_fail "$desc" "HTTP ${status} (expected ${expected_status})"
    return 0
  fi

  # Validate JSON structure
  local valid
  valid=$(echo "$body" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = bool(${validation})
    print('OK' if result else 'FAIL')
except Exception as e:
    print(f'ERR:{e}')
" 2>/dev/null || echo "ERR:python failed")

  if [ "$valid" = "OK" ]; then
    log_pass "$desc (${status}, body validated)"
  elif [[ "$valid" == ERR:* ]]; then
    log_fail "$desc" "JSON parse error: ${valid#ERR:}"
  else
    log_fail "$desc" "body validation failed (HTTP ${status})"
  fi

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

check_json "GET /api/status" "GET" "/api/status" "'status' in data"
check_json "GET /api/stats" "GET" "/api/stats" "'messageCount' in data and 'nodeCount' in data and 'channelCount' in data"
check_json "GET /api/config" "GET" "/api/config" "isinstance(data, dict)"
check_json "GET /api/config/current" "GET" "/api/config/current" "isinstance(data, dict)"
check_json "GET /api/connection" "GET" "/api/connection" "'connected' in data"
check_json "GET /api/connection/info" "GET" "/api/connection/info" "isinstance(data, dict)"
check "GET /api/version/check" "$(api GET /api/version/check)" 200
check_json "GET /api/virtual-node/status" "GET" "/api/virtual-node/status" "'sources' in data"
check_json "GET /api/nodes" "GET" "/api/nodes" "isinstance(data, list)"
check_json "GET /api/nodes/active" "GET" "/api/nodes/active" "isinstance(data, list)"
check_json "GET /api/ignored-nodes" "GET" "/api/ignored-nodes" "isinstance(data, list)"
check "GET /api/auto-favorite/status" "$(api GET /api/auto-favorite/status)" 200
check "GET /api/device/tx-status" "$(api GET /api/device/tx-status)" 200
check "GET /api/device/security-keys" "$(api GET /api/device/security-keys)" 200

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

check_json "GET /api/telemetry/available/nodes" "GET" "/api/telemetry/available/nodes" "isinstance(data, (list, dict))"

if [ -n "$FIRST_NODE_ID" ]; then
  check "GET /api/telemetry/:nodeId" "$(api GET /api/telemetry/$FIRST_NODE_ID)" 200
  check "GET /api/telemetry/:nodeId/rates" "$(api GET /api/telemetry/$FIRST_NODE_ID/rates)" 200
  check "GET /api/telemetry/:nodeId/smarthops" "$(api GET /api/telemetry/$FIRST_NODE_ID/smarthops)" 200
  check "GET /api/telemetry/:nodeId/linkquality" "$(api GET /api/telemetry/$FIRST_NODE_ID/linkquality)" 200
else
  log_skip "Telemetry endpoints (no nodes)"
fi

# ─── Messages ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Messages ===${NC}"

check_json "GET /api/messages" "GET" "/api/messages" "isinstance(data, list)"
check_json "GET /api/messages/channel/0" "GET" "/api/messages/channel/0" "'messages' in data"
check_json "GET /api/messages/search?q=test" "GET" "/api/messages/search?q=test" "'success' in data and 'data' in data"
check_json "GET /api/messages/unread-counts" "GET" "/api/messages/unread-counts" "'channels' in data"

# ─── Traceroutes ───────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Traceroutes ===${NC}"

check_json "GET /api/traceroutes/recent" "GET" "/api/traceroutes/recent" "isinstance(data, list)"
check "GET /api/route-segments/record-holder" "$(api GET /api/route-segments/record-holder)" 200
check "GET /api/route-segments/longest-active" "$(api GET /api/route-segments/longest-active)" 200

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

check_json "GET /api/channels" "GET" "/api/channels" "isinstance(data, list)"
check_json "GET /api/channels/all" "GET" "/api/channels/all" "isinstance(data, list)"
# /api/channels/debug removed in MM-SEC-6 — leaked PSKs to messages:read holders.

# ─── Packets ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Packets ===${NC}"

check_json "GET /api/packets" "GET" "/api/packets" "'packets' in data and 'total' in data"
check_json "GET /api/packets?limit=10" "GET" "/api/packets?limit=10" "'packets' in data and isinstance(data['packets'], list)"
check_json "GET /api/packets/stats" "GET" "/api/packets/stats" "'total' in data"
check_json "GET /api/packets/stats/distribution" "GET" "/api/packets/stats/distribution" "'byDevice' in data and 'byType' in data"
check "GET /api/packets/relay-nodes" "$(api GET /api/packets/relay-nodes)" 200
check "GET /api/packets/export?limit=10" "$(api GET '/api/packets/export?limit=10')" 200

# ─── Audit ─────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Audit Logs ===${NC}"

check_json "GET /api/audit" "GET" "/api/audit" "'logs' in data and 'total' in data"
check_json "GET /api/audit?limit=10" "GET" "/api/audit?limit=10" "'logs' in data and 'total' in data"
check_json "GET /api/audit/stats/summary" "GET" "/api/audit/stats/summary" "isinstance(data, dict)"

# ─── Security ─────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Security ===${NC}"

check_json "GET /api/security/issues" "GET" "/api/security/issues" "'total' in data and 'nodes' in data"
check_json "GET /api/security/scanner/status" "GET" "/api/security/scanner/status" "'running' in data"
check_json "GET /api/security/key-mismatches" "GET" "/api/security/key-mismatches" "'events' in data"
check_json "GET /api/security/dead-nodes" "GET" "/api/security/dead-nodes" "'nodes' in data and 'count' in data"
check "GET /api/security/export" "$(api GET /api/security/export)" 200

# ─── User Management ──────────────────────────────────────

echo ""
echo -e "${BLUE}=== User Management ===${NC}"

check_json "GET /api/users" "GET" "/api/users" "isinstance(data, (list, dict)) and (isinstance(data, list) or 'users' in data)"

ADMIN_ID=$(api_body GET /api/users | python3 -c "
import sys,json
data = json.loads(sys.stdin.read())
users = data.get('users', data) if isinstance(data, dict) else data
for u in users:
  if u.get('username') == 'admin': print(u['id']); break
" 2>/dev/null || echo "1")

check "GET /api/users/:id" "$(api GET /api/users/$ADMIN_ID)" 200
check "GET /api/users/:id/permissions" "$(api GET /api/users/$ADMIN_ID/permissions)" 200
check "GET /api/users/:id/channel-database-permissions" "$(api GET /api/users/$ADMIN_ID/channel-database-permissions)" 200

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

check_json "GET /api/settings" "GET" "/api/settings" "isinstance(data, dict)"
check "POST /api/settings (no-op)" "$(api POST /api/settings '{}')" 200
check_json "GET /api/settings/traceroute-nodes" "GET" "/api/settings/traceroute-nodes" "isinstance(data, (list, dict))"
check_json "GET /api/settings/traceroute-log" "GET" "/api/settings/traceroute-log" "'success' in data and 'log' in data"
check "GET /api/settings/time-sync-nodes" "$(api GET /api/settings/time-sync-nodes)" 200
check "GET /api/settings/auto-ping" "$(api GET /api/settings/auto-ping)" 200
check "GET /api/settings/key-repair-log" "$(api GET /api/settings/key-repair-log)" 200
check "GET /api/settings/distance-delete/log" "$(api GET /api/settings/distance-delete/log)" 200

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
check "GET /api/solar/estimates/range" "$(api GET '/api/solar/estimates/range?start=0&end=9999999999999')" 200

# ─── Push Notifications ───────────────────────────────────

echo ""
echo -e "${BLUE}=== Push Notifications ===${NC}"

check "GET /api/push/status" "$(api GET /api/push/status)" 200
check "GET /api/push/vapid-key" "$(api GET /api/push/vapid-key)" 200
check "GET /api/push/preferences" "$(api GET /api/push/preferences)" 200

# ─── Apprise ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Apprise ===${NC}"

check "GET /api/apprise/status" "$(api GET /api/apprise/status)" 200
check "GET /api/apprise/urls" "$(api GET /api/apprise/urls)" 200

# ─── Themes ────────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Custom Themes ===${NC}"

check "GET /api/themes" "$(api GET /api/themes)" 200

# ─── Map Preferences ──────────────────────────────────────

echo ""
echo -e "${BLUE}=== Map Preferences ===${NC}"

check "GET /api/user/map-preferences" "$(api GET /api/user/map-preferences)" 200
check "POST /api/user/map-preferences" "$(api POST /api/user/map-preferences '{"showRoute":true,"showNeighborInfo":false,"showMqttNodes":true}')" 200
check "GET /api/user/map-preferences (after save)" "$(api GET /api/user/map-preferences)" 200

# ─── Embed Profiles ───────────────────────────────────────

echo ""
echo -e "${BLUE}=== Embed Profiles ===${NC}"

check "GET /api/embed-profiles" "$(api GET /api/embed-profiles)" 200

# ─── Maintenance ──────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Maintenance ===${NC}"

check_json "GET /api/maintenance/status" "GET" "/api/maintenance/status" "isinstance(data, dict)"
check_json "GET /api/maintenance/size" "GET" "/api/maintenance/size" "isinstance(data, dict)"

# ─── Backups ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Backups ===${NC}"

check_json "GET /api/backup/list" "GET" "/api/backup/list" "isinstance(data, list)"
check_json "GET /api/backup/settings" "GET" "/api/backup/settings" "isinstance(data, dict)"
check_json "GET /api/system/backup/list" "GET" "/api/system/backup/list" "isinstance(data, list)"
check_json "GET /api/system/backup/settings" "GET" "/api/system/backup/settings" "isinstance(data, dict)"
check_json "GET /api/system/status" "GET" "/api/system/status" "isinstance(data, dict)"

# ─── Ghost Nodes ──────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Ghost Nodes ===${NC}"

check "GET /api/admin/suppressed-ghosts" "$(api GET /api/admin/suppressed-ghosts)" 200

# ─── Announcements ────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Announcements ===${NC}"

check "GET /api/announce/last" "$(api GET /api/announce/last)" 200
check "GET /api/announce/preview" "$(api GET /api/announce/preview)" 200 400

# ─── Firmware ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Firmware ===${NC}"

check "GET /api/firmware/status" "$(api GET /api/firmware/status)" 200
check "GET /api/firmware/releases" "$(api GET /api/firmware/releases)" 200
check "GET /api/firmware/backups" "$(api GET /api/firmware/backups)" 200

# ─── Upgrade ───────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== Upgrade ===${NC}"

check "GET /api/upgrade/history" "$(api GET /api/upgrade/history)" 200
check "GET /api/upgrade/status" "$(api GET /api/upgrade/status)" 200

# ─── MeshCore ──────────────────────────────────────────────

echo ""
echo -e "${BLUE}=== MeshCore ===${NC}"

check "GET /api/meshcore/status" "$(api GET /api/meshcore/status)" 200 404
check "GET /api/meshcore/nodes" "$(api GET /api/meshcore/nodes)" 200 404
check "GET /api/meshcore/contacts" "$(api GET /api/meshcore/contacts)" 200 404
check "GET /api/meshcore/messages" "$(api GET /api/meshcore/messages)" 200 404

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

  # V1 API needs its own check_json since it uses Bearer token auth
  v1_body() {
    local method="$1"
    local path="$2"
    local url="${BASE_URL}${path}"
    curl -s -w "\n%{http_code}" -X "$method" \
      -H "Authorization: Bearer $API_TOKEN" \
      "$url" 2>/dev/null || echo -e "\n000"
  }

  check_v1() {
    local desc="$1"
    local path="$2"
    local validation="$3"
    local response
    response=$(v1_body GET "$path")
    local status
    status=$(echo "$response" | tail -1)
    local body
    body=$(echo "$response" | sed '$d')

    if [ "$status" != "200" ]; then
      log_fail "$desc" "HTTP ${status} (expected 200)"
      return 0
    fi

    local valid
    valid=$(echo "$body" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    result = bool(${validation})
    print('OK' if result else 'FAIL')
except Exception as e:
    print(f'ERR:{e}')
" 2>/dev/null || echo "ERR:python failed")

    if [ "$valid" = "OK" ]; then
      log_pass "$desc (200, body validated)"
    elif [[ "$valid" == ERR:* ]]; then
      log_fail "$desc" "JSON parse error: ${valid#ERR:}"
    else
      log_fail "$desc" "body validation failed"
    fi
  }

  check_v1 "GET /api/v1" "/api/v1" "'version' in data or 'success' in data"
  check_v1 "GET /api/v1/nodes" "/api/v1/nodes" "'success' in data and 'data' in data"
  check_v1 "GET /api/v1/channels" "/api/v1/channels" "'success' in data and 'data' in data"
  check_v1 "GET /api/v1/messages" "/api/v1/messages" "'success' in data and 'data' in data"
  check_v1 "GET /api/v1/telemetry" "/api/v1/telemetry" "'success' in data or isinstance(data, dict)"
  check_v1 "GET /api/v1/traceroutes" "/api/v1/traceroutes" "'success' in data and 'data' in data"
  check_v1 "GET /api/v1/network" "/api/v1/network" "'success' in data and 'data' in data"
  check_v1 "GET /api/v1/network/topology" "/api/v1/network/topology" "'success' in data and 'data' in data"
  check_v1 "GET /api/v1/network/direct-neighbors" "/api/v1/network/direct-neighbors" "'success' in data or isinstance(data, dict)"
  check_v1 "GET /api/v1/packets" "/api/v1/packets" "'success' in data and 'data' in data"
  check_v1 "GET /api/v1/channel-database" "/api/v1/channel-database" "'success' in data and 'data' in data"
  check "GET /api/v1/solar" "$(v1 GET /api/v1/solar)" 200
  check "GET /api/v1/solar/range" "$(v1 GET '/api/v1/solar/range?start=0&end=9999999999999')" 200
  check "GET /api/v1/messages/search?q=test" "$(v1 GET '/api/v1/messages/search?q=test')" 200
  check "GET /api/v1/docs/openapi.json" "$(v1 GET /api/v1/docs/openapi.json)" 200
  check "GET /api/v1/docs/openapi.yaml" "$(v1 GET /api/v1/docs/openapi.yaml)" 200

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
