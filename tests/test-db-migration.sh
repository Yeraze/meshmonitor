#!/bin/bash
# Database Migration Test
# Tests migration from SQLite to PostgreSQL and MySQL

set -e  # Exit on any error

echo "=========================================="
echo "Database Migration Test"
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

# Test configuration
POSTGRES_PORT="5433"
MYSQL_PORT="3307"
SOURCE_CONTAINER="meshmonitor-migration-source-test"
SOURCE_PORT="8087"
SOURCE_COMPOSE_FILE="docker-compose.migration-source-test.yml"
SQLITE_DB_PATH="/tmp/test-migration-source.db"

# Track results
POSTGRES_RESULT="NOT_RUN"
MYSQL_RESULT="NOT_RUN"

# Cleanup function
cleanup_migration_test() {
    echo ""
    echo -e "${BLUE}Cleaning up database migration test artifacts...${NC}"

    # Stop containers
    docker stop meshmonitor-postgres-test 2>/dev/null || true
    docker rm meshmonitor-postgres-test 2>/dev/null || true
    docker stop meshmonitor-mysql-test 2>/dev/null || true
    docker rm meshmonitor-mysql-test 2>/dev/null || true
    docker compose -f "$SOURCE_COMPOSE_FILE" down -v 2>/dev/null || true

    # Remove temp files
    rm -f "$SQLITE_DB_PATH" 2>/dev/null || true
    rm -f "$SOURCE_COMPOSE_FILE" 2>/dev/null || true
    rm -f /tmp/meshmonitor-migration-cookies.txt 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Cleanup complete"
}

# Set trap for cleanup
trap cleanup_migration_test EXIT

echo "Creating source container with test data..."
cat > "$SOURCE_COMPOSE_FILE" << EOF
services:
  meshmonitor-migration-source:
    container_name: $SOURCE_CONTAINER
    image: meshmonitor:test
    ports:
      - "$SOURCE_PORT:3001"
    volumes:
      - meshmonitor-migration-source-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_HOST=192.168.1.208
      - LOG_LEVEL=info

volumes:
  meshmonitor-migration-source-test-data:
EOF

echo -e "${GREEN}✓${NC} Source config created"
echo ""

echo "Starting source container..."
docker compose -f "$SOURCE_COMPOSE_FILE" up -d
echo -e "${GREEN}✓${NC} Container started"
echo ""

# Wait for API to be ready
echo "Waiting for source API to be ready..."
COUNTER=0
MAX_WAIT=60
while [ $COUNTER -lt $MAX_WAIT ]; do
    POLL_RESPONSE=$(curl -s "http://localhost:$SOURCE_PORT/api/poll" 2>/dev/null || echo "{}")
    if echo "$POLL_RESPONSE" | grep -q '"connection"'; then
        echo -e "${GREEN}✓ PASS${NC}: Source API is ready"
        break
    fi
    COUNTER=$((COUNTER + 1))
    if [ $COUNTER -eq $MAX_WAIT ]; then
        echo -e "${RED}✗ FAIL${NC}: Source API did not become ready"
        docker logs "$SOURCE_CONTAINER" 2>&1 | tail -30
        exit 1
    fi
    sleep 1
done
echo ""

# Wait a bit for some data to populate
echo "Waiting for initial data (10 seconds)..."
sleep 10

# Login and get baseline data counts
echo "Getting CSRF token..."
CSRF_TOKEN=$(curl -s -c /tmp/meshmonitor-migration-cookies.txt \
    "http://localhost:$SOURCE_PORT/api/csrf-token" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)

echo "Logging in..."
LOGIN_RESPONSE=$(curl -s -b /tmp/meshmonitor-migration-cookies.txt \
    -c /tmp/meshmonitor-migration-cookies.txt \
    -X POST "http://localhost:$SOURCE_PORT/api/auth/login" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}')

if ! echo "$LOGIN_RESPONSE" | grep -q "success"; then
    echo -e "${RED}✗ FAIL${NC}: Login failed"
    echo "Response: $LOGIN_RESPONSE"
    exit 1
fi
echo -e "${GREEN}✓ PASS${NC}: Login successful"

# Re-fetch CSRF token after login (session is regenerated on auth)
CSRF_RESPONSE=$(curl -s -w "\n%{http_code}" http://localhost:$SOURCE_PORT/api/csrf-token \
    -b /tmp/meshmonitor-migration-cookies.txt \
    -c /tmp/meshmonitor-migration-cookies.txt)
HTTP_CODE=$(echo "$CSRF_RESPONSE" | tail -n1)
CSRF_TOKEN=$(echo "$CSRF_RESPONSE" | head -n-1 | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)

