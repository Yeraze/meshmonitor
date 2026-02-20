#!/bin/bash
# Database Backing Consistency Test
# Verifies that all three database backends (SQLite, PostgreSQL, MySQL)
# produce consistent node data from the same physical Meshtastic device.

set -e  # Exit on any error

echo "=========================================="
echo "Database Backing Consistency Test"
echo "=========================================="
echo ""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

cd "$PROJECT_ROOT"

# Pre-flight: check for existing meshmonitor containers that may hog the device connection
EXISTING_MM=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^meshmonitor' | grep -v 'db-backing' || true)
if [ -n "$EXISTING_MM" ]; then
    echo -e "${RED}✗ ERROR${NC}: Existing MeshMonitor containers detected that may conflict:"
    echo "$EXISTING_MM" | while read -r name; do echo "  - $name"; done
    echo ""
    echo "Only one container can connect to the Meshtastic device at a time."
    echo "Please shut down existing containers before running this test."
    exit 1
fi

# Test configuration
TEST_NODE_IP="${TEST_NODE_IP:-192.168.5.106}"
TEST_PORT="8083"
COOKIE_FILE="/tmp/meshmonitor-db-backing-cookies.txt"
SQLITE_COMPOSE="docker-compose.db-backing-sqlite-test.yml"
POSTGRES_COMPOSE="docker-compose.db-backing-postgres-test.yml"
MYSQL_COMPOSE="docker-compose.db-backing-mysql-test.yml"
SQLITE_NODES_FILE="/tmp/meshmonitor-nodes-sqlite.json"
POSTGRES_NODES_FILE="/tmp/meshmonitor-nodes-postgres.json"
MYSQL_NODES_FILE="/tmp/meshmonitor-nodes-mysql.json"

# Track results
SQLITE_RESULT="NOT_RUN"
POSTGRES_RESULT="NOT_RUN"
MYSQL_RESULT="NOT_RUN"
COMPARE_RESULT="NOT_RUN"

# Cleanup function
cleanup() {
    echo ""
    echo -e "${BLUE}Cleaning up database backing test artifacts...${NC}"

    # Stop and remove containers/volumes for all three compose files
    docker compose -f "$SQLITE_COMPOSE" down -v 2>/dev/null || true
    docker compose -f "$POSTGRES_COMPOSE" down -v 2>/dev/null || true
    docker compose -f "$MYSQL_COMPOSE" down -v 2>/dev/null || true

    # Remove temporary compose files
    rm -f "$SQLITE_COMPOSE" 2>/dev/null || true
    rm -f "$POSTGRES_COMPOSE" 2>/dev/null || true
    rm -f "$MYSQL_COMPOSE" 2>/dev/null || true

    # Remove cookie and node data files
    rm -f "$COOKIE_FILE" 2>/dev/null || true
    rm -f "$SQLITE_NODES_FILE" 2>/dev/null || true
    rm -f "$POSTGRES_NODES_FILE" 2>/dev/null || true
    rm -f "$MYSQL_NODES_FILE" 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Cleanup complete"
}

# Set trap for cleanup
trap cleanup EXIT

# ============================================================
# Helper: authenticate and fetch nodes for a given backend
# ============================================================
authenticate_and_fetch_nodes() {
    local BACKEND_NAME="$1"
    local OUTPUT_FILE="$2"

    # Clear cookies
    rm -f "$COOKIE_FILE" 2>/dev/null || true

    echo "Authenticating ($BACKEND_NAME)..."
    CSRF_TOKEN=$(curl -s -c "$COOKIE_FILE" \
        "http://localhost:$TEST_PORT/api/csrf-token" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)

    LOGIN_RESPONSE=$(curl -s -b "$COOKIE_FILE" \
        -c "$COOKIE_FILE" \
        -X POST "http://localhost:$TEST_PORT/api/auth/login" \
        -H "Content-Type: application/json" \
        -H "X-CSRF-Token: $CSRF_TOKEN" \
        -d '{"username":"admin","password":"changeme"}')

    if ! echo "$LOGIN_RESPONSE" | grep -q "success"; then
        echo -e "${RED}✗ FAIL${NC}: Login failed for $BACKEND_NAME"
        echo "Response: $LOGIN_RESPONSE"
        return 1
    fi
    echo -e "${GREEN}✓${NC} Login successful ($BACKEND_NAME)"

    echo "Fetching nodes ($BACKEND_NAME)..."
    curl -s -b "$COOKIE_FILE" \
        "http://localhost:$TEST_PORT/api/nodes" > "$OUTPUT_FILE"

    local NODE_COUNT
    NODE_COUNT=$(grep -o '"nodeNum"' "$OUTPUT_FILE" | wc -l)
    echo -e "${GREEN}✓${NC} Fetched $NODE_COUNT nodes ($BACKEND_NAME)"
    return 0
}

