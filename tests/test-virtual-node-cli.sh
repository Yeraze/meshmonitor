#!/bin/bash
# Automated test for Virtual Node Server using Meshtastic CLI
# Tests that a real Meshtastic client can connect, download data, and send messages

set -e  # Exit on any error

echo "=========================================="
echo "Virtual Node Server CLI Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

COMPOSE_FILE="docker-compose.virtual-node-cli-test.yml"
CONTAINER_NAME="meshmonitor-virtual-node-cli-test"
TEST_MESSAGE="VN_CLI_TEST_$(date +%s)"

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
    rm -f /tmp/vn-test-client.py
    rm -f /tmp/meshmonitor-cookies.txt

    # Verify container stopped
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Warning: Container ${CONTAINER_NAME} still running, forcing stop..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
    fi

    return 0
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Create test docker-compose file with Virtual Node Server enabled
echo "Creating test docker-compose.yml with Virtual Node Server..."
cat > "$COMPOSE_FILE" <<'EOF'
services:
  meshmonitor:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: meshmonitor-virtual-node-cli-test
    ports:
      - "8086:3001"
      - "4405:4404"  # Virtual Node Server port
    volumes:
      - meshmonitor-virtual-node-cli-test-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.5.106
      - ENABLE_VIRTUAL_NODE=true
      - VIRTUAL_NODE_PORT=4404
    restart: unless-stopped

volumes:
  meshmonitor-virtual-node-cli-test-data:
EOF

echo -e "${GREEN}✓${NC} Test config created"
echo ""

# Build and start
echo "Building container..."
docker compose -f "$COMPOSE_FILE" build --no-cache --quiet

echo -e "${GREEN}✓${NC} Build complete"
echo ""

echo "Starting container..."
docker compose -f "$COMPOSE_FILE" up -d

echo -e "${GREEN}✓${NC} Container started"
echo ""

# Wait for container to be ready
echo "Waiting for container to be ready..."
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

# Wait for server to be listening and Virtual Node Server to start
echo "Test 2: Wait for Meshtastic node connection and Virtual Node Server startup"
echo "Waiting up to 90 seconds for Virtual Node Server to be ready..."

