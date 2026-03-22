#!/bin/bash
# Backend Soak Test
#
# Launches each database backend (SQLite, PostgreSQL, MySQL) in sequence,
# runs for a configurable duration while monitoring logs for errors,
# and fails if any error messages are found.
#
# Usage: tests/backend-soak-test.sh [duration_seconds]
#   duration_seconds: How long to soak each backend (default: 300 = 5 minutes)

set -e

# Configuration
SOAK_DURATION=${1:-300}
COMPOSE_FILE="docker-compose.dev.yml"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Backend definitions: profile, app container name
declare -A BACKENDS
BACKENDS[sqlite]="meshmonitor-sqlite"
BACKENDS[postgres]="meshmonitor"
BACKENDS[mysql]="meshmonitor-mysql-app"

# Error patterns to watch for in logs
# Excludes expected/informational messages that contain "error" in non-error contexts
ERROR_PATTERNS='(\[ERROR\]|FATAL|ECONNREFUSED|SQLITE_ERROR|SqliteError|uncaughtException|unhandledRejection)'
# Patterns to exclude from error matching (false positives)
EXCLUDE_PATTERNS='(error_correction|error\.tsx|error\.ts|RoutingError|errorCount|clearError|getPortNumName|error-boundary|isError|onError|handleError|LogLevel\.ERROR|errorDetails|_error|\.error\b.*=|error_event|Error fetching or storing news)'

# Log output directory
LOG_DIR="$PROJECT_DIR/tests/soak-logs"
mkdir -p "$LOG_DIR"

# Track results
TOTAL_PASS=0
TOTAL_FAIL=0
RESULTS=()

cd "$PROJECT_DIR"

echo "=========================================="
echo "Backend Soak Test"
echo "=========================================="
echo "Duration per backend: ${SOAK_DURATION}s"
echo "Backends: sqlite, postgres, mysql"
echo ""

# Cleanup function
cleanup() {
    echo -e "${BLUE}Cleaning up...${NC}"
    for profile in sqlite postgres mysql; do
        COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    done
    echo -e "${GREEN}✓${NC} Cleanup complete"
}

trap cleanup EXIT

# Stop any running dev containers first
echo -e "${BLUE}Stopping any running dev containers...${NC}"
for profile in sqlite postgres mysql; do
    COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
done
echo -e "${GREEN}✓${NC} Clean slate"
echo ""

# Wait for container to be healthy/running
wait_for_container() {
    local container=$1
    local max_wait=120
    local elapsed=0

    echo -n "  Waiting for $container to be ready"
    while [ $elapsed -lt $max_wait ]; do
        local status
        status=$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "missing")

        if [ "$status" = "running" ]; then
            # Check if the app has started by looking for the listen message
            if docker logs "$container" 2>&1 | grep -q "listening\|Server started\|ready\|Listening on"; then
                echo -e " ${GREEN}✓${NC} (${elapsed}s)"
                return 0
            fi
        fi

        sleep 5
        elapsed=$((elapsed + 5))
        echo -n "."
    done

    echo -e " ${RED}✗${NC} (timeout after ${max_wait}s)"
    return 1
}

# Test a single backend
test_backend() {
    local profile=$1
    local container=${BACKENDS[$profile]}
    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local log_file="${LOG_DIR}/${profile}-${timestamp}.log"

    echo "=========================================="
    echo -e "${BLUE}Testing: $profile${NC}"
    echo "=========================================="

    # Build and start
    echo "  Building..."
    COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" build --quiet 2>&1 | tail -1
    echo "  Starting containers..."
    COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" up -d 2>/dev/null

    # Wait for app container
    if ! wait_for_container "$container"; then
        echo -e "  ${RED}✗ $profile: Container failed to start${NC}"
        docker logs "$container" 2>&1 | tail -20
        COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
        RESULTS+=("$profile: FAIL (container failed to start)")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
        return 1
    fi

    # Soak: monitor logs for the configured duration
    echo "  Soaking for ${SOAK_DURATION}s (monitoring logs for errors)..."
    local start_time
    start_time=$(date +%s)

    # Clear log file
    > "$log_file"

    # Collect logs during soak period
    local remaining=$SOAK_DURATION
    while [ $remaining -gt 0 ]; do
        local chunk=$remaining
        if [ $chunk -gt 30 ]; then
            chunk=30
        fi
        sleep "$chunk"
        remaining=$((remaining - chunk))

        local elapsed=$(( $(date +%s) - start_time ))
        local pct=$(( elapsed * 100 / SOAK_DURATION ))
        echo -ne "\r  Progress: ${elapsed}s / ${SOAK_DURATION}s (${pct}%)"
    done
    echo ""

    # Capture full logs
    docker logs "$container" > "$log_file" 2>&1

    # Check for errors
    local error_lines
    error_lines=$(grep -E "$ERROR_PATTERNS" "$log_file" | grep -Ev "$EXCLUDE_PATTERNS" || true)
    local error_count
    error_count=$(echo "$error_lines" | grep -c . || true)

    if [ -n "$error_lines" ] && [ "$error_count" -gt 0 ]; then
        echo -e "  ${RED}✗ $profile: Found $error_count error(s) in logs${NC}"
        echo ""
        echo "  Error lines:"
        echo "$error_lines" | head -20 | while IFS= read -r line; do
            echo -e "    ${RED}$line${NC}"
        done
        if [ "$error_count" -gt 20 ]; then
            echo "    ... and $((error_count - 20)) more"
        fi
        echo ""
        echo "  Full logs saved to: $log_file"
        RESULTS+=("$profile: FAIL ($error_count errors)")
        TOTAL_FAIL=$((TOTAL_FAIL + 1))
    else
        echo -e "  ${GREEN}✓ $profile: No errors found in logs${NC}"
        RESULTS+=("$profile: PASS")
        TOTAL_PASS=$((TOTAL_PASS + 1))
    fi

    # Stop this backend
    echo "  Stopping $profile containers..."
    COMPOSE_PROFILES="$profile" docker compose -f "$COMPOSE_FILE" down -v 2>/dev/null || true
    echo ""
}

# Run each backend
for profile in sqlite postgres mysql; do
    test_backend "$profile"
done

# Summary
echo "=========================================="
echo "Backend Soak Test Results"
echo "=========================================="
echo ""
for result in "${RESULTS[@]}"; do
    local_profile=$(echo "$result" | cut -d: -f1)
    local_status=$(echo "$result" | cut -d: -f2-)
    if echo "$result" | grep -q "PASS"; then
        echo -e "  ${GREEN}✓${NC} $result"
    else
        echo -e "  ${RED}✗${NC} $result"
    fi
done
echo ""
echo "Passed: $TOTAL_PASS / $((TOTAL_PASS + TOTAL_FAIL))"
echo ""
echo "Logs saved to: $LOG_DIR/"
ls -lh "$LOG_DIR"/*.log 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}'
echo ""

if [ $TOTAL_FAIL -gt 0 ]; then
    echo -e "${RED}=========================================="
    echo -e "✗ BACKEND SOAK TEST FAILED"
    echo -e "==========================================${NC}"
    exit 1
else
    echo -e "${GREEN}=========================================="
    echo -e "✓ ALL BACKENDS PASSED"
    echo -e "==========================================${NC}"
    exit 0
fi