# ============================================================
# Helper: wait for API readiness and node sync
# ============================================================
wait_for_ready() {
    local BACKEND_NAME="$1"
    local API_MAX_WAIT="$2"
    local CONTAINER_NAME="$3"

    # Wait for API readiness
    echo "Waiting for $BACKEND_NAME API to be ready (up to ${API_MAX_WAIT}s)..."
    COUNTER=0
    while [ $COUNTER -lt $API_MAX_WAIT ]; do
        POLL_RESPONSE=$(curl -s "http://localhost:$TEST_PORT/api/poll" 2>/dev/null || echo "{}")
        if echo "$POLL_RESPONSE" | grep -q '"connected":true'; then
            echo -e "${GREEN}✓${NC} $BACKEND_NAME API is ready"
            break
        fi
        COUNTER=$((COUNTER + 1))
        if [ $COUNTER -eq $API_MAX_WAIT ]; then
            echo -e "${RED}✗ FAIL${NC}: $BACKEND_NAME API did not become ready"
            docker logs "$CONTAINER_NAME" 2>&1 | tail -30
            return 1
        fi
        sleep 1
    done
    echo ""

    # Wait for node sync: channels >= 3 AND nodes > 100
    echo "Waiting for node sync (channels >= 3, nodes > 100, up to 90s)..."

    # Need to authenticate first to access channel/node APIs
    rm -f "$COOKIE_FILE" 2>/dev/null || true

    # Retry auth up to 5 times (API may need a moment after reporting ready)
    AUTH_OK=false
    for AUTH_ATTEMPT in 1 2 3 4 5; do
        CSRF_TOKEN=$(curl -s -c "$COOKIE_FILE" \
            "http://localhost:$TEST_PORT/api/csrf-token" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)

        if [ -z "$CSRF_TOKEN" ]; then
            echo "  Auth attempt $AUTH_ATTEMPT: no CSRF token, retrying..."
            sleep 2
            continue
        fi

        LOGIN_RESP=$(curl -s -b "$COOKIE_FILE" -c "$COOKIE_FILE" \
            -X POST "http://localhost:$TEST_PORT/api/auth/login" \
            -H "Content-Type: application/json" \
            -H "X-CSRF-Token: $CSRF_TOKEN" \
            -d '{"username":"admin","password":"changeme"}')

        if echo "$LOGIN_RESP" | grep -q "success"; then
            AUTH_OK=true
            echo -e "${GREEN}✓${NC} Authenticated for sync check"
            break
        fi
        echo "  Auth attempt $AUTH_ATTEMPT: login failed ($LOGIN_RESP), retrying..."
        rm -f "$COOKIE_FILE" 2>/dev/null || true
        sleep 2
    done

    if [ "$AUTH_OK" != "true" ]; then
        echo -e "${RED}✗ FAIL${NC}: Could not authenticate for node sync check"
        docker logs "$CONTAINER_NAME" 2>&1 | tail -30
        return 1
    fi

    MAX_SYNC_WAIT=90
    ELAPSED=0
    SLEEP_INTERVAL=1

    while [ $ELAPSED -lt $MAX_SYNC_WAIT ]; do
        CHANNELS_RESPONSE=$(curl -s "http://localhost:$TEST_PORT/api/channels" \
            -b "$COOKIE_FILE" 2>/dev/null || echo "[]")
        CHANNEL_COUNT=$(echo "$CHANNELS_RESPONSE" | grep -o '"id"' | wc -l)

        NODES_RESPONSE=$(curl -s "http://localhost:$TEST_PORT/api/nodes" \
            -b "$COOKIE_FILE" 2>/dev/null || echo "[]")
        NODE_COUNT=$(echo "$NODES_RESPONSE" | grep -o '"nodeNum"' | wc -l)

        if [ "$CHANNEL_COUNT" -ge 3 ] && [ "$NODE_COUNT" -gt 100 ]; then
            echo -e "${GREEN}✓${NC} Node sync complete (channels: $CHANNEL_COUNT, nodes: $NODE_COUNT)"
            return 0
        fi

        sleep $SLEEP_INTERVAL
        ELAPSED=$((ELAPSED + SLEEP_INTERVAL))

        # Exponential backoff: 1s, 2s, 4s, 8s (capped at 8s)
        if [ $SLEEP_INTERVAL -lt 8 ]; then
            SLEEP_INTERVAL=$((SLEEP_INTERVAL * 2))
        fi

        echo -n "."
    done
    echo ""
    echo -e "${RED}✗ FAIL${NC}: Node sync timed out (channels: $CHANNEL_COUNT, nodes: $NODE_COUNT)"
    return 1
}