if [ "$HTTP_CODE" = "200" ] && [ -n "$CSRF_TOKEN" ]; then
    echo -e "${GREEN}✓${NC} Post-login CSRF token obtained"
else
    echo -e "${RED}✗ FAIL${NC}: Failed to get post-login CSRF token"
    exit 1
fi
echo ""

# Collect baseline counts directly from SQLite (more accurate than API)
echo "Collecting baseline data counts from source database..."

# We'll get counts after extracting the database
echo -e "${GREEN}✓${NC} Will collect counts after database extraction"
echo ""

# Copy SQLite database from container
echo "Extracting SQLite database from container..."
docker cp "$SOURCE_CONTAINER:/data/meshmonitor.db" "$SQLITE_DB_PATH"
if [ ! -f "$SQLITE_DB_PATH" ]; then
    echo -e "${RED}✗ FAIL${NC}: Failed to extract SQLite database"
    exit 1
fi
echo -e "${GREEN}✓${NC} SQLite database extracted"

# Get actual counts from SQLite using host sqlite3
echo "Getting baseline counts from SQLite database..."
if command -v sqlite3 &> /dev/null; then
    SQLITE_NODE_COUNT=$(sqlite3 "$SQLITE_DB_PATH" "SELECT COUNT(*) FROM nodes;" 2>/dev/null || echo "0")
    SQLITE_MESSAGE_COUNT=$(sqlite3 "$SQLITE_DB_PATH" "SELECT COUNT(*) FROM messages;" 2>/dev/null || echo "0")
    SQLITE_SETTINGS_COUNT=$(sqlite3 "$SQLITE_DB_PATH" "SELECT COUNT(*) FROM settings;" 2>/dev/null || echo "0")
    SQLITE_USER_COUNT=$(sqlite3 "$SQLITE_DB_PATH" "SELECT COUNT(*) FROM users;" 2>/dev/null || echo "0")
else
    echo -e "${YELLOW}⚠ WARN${NC}: sqlite3 not found on host, using API-based counts"
    # Fall back to API-based counts which may differ slightly
    SQLITE_NODE_COUNT=$(curl -s -b /tmp/meshmonitor-migration-cookies.txt \
        "http://localhost:$SOURCE_PORT/api/nodes" | grep -o '"nodeId"' | wc -l)
    SQLITE_MESSAGE_COUNT=$(curl -s -b /tmp/meshmonitor-migration-cookies.txt \
        "http://localhost:$SOURCE_PORT/api/messages" | grep -o '"id":' | wc -l)
    SQLITE_SETTINGS_COUNT=1
    SQLITE_USER_COUNT=1
fi

echo "  - SQLite Nodes: $SQLITE_NODE_COUNT"
echo "  - SQLite Messages: $SQLITE_MESSAGE_COUNT"
echo "  - SQLite Settings: $SQLITE_SETTINGS_COUNT"
echo "  - SQLite Users: $SQLITE_USER_COUNT"
echo -e "${GREEN}✓${NC} Baseline counts collected"
echo ""

# ===== PostgreSQL Migration Test =====
echo "=========================================="
echo -e "${BLUE}PostgreSQL Migration Test${NC}"
echo "=========================================="
echo ""

echo "Starting PostgreSQL container..."
docker run -d \
    --name meshmonitor-postgres-test \
    -e POSTGRES_USER=meshmonitor \
    -e POSTGRES_PASSWORD=testpass123 \
    -e POSTGRES_DB=meshmonitor \
    -p $POSTGRES_PORT:5432 \
    postgres:16-alpine

# Wait for PostgreSQL to be ready
echo "Waiting for PostgreSQL to be ready..."
COUNTER=0
MAX_WAIT=60
while [ $COUNTER -lt $MAX_WAIT ]; do
    if docker exec meshmonitor-postgres-test pg_isready -U meshmonitor > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} PostgreSQL is ready"
        break
    fi
    COUNTER=$((COUNTER + 1))
    if [ $COUNTER -eq $MAX_WAIT ]; then
        echo -e "${RED}✗ FAIL${NC}: PostgreSQL did not become ready"
        docker logs meshmonitor-postgres-test 2>&1 | tail -20
        POSTGRES_RESULT="FAILED"
    fi
    sleep 1
done
echo ""

