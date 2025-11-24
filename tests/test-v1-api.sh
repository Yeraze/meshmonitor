#!/bin/bash
# System test for v1 Public API
# Tests all v1 API endpoints against a running Quick Start container
#
# This test:
# - Creates an API token via the web interface
# - Calls each v1 API endpoint
# - Verifies basic data validity (counts, known nodes, etc.)
# - Ensures consistent response formats

set -e

echo "=========================================="
echo "V1 Public API System Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

COMPOSE_FILE="docker-compose.quick-start-test.yml"
CONTAINER_NAME="meshmonitor-quick-start-test"
BASE_URL="${TEST_EXTERNAL_APP_URL:-http://localhost:8086}"
TEST_NODE_IP="${TEST_NODE_IP:-192.168.5.106}"

# Test result tracking
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Cleanup function
cleanup() {
    if [ "$KEEP_ALIVE" = "true" ]; then
        echo ""
        echo -e "${YELLOW}⚠ KEEP_ALIVE set to true - Skipping cleanup...${NC}"
        return 0
    fi

    if [ -n "$TEST_EXTERNAL_APP_URL" ]; then
        echo "Cleaning up temp files..."
        rm -f /tmp/meshmonitor-api-test-*.json
        rm -f /tmp/meshmonitor-api-test-cookies-*.txt
        return 0
    fi

    echo ""
    echo "Cleaning up..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
    rm -f /tmp/meshmonitor-api-test-*.json
    rm -f /tmp/meshmonitor-api-test-cookies-*.txt

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Warning: Container ${CONTAINER_NAME} still running, forcing stop..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
    fi

    echo "Cleanup complete"
}

trap cleanup EXIT

# Test helper function
run_test() {
    local test_name="$1"
    local test_command="$2"

    TESTS_RUN=$((TESTS_RUN + 1))
    echo -e "${BLUE}Test $TESTS_RUN:${NC} $test_name"

    if eval "$test_command"; then
        echo -e "${GREEN}✓ PASS${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
        return 0
    else
        echo -e "${RED}✗ FAIL${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# JSON parsing helper (requires jq)
check_json_field() {
    local json="$1"
    local field="$2"
    local expected="$3"

    local actual=$(echo "$json" | jq -r "$field")
    if [ "$actual" = "$expected" ]; then
        return 0
    else
        echo "  Expected '$field' to be '$expected', got '$actual'"
        return 1
    fi
}

# Setup container if not using external URL
if [ -z "$TEST_EXTERNAL_APP_URL" ]; then
    echo "Setting up test container..."
    # Use meshmonitor:test if available (from system test build), otherwise pull latest
    if docker image inspect meshmonitor:test >/dev/null 2>&1; then
        IMAGE="meshmonitor:test"
        echo "Using locally built image: meshmonitor:test"
    else
        IMAGE="ghcr.io/yeraze/meshmonitor:latest"
        echo "Using published image: ghcr.io/yeraze/meshmonitor:latest"
    fi

    cat > "$COMPOSE_FILE" << EOF
services:
  meshmonitor:
    image: ${IMAGE}
    container_name: ${CONTAINER_NAME}
    ports:
      - "8086:3001"
    environment:
      - MESHTASTIC_NODE_IP=${TEST_NODE_IP}
      - TZ=UTC
    volumes:
      - meshmonitor-v1-api-test-data:/data
    restart: unless-stopped

volumes:
  meshmonitor-v1-api-test-data:
EOF

    docker compose -f "$COMPOSE_FILE" up -d

    echo "Waiting for container to be ready..."
    max_attempts=30
    attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "${BASE_URL}/health" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ Container is ready${NC}"
            break
        fi
        attempt=$((attempt + 1))
        sleep 2
    done

    if [ $attempt -eq $max_attempts ]; then
        echo -e "${RED}✗ Container failed to become ready${NC}"
        exit 1
    fi

    # Wait for container to be ready (following pattern from test-quick-start.sh)
    echo "Waiting for container to initialize..."
    sleep 5

    # Poll for admin user creation (check docker logs instead of trying to login)
    echo "Waiting for admin user creation..."
    max_wait_attempts=30  # 30 attempts * 2 seconds = 60 seconds max
    wait_attempt=0

    while [ $wait_attempt -lt $max_wait_attempts ]; do
        if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "FIRST RUN: Admin user created"; then
            echo -e "${GREEN}✓ Admin user created${NC}"
            # Give password hashing and DB commits a moment to complete
            sleep 5
            break
        fi
        wait_attempt=$((wait_attempt + 1))
        sleep 2
    done

    if [ $wait_attempt -eq $max_wait_attempts ]; then
        echo -e "${RED}✗ Admin user creation not detected in logs${NC}"
        docker logs "$CONTAINER_NAME"
        exit 1
    fi
fi

echo ""
echo "=========================================="
echo "Step 1: Generate API Token"
echo "=========================================="

# Get CSRF token first
echo "Getting CSRF token..."
COOKIE_FILE="/tmp/meshmonitor-api-test-cookies-$$.txt"
CSRF_TOKEN=$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    "${BASE_URL}/api/csrf-token" \
    | jq -r '.csrfToken // empty')

