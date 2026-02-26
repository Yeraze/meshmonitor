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

# Configuration
TEST_NODE_IP="${TEST_NODE_IP:-192.168.5.106}"

# Cleanup function
cleanup() {
    if [ "$KEEP_ALIVE" = "true" ]; then
        echo ""
        echo -e "${YELLOW}⚠ KEEP_ALIVE set to true - Skipping cleanup...${NC}"
        return 0
    fi

    # If we didn't create the container (External App Mode), we don't need to clean it up
    if [ -n "$TEST_EXTERNAL_APP_URL" ]; then
        echo ""
        echo "Cleaning up temp files..."
        rm -f /tmp/meshmonitor-cookies.txt
        return 0
    fi

    echo ""
    echo "Cleaning up..."
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
    rm -f /tmp/meshmonitor-cookies.txt

    # Verify container stopped (don't fail on cleanup issues)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
        echo "Warning: Container ${CONTAINER_NAME} still running, forcing stop..."
        docker stop "$CONTAINER_NAME" 2>/dev/null || true
        docker rm "$CONTAINER_NAME" 2>/dev/null || true
    fi

    # Always return success from cleanup
    return 0
}

# Set trap to cleanup on exit
trap cleanup EXIT

# Determine mode
if [ -n "$TEST_EXTERNAL_APP_URL" ]; then
    echo -e "${YELLOW}Running in EXTERNAL APP MODE${NC}"
    echo "Target URL: $TEST_EXTERNAL_APP_URL"
    BASE_URL="$TEST_EXTERNAL_APP_URL"
    # Remove trailing slash if present
    BASE_URL=${BASE_URL%/}
else
    echo -e "${GREEN}Running in CONTAINER MODE${NC}"
    echo "Target Node IP: $TEST_NODE_IP"
    
    # Create minimal test docker-compose file (matches documentation)
    echo "Creating test docker-compose.yml (matches Quick Start documentation)..."
    cat > "$COMPOSE_FILE" <<EOF
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
      - MESHTASTIC_NODE_IP=$TEST_NODE_IP
    restart: unless-stopped

volumes:
  meshmonitor-quick-start-test-data:
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

    # Wait for container to be ready (API must respond before checking logs)
    echo "Waiting for API to be ready..."
    BASE_URL="http://localhost:8083"

    COUNTER=0
    MAX_WAIT=60
    while [ $COUNTER -lt $MAX_WAIT ]; do
        # Check if API is responding (poll endpoint returns JSON with "connection" field)
        POLL_RESPONSE=$(curl -s "$BASE_URL/api/poll" 2>/dev/null || echo "{}")
        if echo "$POLL_RESPONSE" | grep -q '"connection"'; then
            echo -e "${GREEN}✓${NC} API is ready"
            break
        fi
        COUNTER=$((COUNTER + 1))
        if [ $COUNTER -eq $MAX_WAIT ]; then
            echo -e "${RED}✗ FAIL${NC}: API did not become ready within $MAX_WAIT seconds"
            echo "Container logs:"
            docker logs "$CONTAINER_NAME" 2>&1 | tail -30
            exit 1
        fi
        sleep 1
    done

    # Give a moment for admin user to be created after API is ready
    sleep 2
fi

# Only run container checks if we are in Container Mode
if [ -z "$TEST_EXTERNAL_APP_URL" ]; then
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
else
    echo "Skipping container log checks (External App Mode)"
    echo ""
fi

# Test 6: Check HTTP headers (no HSTS)
echo "Test 6: No HSTS header in HTTP response"
if curl -s -I $BASE_URL/ | grep -q "Strict-Transport-Security"; then
    echo -e "${RED}✗ FAIL${NC}: HSTS header found (should not be present)"
    curl -I $BASE_URL/ | grep "Strict-Transport-Security"
    exit 1
else
    echo -e "${GREEN}✓ PASS${NC}: No HSTS header (HTTP-friendly)"
fi
echo ""

