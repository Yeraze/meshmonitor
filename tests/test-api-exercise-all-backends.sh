#!/bin/bash
# API Exercise Test — All Database Backends
#
# Runs the API exercise test against SQLite, PostgreSQL, and MySQL backends
# to verify response structure consistency across all databases.
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
COMPOSE_FILE="docker-compose.dev.yml"

cd "$PROJECT_ROOT"

# Backend definitions: profile -> compose service name
declare -A BACKENDS
BACKENDS[sqlite]="meshmonitor-sqlite"
BACKENDS[postgres]="meshmonitor"
BACKENDS[mysql]="meshmonitor-mysql"

# Port for dev containers
DEV_PORT=8081
BASE_URL="http://localhost:${DEV_PORT}/meshmonitor"

# Track results
TOTAL_PASS=0
TOTAL_FAIL=0
RESULTS=()

cleanup() {
    echo -e "${BLUE}Cleaning up all backends...${NC}"
    for profile in sqlite postgres mysql; do
        COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    done
}

trap cleanup EXIT

# Pre-flight: stop any running dev containers and clean up volumes
echo -e "${BLUE}Stopping any running dev containers...${NC}"
for profile in sqlite postgres mysql; do
    COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
done
# Extra cleanup: kill any leftover containers on port 8081
docker ps --filter "publish=8081" -q 2>/dev/null | xargs -r docker stop 2>/dev/null || true
sleep 2

for profile in sqlite postgres mysql; do
    CONTAINER="${BACKENDS[$profile]}"

    echo ""
    echo "=========================================="
    echo -e "${BLUE}Testing $profile backend${NC}"
    echo "=========================================="

    # Start backend
    echo -e "${BLUE}Starting $profile...${NC}"
    COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" up -d 2>/dev/null

    # MySQL needs extra time for database initialization
    if [ "$profile" = "mysql" ]; then
        echo -e "${BLUE}Waiting for MySQL database to be healthy...${NC}"
        for i in $(seq 1 60); do
            if COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" ps 2>/dev/null | grep -q "healthy"; then
                echo -e "${GREEN}✓ MySQL database healthy${NC}"
                break
            fi
            sleep 3
        done
    fi

    # Wait for container to be healthy (up to 3 minutes)
    echo -e "${BLUE}Waiting for $CONTAINER to be ready...${NC}"
    READY=false
    for i in $(seq 1 90); do
        if COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" ps "$CONTAINER" 2>/dev/null | grep -q "Up"; then
            # Check if API responds
            HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/health" 2>/dev/null || echo "000")
            if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "404" ]; then
                # Also check auth endpoint (more reliable)
                HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_URL}/api/csrf-token" 2>/dev/null || echo "000")
                if [ "$HTTP_STATUS" = "200" ]; then
                    READY=true
                    break
                fi
            fi
        fi
        sleep 2
    done

    if [ "$READY" = false ]; then
        echo -e "${RED}✗ $profile backend failed to start${NC}"
        RESULTS+=("$profile: FAILED (startup)")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
        continue
    fi

    echo -e "${GREEN}✓ $profile backend ready${NC}"

    # Run the API exercise test
    if bash "$SCRIPT_DIR/api-exercise-test.sh" "$BASE_URL"; then
        echo -e "${GREEN}✓ $profile: API exercise test PASSED${NC}"
        RESULTS+=("$profile: PASSED")
        TOTAL_PASS=$((TOTAL_PASS + 1))
    else
        echo -e "${RED}✗ $profile: API exercise test FAILED${NC}"
        RESULTS+=("$profile: FAILED")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        # Dump container logs so CI can diagnose the failure
        echo -e "${YELLOW}--- $CONTAINER logs (last 200 lines) ---${NC}"
        docker logs --tail 200 "$CONTAINER" 2>&1 || true
        echo -e "${YELLOW}--- end $CONTAINER logs ---${NC}"
    fi

    # Stop backend and clean volumes
    echo -e "${BLUE}Stopping $profile...${NC}"
    COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v --remove-orphans 2>/dev/null || true
    sleep 3
done

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