if [ "$POSTGRES_RESULT" != "FAILED" ]; then
    echo "Running migration to PostgreSQL..."
    POSTGRES_URL="postgres://meshmonitor:testpass123@localhost:$POSTGRES_PORT/meshmonitor"

    # Run migration from project root with npm
    if npm run migrate-db -- --from "sqlite:$SQLITE_DB_PATH" --to "$POSTGRES_URL" --verbose 2>&1 | tee /tmp/pg-migration.log; then
        echo -e "${GREEN}✓${NC} PostgreSQL migration completed"

        # Verify data
        echo "Verifying PostgreSQL data..."
        PG_NODE_COUNT=$(docker exec meshmonitor-postgres-test psql -U meshmonitor -d meshmonitor -t -c "SELECT COUNT(*) FROM nodes;" 2>/dev/null | tr -d ' \n')
        PG_MESSAGE_COUNT=$(docker exec meshmonitor-postgres-test psql -U meshmonitor -d meshmonitor -t -c "SELECT COUNT(*) FROM messages;" 2>/dev/null | tr -d ' \n')
        PG_SETTINGS_COUNT=$(docker exec meshmonitor-postgres-test psql -U meshmonitor -d meshmonitor -t -c "SELECT COUNT(*) FROM settings;" 2>/dev/null | tr -d ' \n')
        PG_USER_COUNT=$(docker exec meshmonitor-postgres-test psql -U meshmonitor -d meshmonitor -t -c "SELECT COUNT(*) FROM users;" 2>/dev/null | tr -d ' \n')

        echo "  - PostgreSQL Nodes: $PG_NODE_COUNT (source: $SQLITE_NODE_COUNT)"
        echo "  - PostgreSQL Messages: $PG_MESSAGE_COUNT (source: $SQLITE_MESSAGE_COUNT)"
        echo "  - PostgreSQL Settings: $PG_SETTINGS_COUNT (source: $SQLITE_SETTINGS_COUNT)"
        echo "  - PostgreSQL Users: $PG_USER_COUNT (source: $SQLITE_USER_COUNT)"

        # Validate counts - target should have at least as many as source
        # Settings may have 1 extra row added by migration tool
        if [ "$PG_NODE_COUNT" -ge "$SQLITE_NODE_COUNT" ] && \
           [ "$PG_MESSAGE_COUNT" -eq "$SQLITE_MESSAGE_COUNT" ] && \
           [ "$PG_SETTINGS_COUNT" -ge "$SQLITE_SETTINGS_COUNT" ] && \
           [ "$PG_USER_COUNT" -eq "$SQLITE_USER_COUNT" ]; then
            echo -e "${GREEN}✓ PASS${NC}: PostgreSQL data verification passed"
            POSTGRES_RESULT="PASSED"
        else
            echo -e "${RED}✗ FAIL${NC}: PostgreSQL data verification failed"
            POSTGRES_RESULT="FAILED"
        fi
    else
        echo -e "${RED}✗ FAIL${NC}: PostgreSQL migration failed"
        cat /tmp/pg-migration.log | tail -30
        POSTGRES_RESULT="FAILED"
    fi
fi
echo ""

# Stop PostgreSQL
docker stop meshmonitor-postgres-test > /dev/null 2>&1 || true
docker rm meshmonitor-postgres-test > /dev/null 2>&1 || true

# ===== MySQL Migration Test =====
echo "=========================================="
echo -e "${BLUE}MySQL Migration Test${NC}"
echo "=========================================="
echo ""

echo "Starting MySQL container..."
docker run -d \
    --name meshmonitor-mysql-test \
    -e MYSQL_ROOT_PASSWORD=rootpass \
    -e MYSQL_USER=meshmonitor \
    -e MYSQL_PASSWORD=testpass123 \
    -e MYSQL_DATABASE=meshmonitor \
    -p $MYSQL_PORT:3306 \
    mysql:8

# Wait for MySQL to be ready (MySQL takes longer to initialize than PostgreSQL)
echo "Waiting for MySQL to be ready..."
COUNTER=0
MAX_WAIT=120
while [ $COUNTER -lt $MAX_WAIT ]; do
    if docker exec meshmonitor-mysql-test mysqladmin ping -h localhost -u meshmonitor -ptestpass123 > /dev/null 2>&1; then
        echo -e "${GREEN}✓${NC} MySQL is ready"
        # Give MySQL a few more seconds to fully initialize
        sleep 5
        break
    fi
    COUNTER=$((COUNTER + 1))
    if [ $COUNTER -eq $MAX_WAIT ]; then
        echo -e "${RED}✗ FAIL${NC}: MySQL did not become ready"
        docker logs meshmonitor-mysql-test 2>&1 | tail -20
        MYSQL_RESULT="FAILED"
    fi
    sleep 1
done
echo ""

