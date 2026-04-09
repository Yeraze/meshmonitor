#!/bin/bash
# Automated test for the per-source Virtual Node Server (Phase 7, 4.0+).
#
# Creates a meshmonitor container pointed at a real Meshtastic node, then
# uses the per-source API to enable Virtual Node on the auto-created default
# source and verifies that a TCP client can connect to the VN endpoint.

set -e

echo "=========================================="
echo "Virtual Node Server CLI Test (per-source)"
echo "=========================================="
echo ""

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

COMPOSE_FILE="docker-compose.virtual-node-cli-test.yml"
CONTAINER_NAME="meshmonitor-virtual-node-cli-test"
WEB_PORT=8086
VN_PORT=4405          # host-side mapped port
VN_INTERNAL_PORT=4404 # port inside the container / configured on the source

cleanup() {
    echo ""
    echo "Cleaning up..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
    rm -f /tmp/vn-test-connect.py
    rm -f /tmp/meshmonitor-cookies.txt

    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Warning: Container ${CONTAINER_NAME} still running, forcing stop..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
    fi
    return 0
}

trap cleanup EXIT

echo "Creating test docker-compose.yml..."
cat > "$COMPOSE_FILE" <<EOF
services:
  meshmonitor:
    image: meshmonitor:test
    container_name: ${CONTAINER_NAME}
    ports:
      - "${WEB_PORT}:3001"
      - "${VN_PORT}:${VN_INTERNAL_PORT}"
    volumes:
      - meshmonitor-virtual-node-cli-test-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.5.106
    restart: unless-stopped

volumes:
  meshmonitor-virtual-node-cli-test-data:
EOF

echo -e "${GREEN}✓${NC} Test config created"
echo ""

echo "Starting container..."
docker compose -f "$COMPOSE_FILE" up -d
echo -e "${GREEN}✓${NC} Container started"
echo ""

echo "Test 1: Container is running"
for i in {1..30}; do
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo -e "${GREEN}✓ PASS${NC}: Container is running"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}✗ FAIL${NC}: Container failed to start"
        exit 1
    fi
    sleep 1
done
echo ""

echo "Test 2: Wait for server, admin user, and default source"
set +e

echo "  Waiting for server health check..."
for i in {1..30}; do
    HEALTH=$(curl -s http://localhost:${WEB_PORT}/api/health 2>/dev/null | jq -r '.status' 2>/dev/null || echo "")
    if [ "$HEALTH" = "ok" ]; then
        echo "  Server health check passed"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}✗ FAIL${NC}: Server health check failed after 30 seconds"
        exit 1
    fi
    sleep 1
done

echo "  Waiting for admin user creation..."
for i in {1..30}; do
    if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "FIRST RUN: Admin user created"; then
        echo "  Admin user created"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}✗ FAIL${NC}: Admin user not created after 30 seconds"
        docker logs "$CONTAINER_NAME" 2>&1 | tail -20
        exit 1
    fi
    sleep 1
done

COOKIE_JAR="/tmp/meshmonitor-cookies.txt"