# Test 7: Check session cookie is set (without Secure flag)
echo "Test 7: Session cookie works over HTTP"
COOKIE_HEADER=$(curl -s -I $BASE_URL/ | grep -i "Set-Cookie: meshmonitor.sid")
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
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/csrf-token \
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
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST $BASE_URL/api/auth/login \
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

# Re-fetch CSRF token after login (session is regenerated on auth)
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/csrf-token \
    -b /tmp/meshmonitor-cookies.txt \
    -c /tmp/meshmonitor-cookies.txt)
HTTP_CODE=$(echo "$CSRF_RESPONSE" | tail -n1)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | head -n-1 | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

if [ "$HTTP_CODE" = "200" ] && [ -n "$CSRF_TOKEN" ]; then
    echo -e "${GREEN}✓${NC} Post-login CSRF token obtained"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get post-login CSRF token"
    exit 1
fi
echo ""

# Test 10: Check authenticated request works
echo "Test 10: Authenticated request with session cookie"
AUTH_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/auth/status \
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

# Test 11: Environment check (Container Mode only)
if [ -z "$TEST_EXTERNAL_APP_URL" ]; then
    echo "Test 11: Running in production mode"
    if docker logs "$CONTAINER_NAME" 2>&1 | grep -q "Environment: production"; then
        echo -e "${GREEN}✓ PASS${NC}: Running in production mode (better security defaults)"
    else
        echo -e "${YELLOW}⚠ WARN${NC}: Not running in production mode"
    fi
    echo ""
else
    echo "Skipping environment check (External App Mode)"
    echo ""
fi

# Test 12: Wait for node connection and data sync
echo "Test 12: Wait for Meshtastic node connection and data sync"
echo "Waiting up to 30 seconds for channels (>=3) and nodes (>100)..."
MAX_WAIT=30
ELAPSED=0
NODE_CONNECTED=false
SLEEP_INTERVAL=1  # Start with 1 second

while [ $ELAPSED -lt $MAX_WAIT ]; do
    # Check channels
    CHANNELS_RESPONSE=$(curl -s $BASE_URL/api/channels \
        -b /tmp/meshmonitor-cookies.txt)
    CHANNEL_COUNT=$(echo "$CHANNELS_RESPONSE" | grep -o '"id"' | wc -l)

    # Check nodes
    NODES_RESPONSE=$(curl -s $BASE_URL/api/nodes \
        -b /tmp/meshmonitor-cookies.txt)
    NODE_COUNT=$(echo "$NODES_RESPONSE" | grep -o '"id"' | wc -l)

    if [ "$CHANNEL_COUNT" -ge 3 ] && [ "$NODE_COUNT" -gt 100 ]; then
        NODE_CONNECTED=true
        echo -e "${GREEN}✓ PASS${NC}: Node connected (channels: $CHANNEL_COUNT, nodes: $NODE_COUNT)"
        break
    fi

    # Exponential backoff: 1s, 2s, 4s, 8s (capped at 8s)
    sleep $SLEEP_INTERVAL
    ELAPSED=$((ELAPSED + SLEEP_INTERVAL))
    
    # Double interval for next iteration, cap at 8 seconds
    if [ $SLEEP_INTERVAL -lt 8 ]; then
        SLEEP_INTERVAL=$((SLEEP_INTERVAL * 2))
    fi
    
    echo -n "."
done
echo ""

if [ "$NODE_CONNECTED" = false ]; then
    echo -e "${RED}✗ FAIL${NC}: Node connection timeout (channels: $CHANNEL_COUNT, nodes: $NODE_COUNT)"
    exit 1
fi
echo ""

# Test 13: Verify Meshtastic device configuration (CRITICAL - runs after sync)
echo "Test 13: Verify Meshtastic device configuration (CRITICAL)"

# Get device config
DEVICE_CONFIG=$(curl -s $BASE_URL/api/device-config \
    -b /tmp/meshmonitor-cookies.txt)