if [ "$MYSQL_RESULT" != "FAILED" ]; then
    echo "Running migration to MySQL..."
    MYSQL_URL="mysql://meshmonitor:testpass123@localhost:$MYSQL_PORT/meshmonitor"

    # Run migration from project root with npm
    if npm run migrate-db -- --from "sqlite:$SQLITE_DB_PATH" --to "$MYSQL_URL" --verbose 2>&1 | tee /tmp/mysql-migration.log; then
        echo -e "${GREEN}✓${NC} MySQL migration completed"

        # Verify data
        echo "Verifying MySQL data..."
        MYSQL_NODE_COUNT=$(docker exec meshmonitor-mysql-test mysql -u meshmonitor -ptestpass123 -D meshmonitor -N -e "SELECT COUNT(*) FROM nodes;" 2>/dev/null | tr -d ' \n')
        MYSQL_MESSAGE_COUNT=$(docker exec meshmonitor-mysql-test mysql -u meshmonitor -ptestpass123 -D meshmonitor -N -e "SELECT COUNT(*) FROM messages;" 2>/dev/null | tr -d ' \n')
        MYSQL_SETTINGS_COUNT=$(docker exec meshmonitor-mysql-test mysql -u meshmonitor -ptestpass123 -D meshmonitor -N -e "SELECT COUNT(*) FROM settings;" 2>/dev/null | tr -d ' \n')
        MYSQL_USER_COUNT=$(docker exec meshmonitor-mysql-test mysql -u meshmonitor -ptestpass123 -D meshmonitor -N -e "SELECT COUNT(*) FROM users;" 2>/dev/null | tr -d ' \n')

        echo "  - MySQL Nodes: $MYSQL_NODE_COUNT (source: $SQLITE_NODE_COUNT)"
        echo "  - MySQL Messages: $MYSQL_MESSAGE_COUNT (source: $SQLITE_MESSAGE_COUNT)"
        echo "  - MySQL Settings: $MYSQL_SETTINGS_COUNT (source: $SQLITE_SETTINGS_COUNT)"
        echo "  - MySQL Users: $MYSQL_USER_COUNT (source: $SQLITE_USER_COUNT)"

        # Validate counts - target should have at least as many as source
        # Settings may have 1 extra row added by migration tool
        if [ -n "$MYSQL_NODE_COUNT" ] && [ -n "$MYSQL_USER_COUNT" ] && \
           [ "$MYSQL_NODE_COUNT" -ge "$SQLITE_NODE_COUNT" ] && \
           [ "$MYSQL_MESSAGE_COUNT" -eq "$SQLITE_MESSAGE_COUNT" ] && \
           [ "$MYSQL_SETTINGS_COUNT" -ge "$SQLITE_SETTINGS_COUNT" ] && \
           [ "$MYSQL_USER_COUNT" -eq "$SQLITE_USER_COUNT" ]; then
            echo -e "${GREEN}✓ PASS${NC}: MySQL data verification passed"
            MYSQL_RESULT="PASSED"
        else
            echo -e "${RED}✗ FAIL${NC}: MySQL data verification failed"
            MYSQL_RESULT="FAILED"
        fi
    else
        echo -e "${RED}✗ FAIL${NC}: MySQL migration failed"
        cat /tmp/mysql-migration.log | tail -30
        MYSQL_RESULT="FAILED"
    fi
fi
echo ""

# Stop MySQL
docker stop meshmonitor-mysql-test > /dev/null 2>&1 || true
docker rm meshmonitor-mysql-test > /dev/null 2>&1 || true

# Summary
echo "=========================================="
echo "Database Migration Test Results"
echo "=========================================="
echo ""

if [ "$POSTGRES_RESULT" = "PASSED" ]; then
    echo -e "PostgreSQL Migration: ${GREEN}✓ PASSED${NC}"
else
    echo -e "PostgreSQL Migration: ${RED}✗ FAILED${NC}"
fi

if [ "$MYSQL_RESULT" = "PASSED" ]; then
    echo -e "MySQL Migration:      ${GREEN}✓ PASSED${NC}"
else
    echo -e "MySQL Migration:      ${RED}✗ FAILED${NC}"
fi

echo ""

# Exit with failure if any test failed
if [ "$POSTGRES_RESULT" != "PASSED" ] || [ "$MYSQL_RESULT" != "PASSED" ]; then
    echo -e "${RED}=========================================="
    echo "✗ DATABASE MIGRATION TESTS FAILED"
    echo "==========================================${NC}"
    exit 1
fi

echo -e "${GREEN}=========================================="
echo "✓ ALL DATABASE MIGRATION TESTS PASSED"
echo "==========================================${NC}"
echo ""
echo "The database migration tests completed successfully:"
echo "  • SQLite → PostgreSQL migration verified"
echo "  • SQLite → MySQL migration verified"
echo "  • Data integrity confirmed for both targets"
echo ""