echo "  Authenticating as admin..."
CSRF_RESPONSE=$(curl -s -c "$COOKIE_JAR" http://localhost:${WEB_PORT}/api/csrf-token 2>/dev/null)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | jq -r '.csrfToken // empty' 2>/dev/null)
if [ -z "$CSRF_TOKEN" ]; then
    echo -e "${RED}✗ FAIL${NC}: Could not get CSRF token"
    exit 1
fi

LOGIN_RESPONSE=$(curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST http://localhost:${WEB_PORT}/api/auth/login \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}' 2>/dev/null)
LOGIN_SUCCESS=$(echo "$LOGIN_RESPONSE" | jq -r '.user.username // empty' 2>/dev/null)
if [ "$LOGIN_SUCCESS" != "admin" ]; then
    echo -e "${RED}✗ FAIL${NC}: Could not authenticate as admin"
    exit 1
fi
echo "  Authenticated as admin"

# The default source is auto-created from MESHTASTIC_NODE_IP on first boot.
# Refresh the CSRF token after login (sessions rotate it).
CSRF_TOKEN=$(curl -s -b "$COOKIE_JAR" http://localhost:${WEB_PORT}/api/csrf-token 2>/dev/null | jq -r '.csrfToken // empty')

echo "  Waiting for default source to appear..."
SOURCE_ID=""
for i in {1..30}; do
    SOURCES_JSON=$(curl -s -b "$COOKIE_JAR" http://localhost:${WEB_PORT}/api/sources 2>/dev/null)
    SOURCE_ID=$(echo "$SOURCES_JSON" | jq -r '.[] | select(.type=="meshtastic_tcp") | .id' 2>/dev/null | head -1)
    if [ -n "$SOURCE_ID" ] && [ "$SOURCE_ID" != "null" ]; then
        echo "  Default source id: $SOURCE_ID"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}✗ FAIL${NC}: No meshtastic_tcp source appeared within 30 seconds"
        echo "$SOURCES_JSON"
        exit 1
    fi
    sleep 1
done

# Read the existing config so we can preserve host/port while adding virtualNode.
SOURCE_CFG=$(echo "$SOURCES_JSON" | jq -c --arg id "$SOURCE_ID" '.[] | select(.id==$id) | .config')

echo "Test 3: Enable Virtual Node on the default source via API"
NEW_CFG=$(echo "$SOURCE_CFG" | jq --argjson port "$VN_INTERNAL_PORT" \
    '. + {virtualNode: {enabled: true, port: $port, allowAdminCommands: false}}')

PUT_BODY=$(jq -n --argjson cfg "$NEW_CFG" '{config: $cfg}')
PUT_RESP=$(curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -X PUT "http://localhost:${WEB_PORT}/api/sources/${SOURCE_ID}" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "$PUT_BODY" 2>/dev/null)

RESULT_VN_ENABLED=$(echo "$PUT_RESP" | jq -r '.config.virtualNode.enabled // empty' 2>/dev/null)
if [ "$RESULT_VN_ENABLED" != "true" ]; then
    echo -e "${RED}✗ FAIL${NC}: Virtual Node did not come back enabled in PUT response"
    echo "$PUT_RESP"
    exit 1
fi
echo -e "${GREEN}✓ PASS${NC}: Virtual Node enabled on source $SOURCE_ID (port $VN_INTERNAL_PORT)"
echo ""

echo "Test 4: Wait for Virtual Node TCP port to open"
for i in {1..30}; do
    if nc -zv localhost ${VN_PORT} 2>&1 | grep -q "succeeded"; then
        echo -e "${GREEN}✓ PASS${NC}: Virtual Node port ${VN_PORT} is accessible"
        break
    fi
    if [ $i -eq 30 ]; then
        echo -e "${RED}✗ FAIL${NC}: Virtual Node port ${VN_PORT} did not open within 30 seconds"
        docker logs "$CONTAINER_NAME" 2>&1 | tail -30
        exit 1
    fi
    sleep 1
done
set -e
echo ""

echo "Test 5: Python TCP client connects successfully"
cat > /tmp/vn-test-connect.py <<PYTHON_SCRIPT
#!/usr/bin/env python3
import socket
import sys
import time

try:
    print("Connecting to Virtual Node Server...")
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(5)
    sock.connect(("localhost", ${VN_PORT}))
    print("✓ Successfully connected")
    time.sleep(2)
    sock.close()
    print("✓ Connection closed gracefully")
    sys.exit(0)
except Exception as e:
    print(f"✗ Connection failed: {e}")
    sys.exit(1)
PYTHON_SCRIPT

if python3 /tmp/vn-test-connect.py; then
    echo -e "${GREEN}✓ PASS${NC}: Server accepts TCP connections"
else
    echo -e "${RED}✗ FAIL${NC}: Server does not accept TCP connections"
    exit 1
fi
echo ""

echo "Test 6: /api/virtual-node/status reports the source as enabled"
STATUS_JSON=$(curl -s -b "$COOKIE_JAR" http://localhost:${WEB_PORT}/api/virtual-node/status 2>/dev/null)
ENABLED_COUNT=$(echo "$STATUS_JSON" | jq '[.sources[] | select(.enabled==true)] | length' 2>/dev/null || echo "0")
if [ "$ENABLED_COUNT" -ge 1 ]; then
    echo -e "${GREEN}✓ PASS${NC}: Virtual node status reports $ENABLED_COUNT enabled source(s)"
else
    echo -e "${RED}✗ FAIL${NC}: Virtual node status did not report any enabled sources"
    echo "$STATUS_JSON"
    exit 1
fi
echo ""

echo "Test 7: Virtual Node logs show client connection"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Virtual node client connected"; then
    echo -e "${GREEN}✓ PASS${NC}: Virtual Node Server logged client connection"
    docker logs "$CONTAINER_NAME" 2>&1 | grep "Virtual node client" | tail -5
else
    echo -e "${YELLOW}⚠ WARN${NC}: No client connection log found"
fi
echo ""

echo "=========================================="
echo -e "${GREEN}All tests passed!${NC}"
echo "=========================================="
echo ""
echo "The per-source Virtual Node test completed successfully:"
echo "  • Container started without legacy VN env vars"
echo "  • Default source auto-created from MESHTASTIC_NODE_IP"
echo "  • Virtual Node enabled per-source via PUT /api/sources/:id"
echo "  • TCP endpoint opened on port ${VN_INTERNAL_PORT} (host ${VN_PORT})"
echo "  • Python TCP client connected successfully"
echo "  • /api/virtual-node/status reports the enabled source"
echo ""
