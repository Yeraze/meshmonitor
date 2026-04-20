#!/bin/bash
# API Exercise Test — All Database Backends
#
# Runs the API exercise test against SQLite, PostgreSQL, and MySQL backends
# to verify response structure consistency across all databases.
#
# Pattern matches tests/test-database-backing.sh: each backend runs in its
# own inline compose file with test-scoped volume names. This guarantees
# `docker compose down -v` NEVER touches the developer's dev volumes
# (`meshmonitor_meshmonitor-sqlite-data`, etc.) because the compose files
# here do not reference them.
#
# Usage: tests/test-api-exercise-all-backends.sh

set -e

echo "=========================================="
echo "API Exercise Test — All Backends"
echo "=========================================="
echo ""

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# Test configuration
TEST_NODE_IP="${TEST_NODE_IP:-192.168.5.106}"
TEST_PORT="8085"
BASE_URL="http://localhost:${TEST_PORT}/meshmonitor"

SQLITE_COMPOSE="docker-compose.api-exercise-sqlite-test.yml"
POSTGRES_COMPOSE="docker-compose.api-exercise-postgres-test.yml"
MYSQL_COMPOSE="docker-compose.api-exercise-mysql-test.yml"

# Track results
TOTAL_PASS=0
TOTAL_FAIL=0
RESULTS=()

cleanup() {
    echo -e "${BLUE}Cleaning up api-exercise test artifacts...${NC}"
    # These compose files reference only test-scoped volumes; safe to -v.
    docker compose -f "$SQLITE_COMPOSE" down -v 2>/dev/null || true
    docker compose -f "$POSTGRES_COMPOSE" down -v 2>/dev/null || true
    docker compose -f "$MYSQL_COMPOSE" down -v 2>/dev/null || true
    rm -f "$SQLITE_COMPOSE" "$POSTGRES_COMPOSE" "$MYSQL_COMPOSE" 2>/dev/null || true
}

trap cleanup EXIT

wait_for_ready() {
    local NAME="$1"
    local CONTAINER="$2"
    local MAX_WAIT="${3:-120}"

    echo -e "${BLUE}Waiting for $NAME API (up to ${MAX_WAIT}s)...${NC}"
    for i in $(seq 1 "$MAX_WAIT"); do
        local HTTP_STATUS
        HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/csrf-token" 2>/dev/null || echo "000")
        if [ "$HTTP_STATUS" = "200" ]; then
            echo -e "${GREEN}✓${NC} $NAME API ready"
            return 0
        fi
        sleep 1
    done

    echo -e "${RED}✗${NC} $NAME API did not become ready"
    echo -e "${YELLOW}--- $CONTAINER logs (last 100 lines) ---${NC}"
    docker logs --tail 100 "$CONTAINER" 2>&1 || true
    echo -e "${YELLOW}--- end $CONTAINER logs ---${NC}"
    return 1
}

run_backend() {
    local NAME="$1"
    local COMPOSE_FILE="$2"
    local CONTAINER="$3"
    local MAX_WAIT="$4"

    echo ""
    echo "=========================================="
    echo -e "${BLUE}Testing $NAME backend${NC}"
    echo "=========================================="

    docker compose -f "$COMPOSE_FILE" up -d

    if ! wait_for_ready "$NAME" "$CONTAINER" "$MAX_WAIT"; then
        RESULTS+=("$NAME: FAILED (startup)")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
        return
    fi

    if bash "$SCRIPT_DIR/api-exercise-test.sh" "$BASE_URL"; then
        echo -e "${GREEN}✓ $NAME: API exercise test PASSED${NC}"
        RESULTS+=("$NAME: PASSED")
        TOTAL_PASS=$((TOTAL_PASS + 1))
    else
        echo -e "${RED}✗ $NAME: API exercise test FAILED${NC}"
        RESULTS+=("$NAME: FAILED")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        echo -e "${YELLOW}--- $CONTAINER logs (last 200 lines) ---${NC}"
        docker logs --tail 200 "$CONTAINER" 2>&1 || true
        echo -e "${YELLOW}--- end $CONTAINER logs ---${NC}"
    fi

    docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
}

