#!/bin/bash
# System Backup & Restore Test
# Tests system backup creation and restoration to a new container

set -e  # Exit on any error

echo "=========================================="
echo "System Backup & Restore Test"
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
SOURCE_COMPOSE_FILE="docker-compose.backup-source-test.yml"
SOURCE_CONTAINER="meshmonitor-backup-source-test"
SOURCE_PORT="8082"
RESTORE_COMPOSE_FILE="docker-compose.restore-test.yml"
RESTORE_CONTAINER="meshmonitor-restore-test"
RESTORE_PORT="8083"
BACKUP_DIRNAME=""

# Cleanup function
cleanup_backup_restore_test() {
    echo ""
    echo -e "${BLUE}Cleaning up backup/restore test artifacts...${NC}"

    # Stop and remove containers
    docker compose -f "$SOURCE_COMPOSE_FILE" down -v 2>/dev/null || true
    docker compose -f "$RESTORE_COMPOSE_FILE" down -v 2>/dev/null || true

    # Remove compose files
    rm -f "$SOURCE_COMPOSE_FILE" 2>/dev/null || true
    rm -f "$RESTORE_COMPOSE_FILE" 2>/dev/null || true

    # Remove temp files
    rm -f /tmp/meshmonitor-backup-test-cookies.txt 2>/dev/null || true
    rm -f /tmp/meshmonitor-restore-test-cookies.txt 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Cleanup complete"
}

# Set trap for cleanup
trap cleanup_backup_restore_test EXIT

echo "Creating test docker-compose.yml for source container..."
cat > "$SOURCE_COMPOSE_FILE" << EOF
services:
  meshmonitor-backup-source:
    container_name: $SOURCE_CONTAINER
    image: meshmonitor:test
    ports:
      - "$SOURCE_PORT:3001"
    volumes:
      - meshmonitor-backup-source-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_HOST=192.168.1.208
      - LOG_LEVEL=info

volumes:
  meshmonitor-backup-source-test-data:
EOF

echo -e "${GREEN}✓${NC} Source config created"
echo ""

echo "Building container..."
docker compose -f "$SOURCE_COMPOSE_FILE" build --quiet
echo -e "${GREEN}✓${NC} Build complete"
echo ""

echo "Starting source container..."
docker compose -f "$SOURCE_COMPOSE_FILE" up -d
echo -e "${GREEN}✓${NC} Container started"
echo ""

echo "Waiting for container to be ready..."
# Check container is running
if docker ps | grep -q "$SOURCE_CONTAINER"; then
    echo -e "${GREEN}✓ PASS${NC}: Container is running"
else
    echo -e "${RED}✗ FAIL${NC}: Container is not running"
    docker logs "$SOURCE_CONTAINER"
    exit 1
fi

# Wait for API to be ready (poll /api/poll endpoint)
echo "Waiting for API to be ready..."
COUNTER=0
MAX_WAIT=60
API_READY=false
while [ $COUNTER -lt $MAX_WAIT ]; do
    POLL_RESPONSE=$(curl -s "http://localhost:$SOURCE_PORT/api/poll" 2>/dev/null || echo "{}")
    # Check if we got valid JSON with a "connection" field
    if echo "$POLL_RESPONSE" | grep -q '"connection"'; then
        API_READY=true
        echo -e "${GREEN}✓ PASS${NC}: API is ready"
        break
    fi
    COUNTER=$((COUNTER + 1))
    if [ $COUNTER -eq $MAX_WAIT ]; then
        echo -e "${RED}✗ FAIL${NC}: API did not become ready within $MAX_WAIT seconds"
        echo "Container logs:"
        docker logs "$SOURCE_CONTAINER" 2>&1 | tail -30
        exit 1
    fi
    sleep 1
done
echo ""