# ===== SQLite Backend Test =====
echo "=========================================="
echo -e "${BLUE}SQLite Backend${NC}"
echo "=========================================="
echo ""

echo "Creating SQLite compose file..."
cat > "$SQLITE_COMPOSE" << EOF
services:
  meshmonitor-db-backing-sqlite:
    container_name: meshmonitor-db-backing-sqlite-test
    image: meshmonitor:test
    ports:
      - "$TEST_PORT:3001"
    volumes:
      - meshmonitor-db-backing-sqlite-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=$TEST_NODE_IP
      - DATABASE_PATH=/data/meshmonitor.db
      - LOG_LEVEL=info

volumes:
  meshmonitor-db-backing-sqlite-test-data:
EOF

echo "Starting SQLite container..."
docker compose -f "$SQLITE_COMPOSE" up -d
echo -e "${GREEN}✓${NC} SQLite container started"
echo ""

if wait_for_ready "SQLite" 60 "meshmonitor-db-backing-sqlite-test"; then
    if authenticate_and_fetch_nodes "SQLite" "$SQLITE_NODES_FILE"; then
        SQLITE_RESULT="PASSED"
    else
        SQLITE_RESULT="FAILED"
    fi
else
    SQLITE_RESULT="FAILED"
fi

echo ""
echo "Tearing down SQLite container..."
docker compose -f "$SQLITE_COMPOSE" down -v 2>/dev/null || true
echo -e "${GREEN}✓${NC} SQLite container removed"
echo ""

if [ "$SQLITE_RESULT" != "PASSED" ]; then
    echo -e "${RED}✗ FAIL${NC}: SQLite backend failed, aborting remaining tests"
    exit 1
fi

# ===== PostgreSQL Backend Test =====
echo "=========================================="
echo -e "${BLUE}PostgreSQL Backend${NC}"
echo "=========================================="
echo ""

echo "Creating PostgreSQL compose file..."
cat > "$POSTGRES_COMPOSE" << EOF
services:
  postgres:
    container_name: meshmonitor-db-backing-postgres-db
    image: postgres:16-alpine
    environment:
      - POSTGRES_USER=meshmonitor
      - POSTGRES_PASSWORD=testpass123
      - POSTGRES_DB=meshmonitor
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meshmonitor"]
      interval: 5s
      timeout: 5s
      retries: 10

  meshmonitor-db-backing-postgres:
    container_name: meshmonitor-db-backing-postgres-test
    image: meshmonitor:test
    ports:
      - "$TEST_PORT:3001"
    volumes:
      - meshmonitor-db-backing-postgres-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=$TEST_NODE_IP
      - DATABASE_URL=postgres://meshmonitor:testpass123@postgres:5432/meshmonitor
      - LOG_LEVEL=info
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  meshmonitor-db-backing-postgres-test-data:
EOF

echo "Starting PostgreSQL containers..."
docker compose -f "$POSTGRES_COMPOSE" up -d
echo -e "${GREEN}✓${NC} PostgreSQL containers started"
echo ""

if wait_for_ready "PostgreSQL" 60 "meshmonitor-db-backing-postgres-test"; then
    if authenticate_and_fetch_nodes "PostgreSQL" "$POSTGRES_NODES_FILE"; then
        POSTGRES_RESULT="PASSED"
    else
        POSTGRES_RESULT="FAILED"
    fi
else
    POSTGRES_RESULT="FAILED"
fi

echo ""
echo "Tearing down PostgreSQL containers..."
docker compose -f "$POSTGRES_COMPOSE" down -v 2>/dev/null || true
echo -e "${GREEN}✓${NC} PostgreSQL containers removed"
echo ""

if [ "$POSTGRES_RESULT" != "PASSED" ]; then
    echo -e "${RED}✗ FAIL${NC}: PostgreSQL backend failed, aborting remaining tests"
    exit 1