# ===== SQLite =====
cat > "$SQLITE_COMPOSE" << EOF
services:
  meshmonitor-api-exercise-sqlite:
    container_name: meshmonitor-api-exercise-sqlite-test
    image: meshmonitor:test
    ports:
      - "$TEST_PORT:3001"
    volumes:
      - meshmonitor-api-exercise-sqlite-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=$TEST_NODE_IP
      - DATABASE_PATH=/data/meshmonitor.db
      - SESSION_SECRET=qlskjerhqlwkjehrlqkwejh
      - BASE_URL=/meshmonitor
      - TZ=America/New_York
      - ALLOWED_ORIGINS=http://localhost:$TEST_PORT
      - TRUST_PROXY=1
      - COOKIE_SECURE=false
      - LOG_LEVEL=info

volumes:
  meshmonitor-api-exercise-sqlite-test-data:
EOF

run_backend "sqlite" "$SQLITE_COMPOSE" "meshmonitor-api-exercise-sqlite-test" 90

# ===== PostgreSQL =====
cat > "$POSTGRES_COMPOSE" << EOF
services:
  postgres:
    container_name: meshmonitor-api-exercise-postgres-db
    image: postgres:16-alpine
    environment:
      - POSTGRES_DB=meshmonitor
      - POSTGRES_USER=meshmonitor
      - POSTGRES_PASSWORD=testpass123
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U meshmonitor -d meshmonitor"]
      interval: 5s
      timeout: 5s
      retries: 10

  meshmonitor-api-exercise-postgres:
    container_name: meshmonitor-api-exercise-postgres-test
    image: meshmonitor:test
    depends_on:
      postgres:
        condition: service_healthy
    ports:
      - "$TEST_PORT:3001"
    volumes:
      - meshmonitor-api-exercise-postgres-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=$TEST_NODE_IP
      - DATABASE_URL=postgres://meshmonitor:testpass123@postgres:5432/meshmonitor
      - SESSION_SECRET=qlskjerhqlwkjehrlqkwejh
      - BASE_URL=/meshmonitor
      - TZ=America/New_York
      - ALLOWED_ORIGINS=http://localhost:$TEST_PORT
      - TRUST_PROXY=1
      - COOKIE_SECURE=false
      - LOG_LEVEL=info

volumes:
  meshmonitor-api-exercise-postgres-test-data:
EOF

run_backend "postgres" "$POSTGRES_COMPOSE" "meshmonitor-api-exercise-postgres-test" 120

# ===== MySQL =====
cat > "$MYSQL_COMPOSE" << EOF
services:
  mysql:
    container_name: meshmonitor-api-exercise-mysql-db
    image: mysql:8
    environment:
      - MYSQL_DATABASE=meshmonitor
      - MYSQL_USER=meshmonitor
      - MYSQL_PASSWORD=testpass123
      - MYSQL_ROOT_PASSWORD=rootpass123
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 5s
      timeout: 5s
      retries: 20

  meshmonitor-api-exercise-mysql:
    container_name: meshmonitor-api-exercise-mysql-test
    image: meshmonitor:test
    depends_on:
      mysql:
        condition: service_healthy
    ports:
      - "$TEST_PORT:3001"
    volumes:
      - meshmonitor-api-exercise-mysql-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_NODE_IP=$TEST_NODE_IP
      - DATABASE_URL=mysql://meshmonitor:testpass123@mysql:3306/meshmonitor
      - SESSION_SECRET=qlskjerhqlwkjehrlqkwejh
      - BASE_URL=/meshmonitor
      - TZ=America/New_York
      - ALLOWED_ORIGINS=http://localhost:$TEST_PORT
      - TRUST_PROXY=1
      - COOKIE_SECURE=false
      - LOG_LEVEL=info

volumes:
  meshmonitor-api-exercise-mysql-test-data:
EOF

run_backend "mysql" "$MYSQL_COMPOSE" "meshmonitor-api-exercise-mysql-test" 180

# Summary
echo ""
echo "=========================================="
echo "API Exercise Test — All Backends Results"
echo "=========================================="

for result in "${RESULTS[@]}"; do
    profile="${result%%:*}"
    status="${result#*: }"
    if [ "$status" = "PASSED" ]; then
        echo -e "  ${GREEN}✓${NC} $profile: PASS"
    else
        echo -e "  ${RED}✗${NC} $profile: FAIL"
    fi
done

echo ""

if [ $TOTAL_FAIL -gt 0 ]; then
    echo -e "${RED}✗ API EXERCISE TEST FAILED ($TOTAL_FAIL backend(s) failed)${NC}"
    exit 1
else
    echo -e "${GREEN}✓ ALL BACKENDS PASSED${NC}"
    exit 0
fi