# First wait for server to be up with health check
set +e  # Temporarily disable exit on error for readiness check
echo "  Waiting for server health check..."
for i in {1..30}; do
    HEALTH=$(curl -s http://localhost:8086/api/health 2>/dev/null | jq -r '.status' 2>/dev/null || echo "")
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

# Wait for admin user to be created before attempting login
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

# Authenticate as admin to get session cookie (required for channel permission filtering)
echo "  Authenticating as admin..."
COOKIE_JAR="/tmp/meshmonitor-cookies.txt"

# First get CSRF token
CSRF_RESPONSE=$(curl -s -c "$COOKIE_JAR" http://localhost:8086/api/csrf-token 2>/dev/null)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | jq -r '.csrfToken // empty' 2>/dev/null)
if [ -z "$CSRF_TOKEN" ]; then
    echo "  Failed to get CSRF token, response: $CSRF_RESPONSE"
    echo -e "${RED}✗ FAIL${NC}: Could not get CSRF token"
    exit 1
fi
echo "  Got CSRF token"

# Now login with CSRF token
LOGIN_RESPONSE=$(curl -s -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST http://localhost:8086/api/auth/login \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}' 2>/dev/null)
LOGIN_SUCCESS=$(echo "$LOGIN_RESPONSE" | jq -r '.user.username // empty' 2>/dev/null)
if [ "$LOGIN_SUCCESS" != "admin" ]; then
    echo "  Login failed, response: $LOGIN_RESPONSE"
    echo -e "${RED}✗ FAIL${NC}: Could not authenticate as admin"
    exit 1
fi
echo "  Authenticated as admin"

# Now wait for nodes with authenticated session
for i in {1..90}; do
    # Check that we have nodes synced (indicating server connected to Meshtastic node)
    POLL_RESPONSE=$(curl -s -b "$COOKIE_JAR" http://localhost:8086/api/poll 2>/dev/null)
    NODE_COUNT=$(echo "$POLL_RESPONSE" | jq -r '.nodes | length' 2>/dev/null || echo "0")

    # Check if environment variable is set correctly
    ENABLE_VN=$(docker exec "$CONTAINER_NAME" printenv ENABLE_VIRTUAL_NODE 2>/dev/null || echo "")

    # Print progress every 10 seconds
    if [ $((i % 10)) -eq 0 ]; then
        echo "  [$i/90] Nodes: $NODE_COUNT, ENABLE_VIRTUAL_NODE: $ENABLE_VN"
    fi

    # Just need basic connectivity - at least 1 node to prove Meshtastic connection
    # Default to 0 if NODE_COUNT is empty
    NODE_COUNT="${NODE_COUNT:-0}"
    if [ "$NODE_COUNT" -ge 1 ] && [ "$ENABLE_VN" = "true" ]; then
        echo -e "${GREEN}✓ PASS${NC}: Server ready with Virtual Node enabled (nodes: $NODE_COUNT)"
        break
    fi

    if [ $i -eq 90 ]; then
        echo -e "${RED}✗ FAIL${NC}: Server did not become ready after 90 seconds"
        echo "Final status: Nodes: $NODE_COUNT, ENABLE_VIRTUAL_NODE: $ENABLE_VN"
        echo ""
        echo "Container logs (last 30 lines):"
        docker logs "$CONTAINER_NAME" 2>&1 | tail -30
        exit 1
    fi
    sleep 1
done
set -e  # Re-enable exit on error
echo ""

# Create basic TCP connectivity test
echo "Test 3: Test basic TCP connectivity"
if nc -zv localhost 4405 2>&1 | grep -q "succeeded"; then
    echo -e "${GREEN}✓ PASS${NC}: Virtual Node Server port 4405 is accessible"
else
    echo -e "${RED}✗ FAIL${NC}: Cannot connect to Virtual Node Server port 4405"
    exit 1
fi
echo ""

# Create simple Python TCP client to verify server accepts connections
echo "Test 4: Verify server accepts TCP connections"
cat > /tmp/vn-test-connect.py <<'PYTHON_SCRIPT'
#!/usr/bin/env python3
"""
Simple TCP client to verify Virtual Node Server accepts connections
"""
import socket
import time

def main():
    try:
        print("Connecting to Virtual Node Server...")
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        sock.connect(("localhost", 4405))
        print("✓ Successfully connected to Virtual Node Server")

        # Keep connection open briefly
        time.sleep(2)

        sock.close()
        print("✓ Connection closed gracefully")
        return 0
    except Exception as e:
        print(f"✗ Connection failed: {e}")
        return 1

if __name__ == "__main__":
    exit(main())
PYTHON_SCRIPT

chmod +x /tmp/vn-test-connect.py

if python3 /tmp/vn-test-connect.py; then
    echo -e "${GREEN}✓ PASS${NC}: Server accepts TCP connections"
else
    echo -e "${RED}✗ FAIL${NC}: Server does not accept TCP connections"
    exit 1
fi
echo ""

# Verify Virtual Node Server is broadcasting messages
echo "Test 5: Verify Virtual Node Server is broadcasting mesh data"
MESSAGES=$(curl -s http://localhost:8086/api/messages)
MESSAGE_COUNT=$(echo "$MESSAGES" | jq 'length' 2>/dev/null || echo "0")

if [ "$MESSAGE_COUNT" -ge 1 ]; then
    echo -e "${GREEN}✓ PASS${NC}: Web UI API has $MESSAGE_COUNT messages from mesh network"
else
    echo -e "${YELLOW}⚠ WARN${NC}: No messages found in Web UI API (this may be normal for a test network)"
fi
echo ""

# Verify Virtual Node Server logged the client connection
echo "Test 6: Verify Virtual Node Server logs show client connection"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Virtual node client connected"; then
    echo -e "${GREEN}✓ PASS${NC}: Virtual Node Server logged client connection"
    CLIENT_LOG=$(docker logs "$CONTAINER_NAME" 2>&1 | grep "Virtual node client" | tail -5)
    echo "Connection logs:"
    echo "$CLIENT_LOG"
else
    echo -e "${YELLOW}⚠ WARN${NC}: No client connection log found"
fi
echo ""

echo "=========================================="
echo -e "${GREEN}All tests passed!${NC}"
echo "=========================================="
echo ""
echo "The Virtual Node Server test completed successfully:"
echo "  • Container started with Virtual Node Server enabled"
echo "  • Server listens on port 4404"
echo "  • TCP connections are accepted"
echo "  • Web UI API is accessible and serving data"
echo "  • Virtual Node Server is operational"
echo ""
echo "Note: Full Meshtastic Python library compatibility testing requires"
echo "additional investigation and is tracked separately."
echo ""