# Verify modem preset is Medium Fast
MODEM_PRESET=$(echo "$DEVICE_CONFIG" | grep -o '"modemPreset":"[^"]*"' | head -1 | cut -d'"' -f4)
if [ "$MODEM_PRESET" = "Medium Fast" ]; then
    echo -e "${GREEN}✓${NC} Modem preset: Medium Fast"
else
    echo -e "${RED}✗ FAIL${NC}: Expected modem preset 'Medium Fast', got '$MODEM_PRESET'"
    exit 1
fi

# Verify frequency slot is 0
FREQUENCY_SLOT=$(echo "$DEVICE_CONFIG" | grep -o '"channelNum":[0-9]*' | head -1 | cut -d':' -f2)
if [ "$FREQUENCY_SLOT" = "0" ]; then
    echo -e "${GREEN}✓${NC} Frequency slot: 0"
else
    echo -e "${RED}✗ FAIL${NC}: Expected frequency slot 0, got $FREQUENCY_SLOT"
    exit 1
fi

# Verify TX is enabled (CRITICAL)
TX_ENABLED=$(echo "$DEVICE_CONFIG" | grep -o '"txEnabled":[^,}]*' | head -1 | cut -d':' -f2 | tr -d ' ')
if [ "$TX_ENABLED" = "true" ]; then
    echo -e "${GREEN}✓${NC} TX Enabled: true (CRITICAL)"
else
    echo -e "${RED}✗ FAIL${NC}: TX is DISABLED - MeshMonitor requires TX enabled to send messages"
    echo "   This is a CRITICAL failure - users cannot send messages with TX disabled"
    exit 1
fi

# Verify Channel 0 is Primary (role=1) and unnamed
CHANNEL_0_DATA=$(echo "$CHANNELS_RESPONSE" | grep -o '"id":0[^}]*}')
CHANNEL_0_ROLE=$(echo "$CHANNEL_0_DATA" | grep -o '"role":[0-9]*' | cut -d':' -f2)
CHANNEL_0_NAME=$(echo "$CHANNEL_0_DATA" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)

if [ "$CHANNEL_0_ROLE" = "1" ]; then
    echo -e "${GREEN}✓${NC} Channel 0 role: Primary (1)"
else
    echo -e "${RED}✗ FAIL${NC}: Expected Channel 0 role 1 (Primary), got $CHANNEL_0_ROLE"
    echo "   Channel 0 data: $CHANNEL_0_DATA"
    exit 1
fi

if [ -z "$CHANNEL_0_NAME" ] || [ "$CHANNEL_0_NAME" = "null" ]; then
    echo -e "${GREEN}✓${NC} Channel 0 name: unnamed"
else
    echo -e "${RED}✗ FAIL${NC}: Expected Channel 0 to be unnamed, got '$CHANNEL_0_NAME'"
    exit 1
fi

# Verify Channel 1 is Secondary (role=2) and named "meshmonitor"
CHANNEL_1_DATA=$(echo "$CHANNELS_RESPONSE" | grep -o '"id":1[^}]*}')
CHANNEL_1_ROLE=$(echo "$CHANNEL_1_DATA" | grep -o '"role":[0-9]*' | cut -d':' -f2)
CHANNEL_1_NAME=$(echo "$CHANNEL_1_DATA" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)

if [ "$CHANNEL_1_ROLE" = "2" ]; then
    echo -e "${GREEN}✓${NC} Channel 1 role: Secondary (2)"
else
    echo -e "${RED}✗ FAIL${NC}: Expected Channel 1 role 2 (Secondary), got $CHANNEL_1_ROLE"
    exit 1
fi

if [ "$CHANNEL_1_NAME" = "meshmonitor" ]; then
    echo -e "${GREEN}✓${NC} Channel 1 name: meshmonitor"
else
    echo -e "${RED}✗ FAIL${NC}: Expected Channel 1 name 'meshmonitor', got '$CHANNEL_1_NAME'"
    exit 1
fi

echo -e "${GREEN}✓ PASS${NC}: All configuration requirements verified"
echo ""