echo "Waiting for Meshtastic node connection (optional)..."
# Wait for node to connect (max 30 seconds)
COUNTER=0
MAX_WAIT=30
NODE_CONNECTED=false
while [ $COUNTER -lt $MAX_WAIT ]; do
    RESPONSE=$(curl -s "http://localhost:$SOURCE_PORT/api/poll" 2>/dev/null || echo "{}")
    CHANNEL_COUNT=$(echo "$RESPONSE" | grep -o '"channels":\[' | wc -l)
    NODE_COUNT=$(echo "$RESPONSE" | grep -o '"nodeId":"' | wc -l)

    if [ "$CHANNEL_COUNT" -ge 1 ] && [ "$NODE_COUNT" -ge 1 ]; then
        echo -e "${GREEN}✓ PASS${NC}: Node connected (channels: $CHANNEL_COUNT, nodes: $NODE_COUNT)"
        NODE_CONNECTED=true
        break
    fi

    COUNTER=$((COUNTER + 1))
    if [ $COUNTER -eq $MAX_WAIT ]; then
        echo -e "${YELLOW}⚠ WARN${NC}: No Meshtastic node connected - testing with minimal data"
        echo "This is acceptable - backup/restore will be tested with admin user and settings only"
        break
    fi
    sleep 1
done
echo ""

echo "Getting CSRF token..."
CSRF_TOKEN=$(curl -s -c /tmp/meshmonitor-backup-test-cookies.txt \
    "http://localhost:$SOURCE_PORT/api/csrf-token" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)

if [ -z "$CSRF_TOKEN" ]; then
    echo -e "${RED}✗ FAIL${NC}: Failed to get CSRF token"
    exit 1
fi
echo -e "${GREEN}✓ PASS${NC}: CSRF token obtained"
echo ""

# Test if login endpoint is available
echo "Testing /api/auth/login endpoint availability..."
TEST_RESPONSE=$(curl -s -X POST "http://localhost:$SOURCE_PORT/api/auth/login" -H "Content-Type: application/json" -d '{}' 2>&1)
if echo "$TEST_RESPONSE" | grep -qi "Cannot POST"; then
    echo -e "${RED}✗ FAIL${NC}: /api/auth/login endpoint not available"
    echo "Container logs:"
    docker logs "$SOURCE_CONTAINER" 2>&1 | grep -i "listening\|error\|route" | tail -30
    exit 1
fi
echo "Login endpoint is available"
echo ""

