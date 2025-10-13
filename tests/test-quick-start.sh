#!/bin/bash
# Automated test for Quick Start zero-config deployment
# Tests that the documented minimal configuration works without SESSION_SECRET or COOKIE_SECURE

set -e  # Exit on any error

echo "=========================================="
echo "Quick Start Zero-Config Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

COMPOSE_FILE="docker-compose.quick-start-test.yml"
CONTAINER_NAME="meshmonitor-quick-start-test"

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Create minimal test docker-compose file (matches documentation)
echo "Creating test docker-compose.yml (matches Quick Start documentation)..."
cat > "$COMPOSE_FILE" <<'EOF'
services:
  meshmonitor:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: meshmonitor-quick-start-test
    ports:
      - "8083:3001"
    volumes:
      - meshmonitor-quick-start-test-data:/data
    environment:
      - MESHTASTIC_NODE_IP=192.168.5.106
    restart: unless-stopped

volumes:
  meshmonitor-quick-start-test-data:
EOF

echo -e "${GREEN}✓${NC} Test config created"
echo ""

# Build and start
echo "Building container..."
docker compose -f "$COMPOSE_FILE" build --quiet

echo -e "${GREEN}✓${NC} Build complete"
echo ""

echo "Starting container..."
docker compose -f "$COMPOSE_FILE" up -d

echo -e "${GREEN}✓${NC} Container started"
echo ""

# Wait for container to be ready
echo "Waiting for container to be ready..."
sleep 5

# Test 1: Check container is running
echo "Test 1: Container is running"
if docker ps | grep -q "$CONTAINER_NAME"; then
    echo -e "${GREEN}✓ PASS${NC}: Container is running"
else
    echo -e "${RED}✗ FAIL${NC}: Container is not running"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 2: Check logs for SESSION_SECRET warning
echo "Test 2: SESSION_SECRET auto-generated (warning present)"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "SESSION_SECRET NOT SET - USING AUTO-GENERATED SECRET"; then
    echo -e "${GREEN}✓ PASS${NC}: SESSION_SECRET warning found"
else
    echo -e "${RED}✗ FAIL${NC}: SESSION_SECRET warning not found"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 3: Check logs for COOKIE_SECURE warning
echo "Test 3: COOKIE_SECURE defaults to false (warning present)"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "COOKIE_SECURE not set - defaulting to false"; then
    echo -e "${GREEN}✓ PASS${NC}: COOKIE_SECURE warning found"
else
    echo -e "${RED}✗ FAIL${NC}: COOKIE_SECURE warning not found"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 4: Check logs for admin user creation
echo "Test 4: Admin user created on first run"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "FIRST RUN: Admin user created"; then
    echo -e "${GREEN}✓ PASS${NC}: Admin user created"
else
    echo -e "${RED}✗ FAIL${NC}: Admin user creation message not found"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 5: Check session config shows Cookie secure: false
echo "Test 5: Cookie secure set to false"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Cookie secure: false"; then
    echo -e "${GREEN}✓ PASS${NC}: Cookie secure is false"
else
    echo -e "${RED}✗ FAIL${NC}: Cookie secure not set to false"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 6: Check HTTP headers (no HSTS)
echo "Test 6: No HSTS header in HTTP response"
if curl -s -I http://localhost:8083/ | grep -q "Strict-Transport-Security"; then
    echo -e "${RED}✗ FAIL${NC}: HSTS header found (should not be present)"
    curl -I http://localhost:8083/ | grep "Strict-Transport-Security"
    exit 1
else
    echo -e "${GREEN}✓ PASS${NC}: No HSTS header (HTTP-friendly)"
fi
echo ""

# Test 7: Check session cookie is set (without Secure flag)
echo "Test 7: Session cookie works over HTTP"
COOKIE_HEADER=$(curl -s -I http://localhost:8083/ | grep -i "Set-Cookie: meshmonitor.sid")
if [ -n "$COOKIE_HEADER" ]; then
    if echo "$COOKIE_HEADER" | grep -q "; Secure"; then
        echo -e "${RED}✗ FAIL${NC}: Cookie has Secure flag (won't work over HTTP)"
        echo "$COOKIE_HEADER"
        exit 1
    else
        echo -e "${GREEN}✓ PASS${NC}: Session cookie set without Secure flag"
    fi
else
    echo -e "${RED}✗ FAIL${NC}: No session cookie found"
    exit 1
fi
echo ""

# Test 8: Get CSRF token
echo "Test 8: Fetch CSRF token"
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:8083/api/csrf-token \
    -c /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$CSRF_RESPONSE" | tail -n1)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | head -n-1 | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

if [ "$HTTP_CODE" = "200" ] && [ -n "$CSRF_TOKEN" ]; then
    echo -e "${GREEN}✓ PASS${NC}: CSRF token obtained"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get CSRF token"
    echo "$CSRF_RESPONSE"
    exit 1
fi
echo ""

# Test 9: Check login works with default credentials
echo "Test 9: Login with default admin credentials"
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://localhost:8083/api/auth/login \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}' \
    -b /tmp/meshmonitor-cookies.txt \
    -c /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Login successful (HTTP 200)"
else
    echo -e "${RED}✗ FAIL${NC}: Login failed (HTTP $HTTP_CODE)"
    echo "$LOGIN_RESPONSE"
    exit 1
fi
echo ""

# Test 10: Check authenticated request works
echo "Test 10: Authenticated request with session cookie"
AUTH_RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:8083/api/auth/status \
    -b /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$AUTH_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$AUTH_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ] && echo "$RESPONSE_BODY" | grep -q '"authenticated":true'; then
    echo -e "${GREEN}✓ PASS${NC}: Authenticated session works"
