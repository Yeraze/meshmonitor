#!/bin/bash
# Automated test for MeshCore companion connect + handshake (Phase 1)
# Boots a fresh container with zero pre-configured sources, probes every
# candidate USB serial port for a live MeshCore companion, auto-selects the
# two that connect (enumeration order/physical port assignment is not
# guaranteed stable across reboots -- see rig notes below), and verifies each
# selected companion reaches a stable connected state with a completed
# device handshake (local node, nodes, contacts). Messaging/remote-admin/
# telemetry are Phase 2/3 -- NOT tested here.

echo "=========================================="
echo "MeshCore Companion Connect/Handshake Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

COMPOSE_FILE="docker-compose.meshcore-test.yml"
CONTAINER_NAME="meshmonitor-meshcore-test"
VOLUME_NAME="meshmonitor-meshcore-test-data"
BASE_URL="http://localhost:8089"
COOKIE_FILE="/tmp/meshmonitor-mc-cookies.txt"

# Candidate USB serial ports to probe for a live MeshCore companion.
# Physical port assignment can drift across reboots/re-enumeration (and not
# every port hosts a companion -- some are other device types, or nothing),
# so we probe all four and auto-select whichever two actually come up as
# COMPANION rather than hardcoding which port is which. Overridable.
MESHCORE_CANDIDATE_PORTS="${MESHCORE_CANDIDATE_PORTS:-/dev/ttyUSB0 /dev/ttyUSB1 /dev/ttyUSB2 /dev/ttyUSB3}"

# Stability gate timing
STABLE_SECONDS=10
LIVE_MAX_WAIT=120
POLL_INTERVAL=2
# Handshake/contact-sync poll
CONTACT_MAX_WAIT=60