echo "Logging in..."
LOGIN_RESPONSE=$(curl -s -b /tmp/meshmonitor-backup-test-cookies.txt \
    -c /tmp/meshmonitor-backup-test-cookies.txt \
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
echo ""

echo "Collecting baseline data..."
# Get baseline node count
NODE_RESPONSE=$(curl -s -b /tmp/meshmonitor-backup-test-cookies.txt \
    "http://localhost:$SOURCE_PORT/api/nodes")
NODE_COUNT=$(echo "$NODE_RESPONSE" | grep -o '"nodeId"' | wc -l)

# Get baseline message count
MESSAGE_RESPONSE=$(curl -s -b /tmp/meshmonitor-backup-test-cookies.txt \
    "http://localhost:$SOURCE_PORT/api/messages")
MESSAGE_COUNT=$(echo "$MESSAGE_RESPONSE" | grep -o '"id":' | wc -l)

echo "  - Nodes: $NODE_COUNT"
echo "  - Messages: $MESSAGE_COUNT"
echo -e "${GREEN}✓ PASS${NC}: Baseline data collected"
echo ""

echo "Creating system backup..."
BACKUP_RESPONSE=$(curl -s -b /tmp/meshmonitor-backup-test-cookies.txt \
    -X POST "http://localhost:$SOURCE_PORT/api/system/backup" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $CSRF_TOKEN")

if ! echo "$BACKUP_RESPONSE" | grep -q "dirname"; then
    echo -e "${RED}✗ FAIL${NC}: Failed to create system backup"
    echo "Response: $BACKUP_RESPONSE"
    exit 1
fi

BACKUP_DIRNAME=$(echo "$BACKUP_RESPONSE" | grep -o '"dirname":"[^"]*' | cut -d'"' -f4)
echo -e "${GREEN}✓ PASS${NC}: System backup created: $BACKUP_DIRNAME"
echo ""

echo "Verifying backup was created..."
BACKUP_LIST=$(curl -s -b /tmp/meshmonitor-backup-test-cookies.txt \
    "http://localhost:$SOURCE_PORT/api/system/backup/list")

if ! echo "$BACKUP_LIST" | grep -q "$BACKUP_DIRNAME"; then
    echo -e "${RED}✗ FAIL${NC}: Backup not found in list"
    exit 1
fi
echo -e "${GREEN}✓ PASS${NC}: Backup appears in backup list"
echo ""

echo "Creating test docker-compose.yml for restore container..."
cat > "$RESTORE_COMPOSE_FILE" << EOF
services:
  meshmonitor-restore:
    container_name: $RESTORE_CONTAINER
    image: meshmonitor:test
    ports:
      - "$RESTORE_PORT:3001"
    volumes:
      - meshmonitor-backup-source-test-data:/source-data:ro
      - meshmonitor-restore-test-data:/data
    environment:
      - NODE_ENV=production
      - MESHTASTIC_HOST=192.168.1.208
      - RESTORE_FROM_BACKUP=$BACKUP_DIRNAME
      - LOG_LEVEL=debug
    # Copy backup before starting
    entrypoint: >
      sh -c "mkdir -p /data/system-backups &&
             cp -r /source-data/system-backups/$BACKUP_DIRNAME /data/system-backups/ &&
             exec /usr/local/bin/docker-entrypoint.sh /usr/bin/supervisord -c /etc/supervisord.conf"

volumes:
  meshmonitor-backup-source-test-data:
    name: meshmonitor_meshmonitor-backup-source-test-data
    external: true
  meshmonitor-restore-test-data:
EOF

echo -e "${GREEN}✓${NC} Restore config created"
echo ""

echo "Starting restore container..."
docker compose -f "$RESTORE_COMPOSE_FILE" up -d
echo -e "${GREEN}✓${NC} Restore container started"
echo ""

echo "Waiting for restore to complete..."
# Wait for restore container to be ready (max 90 seconds)
COUNTER=0
MAX_WAIT=90
while [ $COUNTER -lt $MAX_WAIT ]; do
    if curl -s -f "http://localhost:$RESTORE_PORT/api/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PASS${NC}: Restore container is ready"
        sleep 3
        break
    fi
    COUNTER=$((COUNTER + 1))
    if [ $COUNTER -eq $MAX_WAIT ]; then
        echo -e "${RED}✗ FAIL${NC}: Restore container did not become ready"
        echo "Container logs:"
        docker logs "$RESTORE_CONTAINER" 2>&1 | tail -50
        exit 1
    fi
    sleep 1
done
echo ""

echo "Verifying restore completed successfully..."
RESTORE_LOGS=$(docker logs "$RESTORE_CONTAINER" 2>&1)

if echo "$RESTORE_LOGS" | grep -qi "restore.*completed.*successfully\|restore.*success"; then
    echo -e "${GREEN}✓ PASS${NC}: Restore completed successfully (confirmed in logs)"
elif echo "$RESTORE_LOGS" | grep -qi "RESTORE_FROM_BACKUP.*not found\|backup.*not found"; then
    echo -e "${RED}✗ FAIL${NC}: Backup not found during restore"
    echo "Relevant logs:"
    echo "$RESTORE_LOGS" | grep -i "restore\|backup" | tail -20
    exit 1
elif echo "$RESTORE_LOGS" | grep -qi "restore.*failed\|restore.*error"; then
    echo -e "${RED}✗ FAIL${NC}: Restore failed"
    echo "Relevant logs:"
    echo "$RESTORE_LOGS" | grep -i "restore\|error" | tail -20
    exit 1
else
    echo -e "${YELLOW}⚠ WARN${NC}: Could not confirm restore status from logs, continuing with verification..."
fi
echo ""

echo "Logging in to restored container..."
RESTORE_CSRF_TOKEN=$(curl -s -c /tmp/meshmonitor-restore-test-cookies.txt \
    "http://localhost:$RESTORE_PORT/api/csrf-token" | grep -o '"csrfToken":"[^"]*' | cut -d'"' -f4)

RESTORE_LOGIN_RESPONSE=$(curl -s -b /tmp/meshmonitor-restore-test-cookies.txt \
    -c /tmp/meshmonitor-restore-test-cookies.txt \
    -X POST "http://localhost:$RESTORE_PORT/api/auth/login" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $RESTORE_CSRF_TOKEN" \
    -d '{"username":"admin","password":"changeme"}')

if ! echo "$RESTORE_LOGIN_RESPONSE" | grep -q "success"; then
    echo -e "${RED}✗ FAIL${NC}: Login to restored container failed"
    echo "Response: $RESTORE_LOGIN_RESPONSE"
    exit 1
fi
echo -e "${GREEN}✓ PASS${NC}: Logged in to restored container"
echo ""

echo "Verifying data integrity..."
# Verify node count
RESTORED_NODE_RESPONSE=$(curl -s -b /tmp/meshmonitor-restore-test-cookies.txt \
    "http://localhost:$RESTORE_PORT/api/nodes")
RESTORED_NODE_COUNT=$(echo "$RESTORED_NODE_RESPONSE" | grep -o '"nodeId"' | wc -l)

if [ "$RESTORED_NODE_COUNT" -eq "$NODE_COUNT" ]; then
    if [ "$NODE_COUNT" -eq 0 ]; then
        echo -e "${GREEN}✓ PASS${NC}: Node count matches (0 nodes - no Meshtastic connection)"
    else
        echo -e "${GREEN}✓ PASS${NC}: Node count matches: $RESTORED_NODE_COUNT = $NODE_COUNT"
    fi
else
    echo -e "${RED}✗ FAIL${NC}: Node count mismatch: restored=$RESTORED_NODE_COUNT, expected=$NODE_COUNT"
    exit 1
fi

# Verify message count
RESTORED_MESSAGE_RESPONSE=$(curl -s -b /tmp/meshmonitor-restore-test-cookies.txt \
    "http://localhost:$RESTORE_PORT/api/messages")
RESTORED_MESSAGE_COUNT=$(echo "$RESTORED_MESSAGE_RESPONSE" | grep -o '"id":' | wc -l)

if [ "$RESTORED_MESSAGE_COUNT" -eq "$MESSAGE_COUNT" ]; then
    if [ "$MESSAGE_COUNT" -eq 0 ]; then
        echo -e "${GREEN}✓ PASS${NC}: Message count matches (0 messages - no Meshtastic connection)"
    else
        echo -e "${GREEN}✓ PASS${NC}: Message count matches: $RESTORED_MESSAGE_COUNT = $MESSAGE_COUNT"
    fi
else
    echo -e "${RED}✗ FAIL${NC}: Message count mismatch: restored=$RESTORED_MESSAGE_COUNT, expected=$MESSAGE_COUNT"
    exit 1
fi

# Verify audit log contains restore event
AUDIT_LOGS=$(curl -s -b /tmp/meshmonitor-restore-test-cookies.txt \
    "http://localhost:$RESTORE_PORT/api/audit-log")

if echo "$AUDIT_LOGS" | grep -q "system_restore_completed"; then
    echo -e "${GREEN}✓ PASS${NC}: Restore event found in audit log"
else
    echo -e "${YELLOW}⚠ WARN${NC}: Restore event not found in audit log (non-critical)"
fi
echo ""

echo "Verifying source container is unaffected..."
SOURCE_NODE_COUNT_AFTER=$(curl -s -b /tmp/meshmonitor-backup-test-cookies.txt \
    "http://localhost:$SOURCE_PORT/api/nodes" | grep -o '"nodeId"' | wc -l)

if [ "$SOURCE_NODE_COUNT_AFTER" -eq "$NODE_COUNT" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Source container node count unchanged: $SOURCE_NODE_COUNT_AFTER"
else
    echo -e "${RED}✗ FAIL${NC}: Source container node count changed: $SOURCE_NODE_COUNT_AFTER (was $NODE_COUNT)"
    exit 1
fi
echo ""

echo "=========================================="
echo -e "${GREEN}All tests passed!${NC}"
echo "=========================================="
echo ""
echo "The System Backup & Restore test completed successfully:"
if [ "$NODE_COUNT" -eq 0 ]; then
    echo "  • Tested with minimal data (no Meshtastic node connected)"
    echo "  • Verified backup/restore functionality works correctly"
else
    echo "  • Created backup: $BACKUP_DIRNAME"
    echo "  • Restored $NODE_COUNT nodes"
    echo "  • Restored $MESSAGE_COUNT messages"
fi
echo "  • Source container unaffected"
echo "  • Data integrity verified"
echo ""