# Test 13.1: Apprise Configuration Tests
echo "=========================================="
echo "Apprise Notification Configuration Tests"
echo "=========================================="
echo ""

# Test 13.1: Verify fresh container has no Apprise URLs configured
echo "Test 13.1: Verify fresh container has no Apprise URLs (API and file)"

# Check API returns empty array
APPRISE_URLS_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/apprise/urls \
    -b /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$APPRISE_URLS_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$APPRISE_URLS_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
    # Check if response contains empty array
    if echo "$RESPONSE_BODY" | grep -q '"urls":\[\]'; then
        echo -e "${GREEN}✓ PASS${NC}: API reports no URLs configured (empty array)"
    else
        echo -e "${RED}✗ FAIL${NC}: API should return empty array on fresh container"
        echo "   Response: $RESPONSE_BODY"
        exit 1
    fi
else
    echo -e "${RED}✗ FAIL${NC}: Failed to read Apprise URLs (HTTP $HTTP_CODE)"
    exit 1
fi

# Check file doesn't exist or is empty (Only in Container Mode)
if [ -z "$TEST_EXTERNAL_APP_URL" ]; then
    CONFIG_FILE_CHECK=$(docker exec "$CONTAINER_NAME" sh -c 'if [ -f /data/apprise-config/urls.txt ]; then cat /data/apprise-config/urls.txt; else echo "__FILE_NOT_FOUND__"; fi' 2>&1)

    if echo "$CONFIG_FILE_CHECK" | grep -q "__FILE_NOT_FOUND__"; then
        echo -e "${GREEN}✓ PASS${NC}: Config file does not exist (fresh start)"
    elif [ -z "$CONFIG_FILE_CHECK" ] || ! echo "$CONFIG_FILE_CHECK" | grep -v '^[[:space:]]*$' | grep -q .; then
        echo -e "${GREEN}✓ PASS${NC}: Config file exists but is empty (fresh start)"
    else
        echo -e "${RED}✗ FAIL${NC}: Config file should not exist or be empty on fresh start"
        echo "   File contents: $CONFIG_FILE_CHECK"
        exit 1
    fi
else
    echo "Skipping config file check (External App Mode)"
fi
echo ""

# Test 13.2: Configure sample Apprise URLs from various providers
echo "Test 13.2: Configure sample Apprise URLs from various providers"
echo "Configuring 8 test URLs (Telegram, Discord, Slack, SMTP, Pushover, Webhook, MQTT, Gotify)..."

# Create diverse sample URLs to test validation and persistence
SAMPLE_URLS='{"urls": [
  "tgram://1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ123456/123456789",
  "discord://webhook_id/webhook_token",
  "slack://TokenA/TokenB/TokenC",
  "smtp://user:password@smtp.example.com:587/?from=noreply@example.com&to=alert@example.com",
  "pushover://user_key@token",
  "webhook://example.com/notify",
  "mqtt://user:pass@mqtt.example.com:1883/meshmonitor/alerts",
  "gotify://hostname/token"
]}'

CONFIGURE_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST $BASE_URL/api/apprise/configure \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "$SAMPLE_URLS" \
    -b /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$CONFIGURE_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$CONFIGURE_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Apprise URLs configured successfully"
    echo "   Response: $RESPONSE_BODY"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to configure Apprise URLs (HTTP $HTTP_CODE)"
    echo "   Response: $RESPONSE_BODY"
    exit 1
fi
echo ""