# Cleanup function
cleanup() {
    if [ "$KEEP_ALIVE" = "true" ]; then
        echo ""
        echo -e "${YELLOW}⚠ KEEP_ALIVE set to true - Skipping cleanup...${NC}"
        echo "You will need to manually clean up when finished:"
        echo "  docker compose -f $COMPOSE_FILE down -v"
        return 0
    fi

    echo ""
    echo "Cleaning up..."
    # Phase 2: kill the Socket.IO ack-listener helper if it's still running,
    # and remove its temp output files plus the send-status scratch file.
    [ -n "$HELPER_PID" ] && kill "$HELPER_PID" 2>/dev/null
    rm -f "$ACK_OUT" "$ACK_ERR" "/tmp/mc_send.$$" 2>/dev/null
    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    rm -f "$COMPOSE_FILE"
    rm -f "$COOKIE_FILE"

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

echo "Candidate companion ports: $MESHCORE_CANDIDATE_PORTS"
echo ""

# Create test docker-compose file
echo "Creating test docker-compose.yml (MeshCore-only, zero sources on boot)..."
cat > "$COMPOSE_FILE" <<EOF
services:
  meshmonitor:
    image: meshmonitor:test
    container_name: ${CONTAINER_NAME}
    ports:
      - "8089:3001"
    volumes:
      - ${VOLUME_NAME}:/data
    devices:
      - /dev/ttyUSB0:/dev/ttyUSB0:rw
      - /dev/ttyUSB1:/dev/ttyUSB1:rw
      - /dev/ttyUSB2:/dev/ttyUSB2:rw
      - /dev/ttyUSB3:/dev/ttyUSB3:rw
    group_add:
      - "20"   # dialout: ttyUSB1, ttyUSB3 (getent group dialout -> 20)
      - "46"   # plugdev: ttyUSB0, ttyUSB2 -- companions have shown up on
               # both groups depending on enumeration, so both are needed
               # (getent group plugdev -> 46). Different runner? re-check:
               # getent group dialout / getent group plugdev
    restart: unless-stopped

volumes:
  ${VOLUME_NAME}:
EOF

echo -e "${GREEN}✓${NC} Test config created"
echo ""

# Start container
echo "Starting container..."
docker compose -f "$COMPOSE_FILE" up -d

echo -e "${GREEN}✓${NC} Container started"
echo ""

# Wait for container to be ready. This container boots with ZERO sources
# (MeshCore-only install), so /api/poll's "connection" field may never
# appear -- poll /api/health for HTTP 200 instead, which has no source
# dependency.
echo "Waiting for API to be ready..."

COUNTER=0
MAX_WAIT=60
while [ $COUNTER -lt $MAX_WAIT ]; do
    CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health" 2>/dev/null || echo 000)
    if [ "$CODE" = "200" ]; then
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
echo ""

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

# Test 2: Get CSRF token
echo "Test 2: Fetch CSRF token"
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/api/csrf-token" \
    -c "$COOKIE_FILE")

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

# Test 3: Login with default admin credentials
echo "Test 3: Login with default admin credentials"
LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/auth/login" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}' \
    -b "$COOKIE_FILE" \
    -c "$COOKIE_FILE")

HTTP_CODE=$(echo "$LOGIN_RESPONSE" | tail -n1)
if [ "$HTTP_CODE" = "200" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Login successful (HTTP 200)"
else
    echo -e "${RED}✗ FAIL${NC}: Login failed (HTTP $HTTP_CODE)"
    echo "$LOGIN_RESPONSE"
    exit 1
fi

# Re-fetch CSRF token after login (session is regenerated on auth). This is
# mandatory: POST /api/sources is CSRF-protected and a pre-login token 403s.
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" "$BASE_URL/api/csrf-token" \
    -b "$COOKIE_FILE" \
    -c "$COOKIE_FILE")
HTTP_CODE=$(echo "$CSRF_RESPONSE" | tail -n1)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | head -n-1 | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

if [ "$HTTP_CODE" = "200" ] && [ -n "$CSRF_TOKEN" ]; then
    echo -e "${GREEN}✓${NC} Post-login CSRF token obtained"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get post-login CSRF token"
    exit 1
fi
echo ""

# Test 4: Create one candidate MeshCore source per candidate port. Physical
# port assignment isn't guaranteed stable across reboots/re-enumeration, and
# not every candidate port hosts a companion (some fail AppStart entirely),
# so we probe every port and let Test 5 auto-select whichever two connect.
echo "Test 4: Create one MeshCore source per candidate port"

create_meshcore_source() {
    local NAME="$1"
    local PORT="$2"

    RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/api/sources" \
        -H "Content-Type: application/json" \
        -H "X-CSRF-Token: $CSRF_TOKEN" \
        -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
        -d "{\"name\":\"$NAME\",\"type\":\"meshcore\",\"enabled\":true,\"config\":{\"transport\":\"usb\",\"serialPort\":\"$PORT\",\"baudRate\":115200,\"deviceType\":\"companion\",\"autoConnect\":true}}")
    HTTP_CODE=$(echo "$RESP" | tail -n1)
    BODY=$(echo "$RESP" | head -n-1)
    local SRC_ID
    SRC_ID=$(echo "$BODY" | jq -r '.id // empty')

    if [ "$HTTP_CODE" != "201" ] || [ -z "$SRC_ID" ]; then
        echo -e "${RED}✗ FAIL${NC}: Failed to create source '$NAME' on $PORT (HTTP $HTTP_CODE)" >&2
        echo "   Response: $BODY" >&2
        # NOTE: this function is invoked via command substitution
        # ($(...)), which runs in a subshell -- `exit` here only
        # terminates that subshell, not the whole script. Use a
        # non-zero return so the caller can check $? and exit itself.
        return 1
    fi

    echo -e "${GREEN}✓${NC} Created source '$NAME' on $PORT (id: $SRC_ID)" >&2
    echo "$SRC_ID"
}

# sourceId -> port map for every candidate that successfully created a
# source (a create failure for one port is not fatal here -- Test 5 just
# won't find a companion on it).
declare -A SRC_TO_PORT=()

for PORT in $MESHCORE_CANDIDATE_PORTS; do
    SRC_ID=$(create_meshcore_source "MeshCore Probe $PORT" "$PORT")
    if [ $? -ne 0 ] || [ -z "$SRC_ID" ]; then
        echo -e "${YELLOW}⚠${NC} Skipping $PORT (source create failed)"
        continue
    fi
    SRC_TO_PORT["$SRC_ID"]="$PORT"
done

if [ ${#SRC_TO_PORT[@]} -lt 2 ]; then
    echo -e "${RED}✗ FAIL${NC}: Only ${#SRC_TO_PORT[@]} candidate source(s) created successfully (need >=2 to probe)"
    exit 1
fi

echo -e "${GREEN}✓ PASS${NC}: Created ${#SRC_TO_PORT[@]} candidate MeshCore source(s)"
echo ""

# Test 5: Auto-detect which candidates are live companions. Poll every
# candidate source's /meshcore/status in a single round-robin loop (not
# sequential per-source blocking) so a dead port doesn't burn the whole
# LIVE_MAX_WAIT budget before we even check the others. Select the first two
# sources to report connected:true + deviceTypeName:"COMPANION" as A/B, then
# delete the rest so the container isn't left retrying dead ports and Phase
# 2/3 see a clean two-source state.
echo "Test 5: Auto-detect live companions among candidate ports"

declare -A LAST_STATUS=()
COMPANION_SRC_IDS=()
SELECT_ELAPSED=0

is_selected() {
    local needle="$1"
    local id
    for id in "${COMPANION_SRC_IDS[@]}"; do
        [ "$id" = "$needle" ] && return 0
    done
    return 1
}

while [ $SELECT_ELAPSED -lt $LIVE_MAX_WAIT ] && [ ${#COMPANION_SRC_IDS[@]} -lt 2 ]; do
    for SRC_ID in "${!SRC_TO_PORT[@]}"; do
        is_selected "$SRC_ID" && continue

        STATUS=$(curl -s "$BASE_URL/api/sources/$SRC_ID/meshcore/status" \
            -b "$COOKIE_FILE" 2>/dev/null || echo '{}')
        LAST_STATUS["$SRC_ID"]="$STATUS"

        if echo "$STATUS" | grep -q '"connected":true' && \
           echo "$STATUS" | grep -q '"deviceTypeName":"COMPANION"'; then
            COMPANION_SRC_IDS+=("$SRC_ID")
            NODE_NAME=$(echo "$STATUS" | jq -r '.data.localNode.name // "unknown"')
            echo -e "${GREEN}✓${NC} ${SRC_TO_PORT[$SRC_ID]} is a live COMPANION: '$NODE_NAME' (source $SRC_ID)"
        fi

        [ ${#COMPANION_SRC_IDS[@]} -ge 2 ] && break
    done
    if [ ${#COMPANION_SRC_IDS[@]} -ge 2 ]; then
        break
    fi
    sleep $POLL_INTERVAL
    SELECT_ELAPSED=$((SELECT_ELAPSED + POLL_INTERVAL))
    echo -n "."
done
echo ""

if [ ${#COMPANION_SRC_IDS[@]} -lt 2 ]; then
    echo -e "${RED}✗ FAIL${NC}: Only found ${#COMPANION_SRC_IDS[@]} live companion(s) after ${LIVE_MAX_WAIT}s (need >=2)"
    for SRC_ID in "${!SRC_TO_PORT[@]}"; do
        echo "  ${SRC_TO_PORT[$SRC_ID]} (source $SRC_ID): ${LAST_STATUS[$SRC_ID]:-<no response>}"
    done
    exit 1
fi

SRC_A_ID="${COMPANION_SRC_IDS[0]}"
SRC_B_ID="${COMPANION_SRC_IDS[1]}"
PORT_A="${SRC_TO_PORT[$SRC_A_ID]}"
PORT_B="${SRC_TO_PORT[$SRC_B_ID]}"

echo -e "${GREEN}✓ PASS${NC}: Selected companions: $PORT_A (source $SRC_A_ID) + $PORT_B (source $SRC_B_ID)"
echo ""

# Delete the non-companion (or not-yet-connected) candidate sources so the
# container is left in a clean two-source state for Phase 2/3.
echo "Cleaning up non-selected candidate sources..."
for SRC_ID in "${!SRC_TO_PORT[@]}"; do
    [ "$SRC_ID" = "$SRC_A_ID" ] && continue
    [ "$SRC_ID" = "$SRC_B_ID" ] && continue

    DEL_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/api/sources/$SRC_ID" \
        -H "X-CSRF-Token: $CSRF_TOKEN" \
        -b "$COOKIE_FILE" -c "$COOKIE_FILE")
    if [ "$DEL_CODE" = "200" ]; then
        echo -e "${GREEN}✓${NC} Deleted non-selected source ${SRC_TO_PORT[$SRC_ID]} ($SRC_ID)"
    else
        echo -e "${YELLOW}⚠${NC} Could not delete source ${SRC_TO_PORT[$SRC_ID]} ($SRC_ID) (HTTP $DEL_CODE) -- leaving it in place"
    fi
done
echo ""

# Test 6: Connection-stability gate (mirrors test-quick-start.sh Test 12b)
# Serial is a dedicated line with none of the Meshtastic TCP single-client
# churn, so a 10s stability window is sufficient to prove the connection
# settled and the manager did not immediately drop.
wait_stable() {
    local SRC_ID="$1"
    local LABEL="$2"

    echo "Waiting for $LABEL (source $SRC_ID) to reach a stable COMPANION connection..."
    local LIVE_ELAPSED=0
    local STABLE_FOR=0
    local LIVE_OK=false
    local STATUS=""

    while [ $LIVE_ELAPSED -lt $LIVE_MAX_WAIT ]; do
        STATUS=$(curl -s "$BASE_URL/api/sources/$SRC_ID/meshcore/status" \
            -b "$COOKIE_FILE" 2>/dev/null || echo '{}')
        if echo "$STATUS" | grep -q '"connected":true' && \
           echo "$STATUS" | grep -q '"deviceTypeName":"COMPANION"'; then
            STABLE_FOR=$((STABLE_FOR + POLL_INTERVAL))
            if [ $STABLE_FOR -ge $STABLE_SECONDS ]; then
                echo -e "${GREEN}✓ PASS${NC}: $LABEL connection stable for ${STABLE_FOR}s"
                LIVE_OK=true
                break
            fi
        else
            if [ $STABLE_FOR -gt 0 ]; then
                echo " (flap detected, restarting stability count)"
            fi
            STABLE_FOR=0
        fi
        sleep $POLL_INTERVAL
        LIVE_ELAPSED=$((LIVE_ELAPSED + POLL_INTERVAL))
        echo -n "."
    done
    echo ""

    if [ "$LIVE_OK" = false ]; then
        echo -e "${RED}✗ FAIL${NC}: $LABEL connection not stable after ${LIVE_MAX_WAIT}s"
        echo "  Last /meshcore/status: $STATUS"
        exit 1
    fi
}

echo "Test 6: Connection stability gate (per source)"
wait_stable "$SRC_A_ID" "Companion A"
wait_stable "$SRC_B_ID" "Companion B"
echo ""

# Test 7: Handshake / device-query assertion (per source)
# Records each source's localNode name/publicKey in the SRC_NAME/SRC_PUBKEY
# associative arrays (keyed by sourceId, deliberately NOT `local` so they
# survive the function call) -- Phase 2/3 harnesses can source this script's
# selection logic and reuse SRC_A_ID/SRC_B_ID/SRC_NAME/SRC_PUBKEY directly.
declare -A SRC_NAME=()
declare -A SRC_PUBKEY=()

assert_handshake() {
    local SRC_ID="$1"
    local LABEL="$2"

    echo "Verifying handshake for $LABEL (source $SRC_ID)..."

    # Local node present (primary handshake proof)
    STATUS=$(curl -s "$BASE_URL/api/sources/$SRC_ID/meshcore/status" -b "$COOKIE_FILE")
    PK=$(echo "$STATUS" | jq -r '.data.localNode.publicKey // empty')
    if [ -z "$PK" ]; then
        echo -e "${RED}✗ FAIL${NC}: $LABEL has no localNode.publicKey (handshake incomplete)"
        echo "   Status: $STATUS"
        exit 1
    fi
    SRC_PUBKEY["$SRC_ID"]="$PK"
    SRC_NAME["$SRC_ID"]=$(echo "$STATUS" | jq -r '.data.localNode.name // "unknown"')
    echo -e "${GREEN}✓${NC} $LABEL localNode.publicKey present"

    # Nodes populated
    NODES=$(curl -s "$BASE_URL/api/sources/$SRC_ID/meshcore/nodes" -b "$COOKIE_FILE")
    NODE_COUNT=$(echo "$NODES" | jq -r '.count // (.data | length) // 0')
    if [ -z "$NODE_COUNT" ] || [ "$NODE_COUNT" -lt 1 ]; then
        echo -e "${RED}✗ FAIL${NC}: $LABEL has nodes.count=$NODE_COUNT (expected >=1)"
        echo "   Response: $NODES"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} $LABEL nodes.count=$NODE_COUNT"

    # Contacts populated - the device syncs contacts asynchronously right
    # after connect, so poll for it.
    local CONTACT_ELAPSED=0
    local CONTACT_COUNT=0
    local CONTACTS=""
    while [ $CONTACT_ELAPSED -lt $CONTACT_MAX_WAIT ]; do
        CONTACTS=$(curl -s "$BASE_URL/api/sources/$SRC_ID/meshcore/contacts" -b "$COOKIE_FILE")
        CONTACT_COUNT=$(echo "$CONTACTS" | jq -r '.count // (.data | length) // 0')
        if [ -n "$CONTACT_COUNT" ] && [ "$CONTACT_COUNT" -ge 1 ] 2>/dev/null; then
            break
        fi
        sleep $POLL_INTERVAL
        CONTACT_ELAPSED=$((CONTACT_ELAPSED + POLL_INTERVAL))
        echo -n "."
    done
    echo ""

    if [ -z "$CONTACT_COUNT" ] || [ "$CONTACT_COUNT" -lt 1 ] 2>/dev/null; then
        echo -e "${RED}✗ FAIL${NC}: $LABEL contacts.count=$CONTACT_COUNT after ${CONTACT_MAX_WAIT}s (expected >=1)"
        echo "   Response: $CONTACTS"
        exit 1
    fi
    echo -e "${GREEN}✓${NC} $LABEL contacts.count=$CONTACT_COUNT"
}

echo "Test 7: Handshake / device-query verification (per source)"
assert_handshake "$SRC_A_ID" "Companion A"
assert_handshake "$SRC_B_ID" "Companion B"
echo ""

# ==========================================
# Phase 2: Messaging assertions (DM, channel, repeater auto-ack)
# ==========================================
# Phase 2 temp-file/PID vars, declared up front so cleanup() can reference
# them even if a test fails before they are ever assigned.
ACK_OUT=""
ACK_ERR=""
HELPER_PID=""

echo "Test 8: Acquire API token for Socket.IO helper"
API_TOKEN=$(curl -s -X POST "$BASE_URL/api/token/generate" \
    -b "$COOKIE_FILE" -H "x-csrf-token: $CSRF_TOKEN" | jq -r '.token // empty')
[ -n "$API_TOKEN" ] || { echo -e "${RED}✗ FAIL${NC}: no API token"; exit 1; }
echo -e "${GREEN}✓${NC} API token acquired"
echo ""

echo "Test 9: DM A -> B (verify B receives)"
DM_MARKER="mm-systest-dm-$$-$(date +%s)"
SINCE=$(( $(date +%s%3N) - 2000 ))
B_PK="${SRC_PUBKEY[$SRC_B_ID]}"   # full 64-hex from Phase 1 handshake
DM_ATTEMPTS=${MESHCORE_DM_ATTEMPTS:-3}
DM_POLL_SECONDS=${MESHCORE_DM_POLL_SECONDS:-30}
recv_ok=false
all_sends_400=true      # flips false the moment any send is not a 400
for attempt in $(seq 1 "$DM_ATTEMPTS"); do
  # Capture the send HTTP status so a rejected send (400 = bad/unroutable
  # pubkey, target-not-a-contact) is visible instead of silently burning the
  # poll budget and mis-reporting "never received".
  SEND_CODE=$(curl -s -o "/tmp/mc_send.$$" -w "%{http_code}" -X POST \
    "$BASE_URL/api/sources/$SRC_A_ID/meshcore/messages/send" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"text\":\"$DM_MARKER\",\"toPublicKey\":\"$B_PK\"}")
  [ "$SEND_CODE" = "400" ] || all_sends_400=false
  [ "$SEND_CODE" = "200" ] || echo "  (DM send attempt $attempt returned HTTP $SEND_CODE: $(cat "/tmp/mc_send.$$"))"
  waited=0
  while [ $waited -lt "$DM_POLL_SECONDS" ]; do
    HIT=$(curl -s "$BASE_URL/api/sources/$SRC_B_ID/meshcore/messages?since=$SINCE" -b "$COOKIE_FILE" \
      | jq -r --arg m "$DM_MARKER" '(.data // [])[] | select(.text==$m) | .text' | head -n1)
    [ "$HIT" = "$DM_MARKER" ] && { recv_ok=true; break; }
    sleep "$POLL_INTERVAL"; waited=$((waited+POLL_INTERVAL))
  done
  $recv_ok && break
  echo "  (DM attempt $attempt: not yet received, retrying)"
done
if $recv_ok; then
  echo -e "${GREEN}✓ PASS${NC}: B received DM from A"
elif $all_sends_400; then
  # A consistent 400 is not RF loss -- retrying won't fix it.
  echo -e "${RED}✗ FAIL${NC}: all DM sends rejected HTTP 400 -- target pubkey not a contact / invalid (B_PK=$B_PK)"; exit 1
else
  echo -e "${RED}✗ FAIL${NC}: B never received DM after $DM_ATTEMPTS attempts"; exit 1
fi
echo ""

echo "Test 10: Create '#mm-systest' channel on both companions"
# Derive the 16-byte PSK the same way the app does
# (deriveHashtagSecretHex('#mm-systest') = SHA-256("#mm-systest")[0:16]),
# base64-encoded for the channel PUT.
PSK_B64=$(printf '%s' '#mm-systest' | openssl dgst -sha256 -binary | head -c 16 | base64)
[ -n "$PSK_B64" ] || { echo -e "${RED}✗ FAIL${NC}: failed to derive channel PSK"; exit 1; }

# Pick a free slot on BOTH sources (avoid clobbering an existing channel).
USED=$( { curl -s "$BASE_URL/api/channels?sourceId=$SRC_A_ID" -b "$COOKIE_FILE";
          curl -s "$BASE_URL/api/channels?sourceId=$SRC_B_ID" -b "$COOKIE_FILE"; } \
        | jq -r '(.data // .)[]?.id' | sort -un )
SLOT=${MESHCORE_TEST_CHANNEL_SLOT:-}
if [ -z "$SLOT" ]; then
  for c in 1 2 3 4 5 6 7; do echo "$USED" | grep -qx "$c" || { SLOT=$c; break; }; done
fi
[ -n "$SLOT" ] || { echo -e "${RED}✗ FAIL${NC}: no free channel slot"; exit 1; }
echo "  Using channel slot $SLOT"

for SID in "$SRC_A_ID" "$SRC_B_ID"; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE_URL/api/channels/$SLOT" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"sourceId\":\"$SID\",\"name\":\"#mm-systest\",\"psk\":\"$PSK_B64\"}")
  [ "$CODE" = "200" ] || { echo -e "${RED}✗ FAIL${NC}: channel PUT on $SID => HTTP $CODE"; exit 1; }
done

# Give the device a moment to apply, then confirm the channel persisted on
# both sources at the expected slot.
sleep 3
for SID in "$SRC_A_ID" "$SRC_B_ID"; do
  CH=$(curl -s "$BASE_URL/api/channels?sourceId=$SID" -b "$COOKIE_FILE" \
    | jq -r --arg slot "$SLOT" '(.data // .)[] | select((.id|tostring)==$slot) | .name // empty')
  if [ "$CH" != "#mm-systest" ]; then
    echo -e "${RED}✗ FAIL${NC}: channel slot $SLOT on source $SID did not persist as '#mm-systest' (got '$CH')"; exit 1
  fi
done
echo -e "${GREEN}✓ PASS${NC}: '#mm-systest' channel created on both companions (slot $SLOT)"
echo ""

echo "Test 11: Channel message A -> B on '#mm-systest' (verify B receives)"
CHAN_MARKER="mm-systest-chan-$$-$(date +%s)"
CHAN_SINCE=$(( $(date +%s%3N) - 2000 ))
CHAN_ATTEMPTS=${MESHCORE_CHAN_ATTEMPTS:-4}
CHAN_POLL_SECONDS=${MESHCORE_CHAN_POLL_SECONDS:-25}
chan_recv_ok=false
chan_all_400=true
for attempt in $(seq 1 "$CHAN_ATTEMPTS"); do
  SEND_CODE=$(curl -s -o "/tmp/mc_send.$$" -w "%{http_code}" -X POST \
    "$BASE_URL/api/sources/$SRC_A_ID/meshcore/messages/send" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"text\":\"$CHAN_MARKER\",\"channelIdx\":$SLOT}")
  [ "$SEND_CODE" = "400" ] || chan_all_400=false
  [ "$SEND_CODE" = "200" ] || echo "  (channel send attempt $attempt returned HTTP $SEND_CODE: $(cat "/tmp/mc_send.$$"))"
  waited=0
  while [ $waited -lt "$CHAN_POLL_SECONDS" ]; do
    HIT=$(curl -s "$BASE_URL/api/sources/$SRC_B_ID/meshcore/messages/channel/$SLOT?since=$CHAN_SINCE" -b "$COOKIE_FILE" \
      | jq -r --arg m "$CHAN_MARKER" '(.data // [])[] | select(.text==$m) | .text' | head -n1)
    if [ -z "$HIT" ]; then
      # Fall back to the combined inbox filtered by the channel's synthetic
      # fromPublicKey, in case the per-channel route shape differs.
      HIT=$(curl -s "$BASE_URL/api/sources/$SRC_B_ID/meshcore/messages?since=$CHAN_SINCE" -b "$COOKIE_FILE" \
        | jq -r --arg m "$CHAN_MARKER" --arg fpk "channel-$SLOT" \
          '(.data // [])[] | select(.text==$m and .fromPublicKey==$fpk) | .text' | head -n1)
    fi
    [ "$HIT" = "$CHAN_MARKER" ] && { chan_recv_ok=true; break; }
    sleep "$POLL_INTERVAL"; waited=$((waited+POLL_INTERVAL))
  done
  $chan_recv_ok && break
  echo "  (channel attempt $attempt: not yet received, retrying)"
done
if $chan_recv_ok; then
  echo -e "${GREEN}✓ PASS${NC}: B received channel message from A on '#mm-systest'"
elif $chan_all_400; then
  echo -e "${RED}✗ FAIL${NC}: all channel sends rejected HTTP 400 -- bad channelIdx ($SLOT)?"; exit 1
else
  echo -e "${RED}✗ FAIL${NC}: B never received channel message after $CHAN_ATTEMPTS attempts"; exit 1
fi
echo ""

echo "Test 12: Yeraze Repeater DM firmware auto-ack"
REPEATER_PK=$(curl -s "$BASE_URL/api/sources/$SRC_A_ID/meshcore/contacts" -b "$COOKIE_FILE" \
  | jq -r '(.data // [])
      | ( map(select((.advName // "")|ascii_downcase == "yeraze repeater")) )
      + ( map(select((.advType==2) and (((.advName // .name // "")|ascii_downcase)|test("yeraze|repeater")))) )
      | .[0].publicKey // empty')
REPEATER_PK=${MESHCORE_REPEATER_PUBKEY:-$REPEATER_PK}
if [ -z "$REPEATER_PK" ]; then
  echo -e "${RED}✗ FAIL${NC}: no 'Yeraze Repeater' contact on source $SRC_A_ID"; exit 1
fi

ACK_OUT=$(mktemp); ACK_ERR=$(mktemp)   # registered in cleanup()
TIMEOUT_MS=$(( ${MESHCORE_REPEATER_ATTEMPTS:-4} * ${MESHCORE_REPEATER_INTERVAL:-20} * 1000 + 10000 ))
BASE_URL="$BASE_URL" TOKEN="$API_TOKEN" SOURCE_ID="$SRC_A_ID" TIMEOUT_MS="$TIMEOUT_MS" \
  node "$(dirname "$0")/helpers/meshcore-await-ack.mjs" >"$ACK_OUT" 2>"$ACK_ERR" &
HELPER_PID=$!

# Wait for READY (helper connected + listening) before sending.
for _ in $(seq 1 15); do grep -q READY "$ACK_OUT" && break; sleep 1; done
grep -q READY "$ACK_OUT" || { echo -e "${RED}✗ FAIL${NC}: helper never became READY"; cat "$ACK_ERR"; kill $HELPER_PID 2>/dev/null; exit 1; }

RPT_MARKER="mm-systest-rpt-$$-$(date +%s)"
rpt_all_400=true
for attempt in $(seq 1 "${MESHCORE_REPEATER_ATTEMPTS:-4}"); do
  grep -q '^ACK ' "$ACK_OUT" && break
  SEND_CODE=$(curl -s -o "/tmp/mc_send.$$" -w "%{http_code}" -X POST \
    "$BASE_URL/api/sources/$SRC_A_ID/meshcore/messages/send" \
    -b "$COOKIE_FILE" -H "Content-Type: application/json" -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d "{\"text\":\"$RPT_MARKER-$attempt\",\"toPublicKey\":\"$REPEATER_PK\"}")
  [ "$SEND_CODE" = "400" ] || rpt_all_400=false
  [ "$SEND_CODE" = "200" ] || echo "  (repeater send attempt $attempt returned HTTP $SEND_CODE: $(cat "/tmp/mc_send.$$"))"
  sleep "${MESHCORE_REPEATER_INTERVAL:-20}"
done
wait $HELPER_PID; HELPER_RC=$?
if [ "$HELPER_RC" = "0" ]; then
  echo -e "${GREEN}✓ PASS${NC}: repeater auto-ack ($(grep '^ACK ' "$ACK_OUT"))"
elif $rpt_all_400; then
  echo -e "${RED}✗ FAIL${NC}: all repeater sends rejected HTTP 400 -- repeater pubkey not a contact / invalid (REPEATER_PK=$REPEATER_PK)"; cat "$ACK_ERR"; exit 1
else
  echo -e "${RED}✗ FAIL${NC}: no repeater auto-ack (helper rc=$HELPER_RC)"; cat "$ACK_ERR"; exit 1
fi
echo ""

echo "=========================================="
echo -e "${GREEN}✓ Both MeshCore companions connected + handshake verified${NC}"
echo -e "${GREEN}✓ DM, channel ('#mm-systest'), and repeater auto-ack messaging verified${NC}"
echo "=========================================="
echo "  Companion A: $PORT_A -- source $SRC_A_ID -- '${SRC_NAME[$SRC_A_ID]}' -- ${SRC_PUBKEY[$SRC_A_ID]}"
echo "  Companion B: $PORT_B -- source $SRC_B_ID -- '${SRC_NAME[$SRC_B_ID]}' -- ${SRC_PUBKEY[$SRC_B_ID]}"
echo "  DM A->B: verified (B inbox)"
echo "  Channel A->B on #mm-systest (slot $SLOT): verified (B inbox)"
echo "  Repeater DM auto-ack: verified (Socket.IO meshcore:send-confirmed)"
echo ""
exit 0