fi

# ===== MySQL Backend Test =====
echo "=========================================="
echo -e "${BLUE}MySQL Backend${NC}"
echo "=========================================="
echo ""

echo "Creating MySQL compose file..."
cat > "$MYSQL_COMPOSE" << EOF
services:
  mysql:
    container_name: meshmonitor-db-backing-mysql-db
    image: mysql:8
    environment:
      - MYSQL_ROOT_PASSWORD=rootpass
      - MYSQL_USER=meshmonitor
      - MYSQL_PASSWORD=testpass123
      - MYSQL_DATABASE=meshmonitor
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "meshmonitor", "-ptestpass123"]
      interval: 5s
      timeout: 5s
      retries: 20

  meshmonitor-db-backing-mysql:
    container_name: meshmonitor-db-backing-mysql-test
    image: meshmonitor:test
    ports:
      - "$TEST_PORT:3001"
    volumes:
      - meshmonitor-db-backing-mysql-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=$TEST_NODE_IP
      - DATABASE_URL=mysql://meshmonitor:testpass123@mysql:3306/meshmonitor
      - LOG_LEVEL=info
    depends_on:
      mysql:
        condition: service_healthy

volumes:
  meshmonitor-db-backing-mysql-test-data:
EOF

echo "Starting MySQL containers..."
docker compose -f "$MYSQL_COMPOSE" up -d
echo -e "${GREEN}✓${NC} MySQL containers started"
echo ""

if wait_for_ready "MySQL" 120 "meshmonitor-db-backing-mysql-test"; then
    if authenticate_and_fetch_nodes "MySQL" "$MYSQL_NODES_FILE"; then
        MYSQL_RESULT="PASSED"
    else
        MYSQL_RESULT="FAILED"
    fi
else
    MYSQL_RESULT="FAILED"
fi

echo ""
echo "Tearing down MySQL containers..."
docker compose -f "$MYSQL_COMPOSE" down -v 2>/dev/null || true
echo -e "${GREEN}✓${NC} MySQL containers removed"
echo ""

if [ "$MYSQL_RESULT" != "PASSED" ]; then
    echo -e "${RED}✗ FAIL${NC}: MySQL backend failed, aborting comparison"
    exit 1
fi

# ===== Compare Results =====
echo "=========================================="
echo -e "${BLUE}Comparing Results Across Backends${NC}"
echo "=========================================="
echo ""

python3 - "$SQLITE_NODES_FILE" "$POSTGRES_NODES_FILE" "$MYSQL_NODES_FILE" << 'PYEOF'
import json
import sys

def load_nodes(path):
    with open(path) as f:
        data = json.load(f)
    # Handle both array and object-with-array formats
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and "nodes" in data:
        return data["nodes"]
    return data

sqlite_path, pg_path, mysql_path = sys.argv[1], sys.argv[2], sys.argv[3]

sqlite_nodes = load_nodes(sqlite_path)
pg_nodes = load_nodes(pg_path)
mysql_nodes = load_nodes(mysql_path)

sqlite_count = len(sqlite_nodes)
pg_count = len(pg_nodes)
mysql_count = len(mysql_nodes)

print(f"  SQLite nodes:     {sqlite_count}")
print(f"  PostgreSQL nodes: {pg_count}")
print(f"  MySQL nodes:      {mysql_count}")
print()

passed = True

# 1. Node count tolerance: all three within +/- 10 of each other
max_count = max(sqlite_count, pg_count, mysql_count)
min_count = min(sqlite_count, pg_count, mysql_count)
if max_count - min_count <= 10:
    print(f"\033[0;32m✓ PASS\033[0m: Node counts within ±10 (range: {min_count}-{max_count})")
else:
    print(f"\033[0;31m✗ FAIL\033[0m: Node counts differ by more than 10 (range: {min_count}-{max_count})")
    passed = False

# Helper to extract favorites
def get_favorites(nodes):
    favs = []
    for n in nodes:
        if n.get("isFavorite"):
            favs.append(n)
    return favs

sqlite_favs = get_favorites(sqlite_nodes)
pg_favs = get_favorites(pg_nodes)
mysql_favs = get_favorites(mysql_nodes)

print(f"  SQLite favorites:     {len(sqlite_favs)}")
print(f"  PostgreSQL favorites: {len(pg_favs)}")
print(f"  MySQL favorites:      {len(mysql_favs)}")