if [ -z "$CSRF_TOKEN" ] || [ "$CSRF_TOKEN" = "null" ]; then
    echo -e "${RED}✗ Failed to get CSRF token${NC}"
    exit 1
fi

echo -e "${GREEN}✓ CSRF token obtained${NC}"

# Login to web interface with retry logic
echo "Logging in to web interface..."
max_login_attempts=10
login_attempt=0
LOGIN_SUCCESS=false

while [ $login_attempt -lt $max_login_attempts ]; do
    LOGIN_RESPONSE=$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
        -X POST "${BASE_URL}/api/auth/login" \
        -H "Content-Type: application/json" \
        -H "x-csrf-token: $CSRF_TOKEN" \
        -d '{"username":"admin","password":"changeme"}')

    # Check if login was successful (no error field in response)
    if echo "$LOGIN_RESPONSE" | jq -e '.error' >/dev/null 2>&1; then
        ERROR_MSG=$(echo "$LOGIN_RESPONSE" | jq -r '.error')
        login_attempt=$((login_attempt + 1))
        if [ $login_attempt -lt $max_login_attempts ]; then
            echo "Login attempt $login_attempt failed ($ERROR_MSG), retrying in 5 seconds..."
            sleep 5
        fi
    else
        LOGIN_SUCCESS=true
        break
    fi
done

if [ "$LOGIN_SUCCESS" != "true" ]; then
    echo -e "${RED}✗ Failed to login after $max_login_attempts attempts${NC}"
    echo "Last error: $ERROR_MSG"
    echo "Container may not be fully ready. Try increasing wait time or check container logs."
    exit 1
fi

echo -e "${GREEN}✓ Logged in successfully${NC}"

# Generate API token
echo "Generating API token..."
API_RESPONSE=$(curl -sS -c "$COOKIE_FILE" -b "$COOKIE_FILE" \
    -X POST "${BASE_URL}/api/token/generate" \
    -H "Content-Type: application/json" \
    -H "x-csrf-token: $CSRF_TOKEN")

API_TOKEN=$(echo "$API_RESPONSE" | jq -r '.token // empty')

if [ -z "$API_TOKEN" ] || [ "$API_TOKEN" = "null" ]; then
    echo -e "${RED}✗ Failed to generate API token${NC}"
    echo "Response: $API_RESPONSE"
    exit 1
fi

echo -e "${GREEN}✓ API Token generated: ${API_TOKEN:0:15}...${NC}"

echo ""
echo "=========================================="
echo "Step 2: Test V1 API Endpoints"
echo "=========================================="
echo ""

# Test 1: API Root Endpoint
run_test "GET /api/v1/ - API version info" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/' \
    | jq -e '.version == \"v1\" and .endpoints.nodes != null'"

# Test 2: Nodes List
run_test "GET /api/v1/nodes - List all nodes" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/nodes' \
    | jq -e '.success == true and .count > 0 and (.data | type) == \"array\"'"

# Test 3: Verify node count is reasonable (at least 1 node, the test node)
run_test "Verify node count >= 1" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/nodes' \
    | jq -e '.count >= 1'"

# Test 4: Get specific node by ID (get first node's ID)
NODE_ID=$(curl -sS -H "Authorization: Bearer $API_TOKEN" \
    "${BASE_URL}/api/v1/nodes" \
    | jq -r '.data[0].node_id')

if [ -n "$NODE_ID" ] && [ "$NODE_ID" != "null" ]; then
    run_test "GET /api/v1/nodes/:id - Get specific node" \
        "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
        '${BASE_URL}/api/v1/nodes/${NODE_ID}' \
        | jq -e '.success == true and .data.node_id == $NODE_ID'"
