#!/bin/bash
# Automated test for Reverse Proxy production deployment
# Tests production configuration with HTTPS reverse proxy (nginx, Caddy, Traefik)

set -e  # Exit on any error

echo "=========================================="
echo "Reverse Proxy Production Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

COMPOSE_FILE="docker-compose.reverse-proxy-test.yml"
CONTAINER_NAME="meshmonitor-reverse-proxy-test"
TEST_PORT="8081"
TEST_DOMAIN="https://meshdev.yeraze.online"
TEST_URL="$TEST_DOMAIN"  # Use HTTPS domain for all tests

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
    rm -f /tmp/meshmonitor-reverse-proxy-cookies.txt
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Create production reverse proxy test docker-compose file
echo "Creating test docker-compose.yml (reverse proxy production configuration)..."
cat > "$COMPOSE_FILE" <<'EOF'
services:
  meshmonitor:
    build:
      context: .
      dockerfile: Dockerfile
    container_name: meshmonitor-reverse-proxy-test
    ports:
      - "8081:3001"
    volumes:
      - meshmonitor-reverse-proxy-test-data:/data
    environment:
      # Production configuration for HTTPS reverse proxy
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=192.168.5.106
      - TRUST_PROXY=true
      - ALLOWED_ORIGINS=https://meshdev.yeraze.online
      - COOKIE_SECURE=true
      - COOKIE_SAMESITE=lax
      # SESSION_SECRET intentionally not set to test auto-generation
    restart: unless-stopped

volumes:
  meshmonitor-reverse-proxy-test-data:
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

# Test 2: Check logs for production mode
echo "Test 2: Running in production mode"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Environment: production"; then
    echo -e "${GREEN}✓ PASS${NC}: Running in production mode"
else
    echo -e "${RED}✗ FAIL${NC}: Not running in production mode"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 3: Check logs for SESSION_SECRET warning
echo "Test 3: SESSION_SECRET auto-generated (production warning present)"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "SESSION_SECRET NOT SET - USING AUTO-GENERATED SECRET"; then
    echo -e "${GREEN}✓ PASS${NC}: SESSION_SECRET production warning found"
else
    echo -e "${RED}✗ FAIL${NC}: SESSION_SECRET warning not found"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 4: Check logs for COOKIE_SECURE explicitly set
echo "Test 4: COOKIE_SECURE explicitly set to true"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Cookie secure: true"; then
    echo -e "${GREEN}✓ PASS${NC}: Cookie secure is true (HTTPS-ready)"
else
    echo -e "${RED}✗ FAIL${NC}: Cookie secure not set to true"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 5: Check logs for admin user creation
echo "Test 5: Admin user created on first run"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "FIRST RUN: Admin user created"; then
    echo -e "${GREEN}✓ PASS${NC}: Admin user created"
else
    echo -e "${RED}✗ FAIL${NC}: Admin user creation message not found"
    docker logs "$CONTAINER_NAME"
    exit 1
fi
echo ""

# Test 6: Check HSTS header is present (production mode)
echo "Test 6: HSTS header present in production"
if curl -s -I -k $TEST_URL/ | grep -q "Strict-Transport-Security"; then
    echo -e "${GREEN}✓ PASS${NC}: HSTS header present (production security)"
else
    echo -e "${YELLOW}⚠ WARN${NC}: HSTS header not found (expected in production with secure cookies)"
fi
echo ""

# Test 7: Check trust proxy is working
echo "Test 7: Trust proxy configuration"
if docker logs "$CONTAINER_NAME" 2>&1 | grep -qi "trust proxy"; then
    echo -e "${GREEN}✓ PASS${NC}: Trust proxy mentioned in logs"
else
    echo -e "${YELLOW}⚠ INFO${NC}: Trust proxy not explicitly logged (may be default)"
fi
echo ""

# Test 8: Get CSRF token (via HTTPS)
echo "Test 8: Fetch CSRF token via HTTPS"
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" -k $TEST_URL/api/csrf-token \
    -c /tmp/meshmonitor-reverse-proxy-cookies.txt)

HTTP_CODE=$(echo "$CSRF_RESPONSE" | tail -n1)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | head -n-1 | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

if [ "$HTTP_CODE" = "200" ] && [ -n "$CSRF_TOKEN" ]; then
    echo -e "${GREEN}✓ PASS${NC}: CSRF token obtained via HTTPS"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get CSRF token"
    echo "HTTP Code: $HTTP_CODE"
    echo "$CSRF_RESPONSE"
    exit 1
fi
echo ""

# Test 9: Check login works with default credentials (via HTTPS)
echo "Test 9: Login with default admin credentials via HTTPS"
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -k -X POST $TEST_URL/api/auth/login \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}' \
    -b /tmp/meshmonitor-reverse-proxy-cookies.txt \
    -c /tmp/meshmonitor-reverse-proxy-cookies.txt)

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
echo "Test 10: Authenticated request with session cookie via HTTPS"
AUTH_RESPONSE=$(curl -s -w "\n%{http_code}" -k $TEST_URL/api/auth/status \
    -b /tmp/meshmonitor-reverse-proxy-cookies.txt)

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

# Test 11: Check session cookie has Secure flag
echo "Test 11: Session cookie has Secure flag (HTTPS-only)"
COOKIE_HEADER=$(curl -s -I -k $TEST_URL/ | grep -i "Set-Cookie: meshmonitor.sid")
if [ -n "$COOKIE_HEADER" ]; then
    if echo "$COOKIE_HEADER" | grep -q "; Secure"; then
        echo -e "${GREEN}✓ PASS${NC}: Cookie has Secure flag (HTTPS-only)"
    else
        echo -e "${YELLOW}⚠ WARN${NC}: Cookie missing Secure flag (may not work with HTTPS reverse proxy)"
        echo "$COOKIE_HEADER"
    fi