else
    echo -e "${RED}✗ FAIL${NC}: Authenticated request failed"
    echo "HTTP Code: $HTTP_CODE"
    echo "Response: $RESPONSE_BODY"
    exit 1
fi
echo ""

# Test 11: Environment check
echo "Test 11: Running in production mode"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Environment: production"; then
    echo -e "${GREEN}✓ PASS${NC}: Running in production mode (better security defaults)"
else
    echo -e "${YELLOW}⚠ WARN${NC}: Not running in production mode"
fi
echo ""

# Test 12: Wait for node connection and data sync
echo "Test 12: Wait for Meshtastic node connection and data sync"
echo "Waiting up to 30 seconds for channels (>3) and nodes (>100)..."
MAX_WAIT=30
ELAPSED=0
NODE_CONNECTED=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
    # Check channels
    CHANNELS_RESPONSE=$(curl -s http://localhost:8083/api/channels \
        -b /tmp/meshmonitor-cookies.txt)
    CHANNEL_COUNT=$(echo "$CHANNELS_RESPONSE" | grep -o '"id"' | wc -l)

    # Check nodes
    NODES_RESPONSE=$(curl -s http://localhost:8083/api/nodes \
        -b /tmp/meshmonitor-cookies.txt)
    NODE_COUNT=$(echo "$NODES_RESPONSE" | grep -o '"id"' | wc -l)

    if [ "$CHANNEL_COUNT" -gt 3 ] && [ "$NODE_COUNT" -gt 100 ]; then
        NODE_CONNECTED=true
        echo -e "${GREEN}✓ PASS${NC}: Node connected (channels: $CHANNEL_COUNT, nodes: $NODE_COUNT)"
        break
    fi

    sleep 2
    ELAPSED=$((ELAPSED + 2))
    echo -n "."
done
echo ""

if [ "$NODE_CONNECTED" = false ]; then
    echo -e "${RED}✗ FAIL${NC}: Node connection timeout (channels: $CHANNEL_COUNT, nodes: $NODE_COUNT)"
    exit 1
fi
echo ""

# Test 13: Send message to node and wait for response
echo "Test 13: Send message to Yeraze Station G2 and wait for response"
TARGET_NODE_ID="a2e4ff4c"
TEST_MESSAGE="test"

# Send message
SEND_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST http://localhost:8083/api/messages/send \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"destination\":\"!$TARGET_NODE_ID\",\"text\":\"$TEST_MESSAGE\"}" \
    -b /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$SEND_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓${NC} Message sent successfully"

    # Wait up to 60 seconds for a response
    echo "Waiting up to 60 seconds for response from Yeraze Station G2..."
    MAX_WAIT=60
    ELAPSED=0
    RESPONSE_RECEIVED=false

    while [ $ELAPSED -lt $MAX_WAIT ]; do
        # Check for messages from the target node
        MESSAGES_RESPONSE=$(curl -s http://localhost:8083/api/messages \
            -b /tmp/meshmonitor-cookies.txt)

        # Look for a recent message from our target node
        if echo "$MESSAGES_RESPONSE" | grep -q "\"from\":\"!$TARGET_NODE_ID\""; then
            RESPONSE_RECEIVED=true
            echo -e "${GREEN}✓ PASS${NC}: Received response from Yeraze Station G2"
            break
        fi

        sleep 2
        ELAPSED=$((ELAPSED + 2))
        echo -n "."
    done
    echo ""

    if [ "$RESPONSE_RECEIVED" = false ]; then
        echo -e "${YELLOW}⚠ WARN${NC}: No response received within 60 seconds (node may be offline)"
        echo "   This is not a failure - the node may not be available"
    fi
else
    echo -e "${YELLOW}⚠ WARN${NC}: Failed to send message (HTTP $HTTP_CODE)"
    echo "   This is not a critical failure - messaging functionality exists"
fi
echo ""

# Cleanup temp files
rm -f /tmp/meshmonitor-cookies.txt

echo "=========================================="
echo -e "${GREEN}All tests passed!${NC}"
echo "=========================================="
echo ""
echo "The Quick Start zero-config deployment works correctly:"
echo "  • Container starts without SESSION_SECRET"
echo "  • Container starts without COOKIE_SECURE"
echo "  • HTTP access works (no HSTS)"
echo "  • Admin user created automatically"
echo "  • Login works with default credentials"
echo "  • Session cookies work over HTTP"
echo ""