# Test 13.3: Verify URLs persisted to config file (Only in Container Mode)
echo "Test 13.3: Verify URLs persisted to /data/apprise-config/urls.txt in container"
if [ -z "$TEST_EXTERNAL_APP_URL" ]; then
    CONFIG_FILE_CONTENT=$(docker exec "$CONTAINER_NAME" cat /data/apprise-config/urls.txt 2>/dev/null)

    if [ -n "$CONFIG_FILE_CONTENT" ]; then
        LINE_COUNT=$(echo "$CONFIG_FILE_CONTENT" | wc -l)
        echo -e "${GREEN}✓ PASS${NC}: Config file exists with $LINE_COUNT lines"
        echo "   First 3 URLs from file:"
        echo "$CONFIG_FILE_CONTENT" | head -3 | sed 's/^/     /'

        # Verify key URLs are present
        if echo "$CONFIG_FILE_CONTENT" | grep -q "tgram://"; then
            echo -e "${GREEN}✓${NC} Telegram URL found"
        else
            echo -e "${RED}✗ FAIL${NC}: Telegram URL not found in config file"
            exit 1
        fi

        if echo "$CONFIG_FILE_CONTENT" | grep -q "discord://"; then
            echo -e "${GREEN}✓${NC} Discord URL found"
        else
            echo -e "${RED}✗ FAIL${NC}: Discord URL not found in config file"
            exit 1
        fi
    else
        echo -e "${RED}✗ FAIL${NC}: Config file does not exist or is empty"
        exit 1
    fi
else
    echo "Skipping config file persistence check (External App Mode)"
fi
echo ""

# Test 13.4: Read URLs back from API to confirm persistence
echo "Test 13.4: Read URLs back from API to confirm they persisted"
VERIFY_URLS_RESPONSE=$(curl -s -w "\n%{http_code}" $BASE_URL/api/apprise/urls \
    -b /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$VERIFY_URLS_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$VERIFY_URLS_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ]; then
    URL_COUNT=$(echo "$RESPONSE_BODY" | grep -o '"tgram://' | wc -l)
    if [ "$URL_COUNT" -ge 1 ]; then
        echo -e "${GREEN}✓ PASS${NC}: URLs retrieved from API after persistence"
        echo "   Found $URL_COUNT URLs in response"
    else
        echo -e "${RED}✗ FAIL${NC}: URLs not found in API response"
        echo "   Response: $RESPONSE_BODY"
        exit 1
    fi
else
    echo -e "${RED}✗ FAIL${NC}: Failed to read URLs (HTTP $HTTP_CODE)"
    exit 1
fi
echo ""

# Test 13.5: Check Apprise logs for diagnostic output (Only in Container Mode)
echo "Test 13.5: Verify Apprise diagnostic logging is working"
if [ -z "$TEST_EXTERNAL_APP_URL" ]; then
    APPRISE_LOGS=$(docker logs "$CONTAINER_NAME" 2>&1 | grep -A 10 "Apprise API server" || true)

    if echo "$APPRISE_LOGS" | grep -q "Loaded.*notification URLs from config"; then
        echo -e "${GREEN}✓ PASS${NC}: Apprise diagnostic logging is working"
        # Show the load summary line
        LOAD_LINE=$(docker logs "$CONTAINER_NAME" 2>&1 | grep "Loaded.*notification URLs from config" | tail -1)
        echo "   $LOAD_LINE"
    else
        echo -e "${YELLOW}⚠ WARN${NC}: Apprise diagnostic logging not found (may need container restart)"
    fi
else
    echo "Skipping log check (External App Mode)"
fi
echo ""

# Test 13.6: Test send notification (expect it to fail with fake URLs, but test the flow)
echo "Test 13.6: Test notification send flow (will fail with fake URLs)"
TEST_NOTIFY_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST $BASE_URL/api/apprise/test \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -b /tmp/meshmonitor-cookies.txt)

HTTP_CODE=$(echo "$TEST_NOTIFY_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$TEST_NOTIFY_RESPONSE" | head -n-1)