fi

# Test 5: Messages endpoint
run_test "GET /api/v1/messages - List messages" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/messages?limit=10' \
    | jq -e '.success == true and (.data | type) == \"array\"'"

# Test 7: Telemetry endpoint
run_test "GET /api/v1/telemetry - List telemetry data" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/telemetry' \
    | jq -e '.success == true and (.data | type) == \"array\"'"

# Test 8: Traceroutes endpoint
run_test "GET /api/v1/traceroutes - List traceroutes" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/traceroutes' \
    | jq -e '.success == true and (.data | type) == \"array\"'"

# Test 6: Network stats endpoint
run_test "GET /api/v1/network - Get network stats" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/network' \
    | jq -e '.success == true and .data.totalNodes != null'"

# Test 10: Packets endpoint
run_test "GET /api/v1/packets - List packet logs" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/packets?limit=50' \
    | jq -e '.success == true and .limit == 50 and (.data | type) == \"array\"'"

# Test 11: Packets with filtering
run_test "GET /api/v1/packets with filter - Filter by encrypted" \
    "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
    '${BASE_URL}/api/v1/packets?encrypted=true&limit=10' \
    | jq -e '.success == true and (.data | type) == \"array\"'"

# Test 12: Get specific packet (if any exist)
PACKET_ID=$(curl -sS -H "Authorization: Bearer $API_TOKEN" \
    "${BASE_URL}/api/v1/packets?limit=1" \
    | jq -r '.data[0].id // empty')

if [ -n "$PACKET_ID" ] && [ "$PACKET_ID" != "null" ]; then
    run_test "GET /api/v1/packets/:id - Get specific packet" \
        "curl -sS -H 'Authorization: Bearer $API_TOKEN' \
        '${BASE_URL}/api/v1/packets/${PACKET_ID}' \
        | jq -e '.success == true and .data.id == $PACKET_ID'"
fi

echo ""
echo "=========================================="
echo "Step 3: Test Authentication"
echo "=========================================="
echo ""

# Test 13: Reject request without token
run_test "Reject request without Authorization header" \
    "[ \$(curl -sS -w '%{http_code}' -o /dev/null '${BASE_URL}/api/v1/nodes') = '401' ]"

# Test 14: Reject request with invalid token
run_test "Reject request with invalid token" \
    "[ \$(curl -sS -w '%{http_code}' -o /dev/null \
    -H 'Authorization: Bearer mm_v1_invalid_token_123' \
    '${BASE_URL}/api/v1/nodes') = '401' ]"

echo ""
echo "=========================================="
echo "Step 4: Test Response Format Consistency"
echo "=========================================="
echo ""

# Test 15: All list endpoints have consistent success field
run_test "All list endpoints return success: true" \
    "for endpoint in nodes messages telemetry traceroutes packets; do
        curl -sS -H 'Authorization: Bearer $API_TOKEN' \
            \"${BASE_URL}/api/v1/\$endpoint\" \
            | jq -e '.success == true' > /dev/null || exit 1
    done"

# Test 16: All list endpoints have data array
run_test "All list endpoints return data array" \
    "for endpoint in nodes messages telemetry traceroutes packets; do
        curl -sS -H 'Authorization: Bearer $API_TOKEN' \
            \"${BASE_URL}/api/v1/\$endpoint\" \
            | jq -e '(.data | type) == \"array\"' > /dev/null || exit 1
    done"

# Test 17: All list endpoints have count field
run_test "All list endpoints return count field" \
    "for endpoint in nodes messages telemetry traceroutes packets; do
        curl -sS -H 'Authorization: Bearer $API_TOKEN' \
            \"${BASE_URL}/api/v1/\$endpoint\" \
            | jq -e '.count != null' > /dev/null || exit 1
    done"

echo ""
echo "=========================================="
echo "Test Results"
echo "=========================================="
echo ""
echo "Total tests run: $TESTS_RUN"
echo -e "${GREEN}Tests passed: $TESTS_PASSED${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}Tests failed: $TESTS_FAILED${NC}"
else
    echo "Tests failed: $TESTS_FAILED"
fi
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}=========================================="
    echo "All tests passed!"
    echo -e "==========================================${NC}"
    exit 0
else
    echo -e "${RED}=========================================="
    echo "Some tests failed!"
    echo -e "==========================================${NC}"
    exit 1
fi