# 2. Favorite count: identical across all three
if len(sqlite_favs) == len(pg_favs) == len(mysql_favs):
    print(f"\033[0;32m✓ PASS\033[0m: Favorite counts identical ({len(sqlite_favs)})")
else:
    print(f"\033[0;31m✗ FAIL\033[0m: Favorite counts differ (SQLite={len(sqlite_favs)}, PG={len(pg_favs)}, MySQL={len(mysql_favs)})")
    passed = False

# 3. "Yeraze StationG2" exists as a favorite on all three with identical longName
def find_station(nodes, name_substr):
    for n in nodes:
        user = n.get("user", {}) or {}
        long_name = user.get("longName", "")
        if name_substr in long_name:
            return n
    return None

target_name = "Yeraze StationG2"
sqlite_station = find_station(sqlite_nodes, target_name)
pg_station = find_station(pg_nodes, target_name)
mysql_station = find_station(mysql_nodes, target_name)

if sqlite_station and pg_station and mysql_station:
    all_fav = (
        sqlite_station.get("isFavorite") and
        pg_station.get("isFavorite") and
        mysql_station.get("isFavorite")
    )
    if all_fav:
        print(f'\033[0;32m✓ PASS\033[0m: "{target_name}" exists as favorite on all three backends')
    else:
        print(f'\033[0;31m✗ FAIL\033[0m: "{target_name}" found but not marked as favorite on all backends')
        passed = False

    # Verify longName is identical
    names = set()
    for station in [sqlite_station, pg_station, mysql_station]:
        names.add((station.get("user", {}) or {}).get("longName", ""))
    if len(names) == 1:
        print(f'\033[0;32m✓ PASS\033[0m: "{target_name}" longName identical across all backends')
    else:
        print(f'\033[0;31m✗ FAIL\033[0m: "{target_name}" longName differs: {names}')
        passed = False
else:
    missing = []
    if not sqlite_station:
        missing.append("SQLite")
    if not pg_station:
        missing.append("PostgreSQL")
    if not mysql_station:
        missing.append("MySQL")
    print(f'\033[0;31m✗ FAIL\033[0m: "{target_name}" not found on: {", ".join(missing)}')
    passed = False

print()
if passed:
    sys.exit(0)
else:
    sys.exit(1)
PYEOF

if [ $? -eq 0 ]; then
    COMPARE_RESULT="PASSED"
else
    COMPARE_RESULT="FAILED"
fi

# Summary
echo "=========================================="
echo "Database Backing Consistency Test Results"
echo "=========================================="
echo ""

if [ "$SQLITE_RESULT" = "PASSED" ]; then
    echo -e "SQLite Backend:      ${GREEN}✓ PASSED${NC}"
else
    echo -e "SQLite Backend:      ${RED}✗ FAILED${NC}"
fi

if [ "$POSTGRES_RESULT" = "PASSED" ]; then
    echo -e "PostgreSQL Backend:  ${GREEN}✓ PASSED${NC}"
else
    echo -e "PostgreSQL Backend:  ${RED}✗ FAILED${NC}"
fi

if [ "$MYSQL_RESULT" = "PASSED" ]; then
    echo -e "MySQL Backend:       ${GREEN}✓ PASSED${NC}"
else
    echo -e "MySQL Backend:       ${RED}✗ FAILED${NC}"
fi

if [ "$COMPARE_RESULT" = "PASSED" ]; then
    echo -e "Cross-DB Comparison: ${GREEN}✓ PASSED${NC}"
else
    echo -e "Cross-DB Comparison: ${RED}✗ FAILED${NC}"
fi

echo ""

# Exit with failure if any test failed
if [ "$SQLITE_RESULT" != "PASSED" ] || [ "$POSTGRES_RESULT" != "PASSED" ] || [ "$MYSQL_RESULT" != "PASSED" ] || [ "$COMPARE_RESULT" != "PASSED" ]; then
    echo -e "${RED}=========================================="
    echo "✗ DATABASE BACKING CONSISTENCY TEST FAILED"
    echo "==========================================${NC}"
    exit 1
fi

echo -e "${GREEN}=========================================="
echo "✓ DATABASE BACKING CONSISTENCY TEST PASSED"
echo "==========================================${NC}"
echo ""
echo "All three database backends produced consistent node data:"
echo "  • SQLite, PostgreSQL, and MySQL node counts within ±10"
echo "  • Favorite counts identical across all backends"
echo "  • Key station verified across all backends"
echo ""