# We expect this to fail (400 or 500) because the URLs are fake
if [ "$HTTP_CODE" = "400" ] || [ "$HTTP_CODE" = "500" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Test notification returned expected error (HTTP $HTTP_CODE)"
    echo "   Response: $RESPONSE_BODY"

    # Check if error message is informative
    if echo "$RESPONSE_BODY" | grep -q "notification\|URL\|configured"; then
        echo -e "${GREEN}✓${NC} Error message is informative"
    fi
elif [ "$HTTP_CODE" = "200" ]; then
    echo -e "${YELLOW}⚠ WARN${NC}: Test notification succeeded (unexpected with fake URLs)"
    echo "   Response: $RESPONSE_BODY"
else
    echo -e "${RED}✗ FAIL${NC}: Unexpected HTTP code: $HTTP_CODE"
    echo "   Response: $RESPONSE_BODY"
    exit 1
fi
echo ""

echo "=========================================="
echo -e "${GREEN}Apprise configuration tests completed!${NC}"
echo "=========================================="
echo ""
echo "Apprise tests verified:"
echo "  • Read existing Apprise URLs via API"
echo "  • Configure 8 sample URLs from different providers"
echo "  • URLs persisted to /data/apprise-config/urls.txt"
echo "  • URLs readable back from API"
echo "  • Diagnostic logging is working"
echo "  • Test notification flow works (fails as expected with fake URLs)"
echo ""

# Allow time for system to settle before messaging test
echo "Waiting 15 seconds for system to settle..."
sleep 15
echo ""

# Test 14: Send message to node and wait for response (with retry)
echo "Test 14: Send message to Yeraze Station G2 and wait for response"
TARGET_NODE_ID="a2e4ff4c"
TEST_MESSAGE="Test in Quick Start"
MAX_ATTEMPTS=3
RESPONSE_RECEIVED=false

for ATTEMPT in $(seq 1 $MAX_ATTEMPTS); do
    echo "Attempt $ATTEMPT of $MAX_ATTEMPTS..."

    # Send message
    SEND_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST $BASE_URL/api/messages/send \
        -H "Content-Type: application/json" \
        -H "X-CSRF-Token: $CSRF_TOKEN" \
        -d "{\"destination\":\"!$TARGET_NODE_ID\",\"text\":\"$TEST_MESSAGE (attempt $ATTEMPT)\"}" \
        -b /tmp/meshmonitor-cookies.txt)

    HTTP_CODE=$(echo "$SEND_RESPONSE" | tail -n1)
    if [ "$HTTP_CODE" = "200" ]; then
        echo -e "${GREEN}✓${NC} Message sent successfully"

        # Wait up to 10 seconds for a response
        echo "Waiting up to 10 seconds for response from Yeraze Station G2..."
        MAX_WAIT=10
        ELAPSED=0
        SLEEP_INTERVAL=1  # Start with 1 second

        while [ $ELAPSED -lt $MAX_WAIT ]; do
            # Check for messages from the target node
            MESSAGES_RESPONSE=$(curl -s $BASE_URL/api/messages \
                -b /tmp/meshmonitor-cookies.txt)

            # Look for a recent message from our target node
            if echo "$MESSAGES_RESPONSE" | grep -q "\"from\":\"!$TARGET_NODE_ID\""; then
                RESPONSE_RECEIVED=true
                echo -e "${GREEN}✓ PASS${NC}: Received response from Yeraze Station G2"
                break 2  # Break out of both loops
            fi

            # Exponential backoff: 1s, 2s, 4s (capped at 4s for faster response detection)
            sleep $SLEEP_INTERVAL
            ELAPSED=$((ELAPSED + SLEEP_INTERVAL))
            
            # Double interval for next iteration, cap at 4 seconds
            if [ $SLEEP_INTERVAL -lt 4 ]; then
                SLEEP_INTERVAL=$((SLEEP_INTERVAL * 2))
            fi
            
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

# Test 15: Security Test - Run before cleanup while container is still running
echo "Test 15: Security verification (API endpoint protection)"
if [ -f "$(dirname "$0")/test-security.sh" ]; then
    # Pass BASE_URL to security test
    export BASE_URL
    if bash "$(dirname "$0")/test-security.sh"; then
        echo -e "${GREEN}✓ PASS${NC}: Security test passed"
    else
        echo -e "${RED}✗ FAIL${NC}: Security test failed"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠ WARN${NC}: Security test script not found"
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