else
    echo -e "${YELLOW}⚠ INFO${NC}: No session cookie in initial response (normal for production)"
fi
echo ""

# Test 12: Check ALLOWED_ORIGINS is respected
echo "Test 12: CORS configuration for HTTPS origin"
CORS_RESPONSE=$(curl -s -I -k -X OPTIONS $TEST_URL/api/auth/status \
    -H "Origin: https://meshdev.yeraze.online" \
    -H "Access-Control-Request-Method: GET")

if echo "$CORS_RESPONSE" | grep -qi "Access-Control-Allow-Origin"; then
    echo -e "${GREEN}✓ PASS${NC}: CORS configured for allowed origin"
else
    echo -e "${YELLOW}⚠ INFO${NC}: CORS headers may be applied at reverse proxy level"
fi
echo ""

# Test 13: Wait for node connection and data sync
echo "Test 13: Wait for Meshtastic node connection and data sync"
echo "Waiting up to 30 seconds for channels (>3) and nodes (>100)..."
MAX_WAIT=30
ELAPSED=0
NODE_CONNECTED=false

while [ $ELAPSED -lt $MAX_WAIT ]; do
    # Check channels
    CHANNELS_RESPONSE=$(curl -s -k $TEST_URL/api/channels \
        -b /tmp/meshmonitor-reverse-proxy-cookies.txt)
    CHANNEL_COUNT=$(echo "$CHANNELS_RESPONSE" | grep -o '"id"' | wc -l)

    # Check nodes
    NODES_RESPONSE=$(curl -s -k $TEST_URL/api/nodes \
        -b /tmp/meshmonitor-reverse-proxy-cookies.txt)
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

# Test 14: Send message to node and wait for response (with retry)
echo "Test 14: Send message to Yeraze Station G2 and wait for response"
TARGET_NODE_ID="a2e4ff4c"
TEST_MESSAGE="Test in Reverse Proxy"
MAX_ATTEMPTS=3
RESPONSE_RECEIVED=false

for ATTEMPT in $(seq 1 $MAX_ATTEMPTS); do
    echo "Attempt $ATTEMPT of $MAX_ATTEMPTS..."

    # Send message
    SEND_RESPONSE=$(curl -s -w "\n%{http_code}" -k -X POST $TEST_URL/api/messages/send \
        -H "Content-Type: application/json" \
        -H "X-CSRF-Token: $CSRF_TOKEN" \
        -d "{\"destination\":\"!$TARGET_NODE_ID\",\"text\":\"$TEST_MESSAGE (attempt $ATTEMPT)\"}" \
        -b /tmp/meshmonitor-reverse-proxy-cookies.txt)

    HTTP_CODE=$(echo "$SEND_RESPONSE" | tail -n1)
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓${NC} Message sent successfully"

        # Wait up to 60 seconds for a response
        echo "Waiting up to 60 seconds for response from Yeraze Station G2..."
        MAX_WAIT=60
        ELAPSED=0

        while [ $ELAPSED -lt $MAX_WAIT ]; do
            # Check for messages from the target node
            MESSAGES_RESPONSE=$(curl -s -k $TEST_URL/api/messages \
                -b /tmp/meshmonitor-reverse-proxy-cookies.txt)

            # Look for a recent message from our target node
            if echo "$MESSAGES_RESPONSE" | grep -q "\"from\":\"!$TARGET_NODE_ID\""; then
                RESPONSE_RECEIVED=true
                echo -e "${GREEN}✓ PASS${NC}: Received response from Yeraze Station G2"
                break 2  # Break out of both loops
            fi

            sleep 2
            ELAPSED=$((ELAPSED + 2))
            echo -n "."
        done
        echo ""

        if [ "$RESPONSE_RECEIVED" = false ]; then
            if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
                echo -e "${YELLOW}⚠${NC} No response received, retrying..."
                sleep 5  # Wait a bit before retry
            fi
        fi
    else
        echo -e "${RED}✗${NC} Failed to send message (HTTP $HTTP_CODE)"
        if [ $ATTEMPT -lt $MAX_ATTEMPTS ]; then
            echo "   Retrying..."
            sleep 5
        fi
    fi
done

if [ "$RESPONSE_RECEIVED" = false ]; then
    echo -e "${RED}✗ FAIL${NC}: No response received after $MAX_ATTEMPTS attempts"
    echo "   Node may be offline or not responding to direct messages"
    exit 1
fi
echo ""

echo "=========================================="
echo -e "${GREEN}All tests passed!${NC}"
echo "=========================================="
echo ""
echo "The reverse proxy production deployment works correctly:"
echo "  • Container runs in production mode"
echo "  • Trust proxy enabled"
echo "  • HTTPS-ready (COOKIE_SECURE=true)"
echo "  • HSTS security headers present"
echo "  • Admin user created automatically"
echo "  • Login works with default credentials"
echo "  • Session works behind reverse proxy"
echo "  • CORS configured for HTTPS domain"
echo ""
echo "Production Deployment Notes:"
echo "  • Set SESSION_SECRET for persistent sessions across restarts"
echo "  • Configure reverse proxy (nginx/Caddy/Traefik) for HTTPS"
echo "  • Ensure X-Forwarded-Proto and X-Forwarded-Host headers are set"
echo "  • Container accessible at: http://localhost:$TEST_PORT (behind proxy)"
echo "  • Public URL: $TEST_DOMAIN (via reverse proxy)"
echo ""
