#!/bin/bash
# System Tests - Full deployment verification
# Runs both Quick Start and Reverse Proxy tests with fresh environment

set -e  # Exit on any error

echo "=========================================="
echo "MeshMonitor System Tests"
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

# Cleanup function
cleanup() {
    echo ""
    echo -e "${BLUE}Cleaning up test artifacts...${NC}"

    # Stop and remove test containers and volumes
    docker compose -f docker-compose.quick-start-test.yml down -v 2>/dev/null || true
    docker compose -f docker-compose.reverse-proxy-test.yml down -v 2>/dev/null || true
    docker compose -f docker-compose-config-import-test.yml down -v 2>/dev/null || true
    docker compose -f docker-compose.virtual-node-cli-test.yml down -v 2>/dev/null || true

    # Cleanup backup/restore test artifacts
    docker stop meshmonitor-backup-source-test 2>/dev/null || true
    docker rm meshmonitor-backup-source-test 2>/dev/null || true
    docker stop meshmonitor-restore-test 2>/dev/null || true
    docker rm meshmonitor-restore-test 2>/dev/null || true
    docker volume rm meshmonitor-backup-source-test-data 2>/dev/null || true
    docker volume rm meshmonitor-restore-test-data 2>/dev/null || true

    # Remove any temporary compose files
    rm -f docker-compose.quick-start-test.yml 2>/dev/null || true
    rm -f docker-compose.reverse-proxy-test.yml 2>/dev/null || true
    rm -f docker-compose-config-import-test.yml 2>/dev/null || true
    rm -f docker-compose.virtual-node-cli-test.yml 2>/dev/null || true
    rm -f docker-compose.backup-source-test.yml 2>/dev/null || true
    rm -f docker-compose.restore-test.yml 2>/dev/null || true

    # Remove cookie files
    rm -f /tmp/meshmonitor-cookies.txt 2>/dev/null || true
    rm -f /tmp/meshmonitor-security-cookies.txt 2>/dev/null || true
    rm -f /tmp/meshmonitor-reverse-proxy-cookies.txt 2>/dev/null || true
    rm -f /tmp/meshmonitor-config-import-cookies.txt 2>/dev/null || true
    rm -f /tmp/meshmonitor-backup-test-cookies.txt 2>/dev/null || true
    rm -f /tmp/meshmonitor-restore-test-cookies.txt 2>/dev/null || true
    rm -f /tmp/vn-test-client.py 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Cleanup complete"
}

# Set trap to cleanup on exit
trap cleanup EXIT

echo -e "${BLUE}Step 1: Bootstrap - Building fresh Docker image${NC}"
echo "This ensures tests run against the latest code..."
echo ""

# Build the Docker image (with --no-cache to ensure latest code is compiled)
docker build -t meshmonitor:test -f Dockerfile . --no-cache --quiet

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Build successful${NC}"
else
    echo -e "${RED}✗ Build failed${NC}"
    exit 1
fi
echo ""

echo -e "${BLUE}Step 2: Clean existing test volumes${NC}"
echo "Removing any leftover test data..."
echo ""

# Remove any existing test volumes
docker volume rm meshmonitor_meshmonitor-quick-start-test-data 2>/dev/null || true
docker volume rm meshmonitor_meshmonitor-reverse-proxy-test-data 2>/dev/null || true
docker volume rm meshmonitor_meshmonitor-config-import-test-data 2>/dev/null || true
docker volume rm meshmonitor_meshmonitor-virtual-node-cli-test-data 2>/dev/null || true
docker volume rm meshmonitor_meshmonitor-backup-source-test-data 2>/dev/null || true
docker volume rm meshmonitor_meshmonitor-restore-test-data 2>/dev/null || true
docker volume rm meshmonitor-backup-source-test-data 2>/dev/null || true
docker volume rm meshmonitor-restore-test-data 2>/dev/null || true

echo -e "${GREEN}✓ Test volumes cleaned${NC}"
echo ""

echo "=========================================="
echo -e "${BLUE}Running Configuration Import Test${NC}"
echo "=========================================="
echo ""

# Run Configuration Import test FIRST
# This test imports two different configurations and verifies them
if bash "$SCRIPT_DIR/test-config-import.sh"; then
    CONFIG_IMPORT_RESULT="PASSED"
    echo ""
    echo -e "${GREEN}✓ Configuration Import test PASSED${NC}"
else
    # Check if test was skipped (exit 0 with skip message)
    if [ $? -eq 0 ]; then
        CONFIG_IMPORT_RESULT="SKIPPED"
        echo ""
        echo -e "${YELLOW}⊘ Configuration Import test SKIPPED${NC}"
    else
        CONFIG_IMPORT_RESULT="FAILED"
        echo ""
        echo -e "${RED}✗ Configuration Import test FAILED${NC}"
    fi
fi
echo ""

echo "=========================================="
echo -e "${BLUE}Running Quick Start Test${NC}"
echo "=========================================="
echo ""

# Run Quick Start test (includes security test)
if bash "$SCRIPT_DIR/test-quick-start.sh"; then
    QUICKSTART_RESULT="PASSED"
    SECURITY_RESULT="PASSED"  # Security test is integrated into Quick Start
    echo ""
    echo -e "${GREEN}✓ Quick Start test PASSED (includes security test)${NC}"
else
    QUICKSTART_RESULT="FAILED"
    SECURITY_RESULT="FAILED"
    echo ""
    echo -e "${RED}✗ Quick Start test FAILED${NC}"
fi
echo ""

echo "=========================================="
echo -e "${BLUE}Running Reverse Proxy Test${NC}"
echo "=========================================="
echo ""

# Run Reverse Proxy test
if bash "$SCRIPT_DIR/test-reverse-proxy.sh"; then
    REVERSE_PROXY_RESULT="PASSED"
    echo ""
    echo -e "${GREEN}✓ Reverse Proxy test PASSED${NC}"
else
    REVERSE_PROXY_RESULT="FAILED"
    echo ""
    echo -e "${RED}✗ Reverse Proxy test FAILED${NC}"
fi
echo ""

echo "=========================================="
echo -e "${BLUE}Running Reverse Proxy + OIDC Test${NC}"
echo "=========================================="
echo ""

# Run Reverse Proxy + OIDC test
if bash "$SCRIPT_DIR/test-reverse-proxy-oidc.sh"; then
    OIDC_RESULT="PASSED"
    echo ""
    echo -e "${GREEN}✓ Reverse Proxy + OIDC test PASSED${NC}"
else
    OIDC_RESULT="FAILED"
    echo ""
    echo -e "${RED}✗ Reverse Proxy + OIDC test FAILED${NC}"
fi
echo ""

echo "=========================================="
echo -e "${BLUE}Running Virtual Node CLI Test${NC}"
echo "=========================================="
echo ""

# Run Virtual Node CLI test
if bash "$SCRIPT_DIR/test-virtual-node-cli.sh"; then
    VIRTUAL_NODE_CLI_RESULT="PASSED"
    echo ""
    echo -e "${GREEN}✓ Virtual Node CLI test PASSED${NC}"
else
    VIRTUAL_NODE_CLI_RESULT="FAILED"
    echo ""
    echo -e "${RED}✗ Virtual Node CLI test FAILED${NC}"
fi
echo ""

echo "=========================================="
echo -e "${BLUE}Running System Backup & Restore Test${NC}"
echo "=========================================="
echo ""

# Run System Backup & Restore test
if bash "$SCRIPT_DIR/test-backup-restore.sh"; then
    BACKUP_RESTORE_RESULT="PASSED"
    echo ""
    echo -e "${GREEN}✓ System Backup & Restore test PASSED${NC}"
else
    BACKUP_RESTORE_RESULT="FAILED"
    echo ""
    echo -e "${RED}✗ System Backup & Restore test FAILED${NC}"
fi
echo ""

# Summary
echo "=========================================="
echo "System Test Results"
echo "=========================================="
echo ""

if [ "$CONFIG_IMPORT_RESULT" = "PASSED" ]; then
    echo -e "Configuration Import:     ${GREEN}✓ PASSED${NC}"
elif [ "$CONFIG_IMPORT_RESULT" = "SKIPPED" ]; then
    echo -e "Configuration Import:     ${YELLOW}⊘ SKIPPED${NC}"
else
    echo -e "Configuration Import:     ${RED}✗ FAILED${NC}"
fi

if [ "$QUICKSTART_RESULT" = "PASSED" ]; then
    echo -e "Quick Start Test:         ${GREEN}✓ PASSED${NC}"
else
    echo -e "Quick Start Test:         ${RED}✗ FAILED${NC}"
fi

if [ "$SECURITY_RESULT" = "PASSED" ]; then
    echo -e "Security Test:            ${GREEN}✓ PASSED${NC}"
else
    echo -e "Security Test:            ${RED}✗ FAILED${NC}"
fi

if [ "$REVERSE_PROXY_RESULT" = "PASSED" ]; then
    echo -e "Reverse Proxy Test:       ${GREEN}✓ PASSED${NC}"
else
    echo -e "Reverse Proxy Test:       ${RED}✗ FAILED${NC}"
fi

if [ "$OIDC_RESULT" = "PASSED" ]; then
    echo -e "Reverse Proxy + OIDC:     ${GREEN}✓ PASSED${NC}"
else
    echo -e "Reverse Proxy + OIDC:     ${RED}✗ FAILED${NC}"
fi

if [ "$VIRTUAL_NODE_CLI_RESULT" = "PASSED" ]; then
    echo -e "Virtual Node CLI Test:    ${GREEN}✓ PASSED${NC}"
else
    echo -e "Virtual Node CLI Test:    ${RED}✗ FAILED${NC}"
fi

if [ "$BACKUP_RESTORE_RESULT" = "PASSED" ]; then
    echo -e "Backup & Restore Test:    ${GREEN}✓ PASSED${NC}"
else
    echo -e "Backup & Restore Test:    ${RED}✗ FAILED${NC}"
fi

echo ""

# Generate markdown report
REPORT_FILE="test-results.md"
echo "# MeshMonitor System Test Results" > "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "**Test Run:** $(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "## Test Summary" >> "$REPORT_FILE"
echo "" >> "$REPORT_FILE"
echo "| Test Suite | Result |" >> "$REPORT_FILE"
echo "|------------|--------|" >> "$REPORT_FILE"

if [ "$CONFIG_IMPORT_RESULT" = "PASSED" ]; then
    echo "| Configuration Import | ✅ PASSED |" >> "$REPORT_FILE"
elif [ "$CONFIG_IMPORT_RESULT" = "SKIPPED" ]; then
    echo "| Configuration Import | ⊘ SKIPPED |" >> "$REPORT_FILE"
else
    echo "| Configuration Import | ❌ FAILED |" >> "$REPORT_FILE"
fi

if [ "$QUICKSTART_RESULT" = "PASSED" ]; then
    echo "| Quick Start Test | ✅ PASSED |" >> "$REPORT_FILE"
else
    echo "| Quick Start Test | ❌ FAILED |" >> "$REPORT_FILE"
fi

if [ "$SECURITY_RESULT" = "PASSED" ]; then
    echo "| Security Test | ✅ PASSED |" >> "$REPORT_FILE"
else
    echo "| Security Test | ❌ FAILED |" >> "$REPORT_FILE"
fi

if [ "$REVERSE_PROXY_RESULT" = "PASSED" ]; then
    echo "| Reverse Proxy Test | ✅ PASSED |" >> "$REPORT_FILE"
else
    echo "| Reverse Proxy Test | ❌ FAILED |" >> "$REPORT_FILE"
fi

if [ "$OIDC_RESULT" = "PASSED" ]; then
    echo "| Reverse Proxy + OIDC | ✅ PASSED |" >> "$REPORT_FILE"
else
    echo "| Reverse Proxy + OIDC | ❌ FAILED |" >> "$REPORT_FILE"
fi

if [ "$VIRTUAL_NODE_CLI_RESULT" = "PASSED" ]; then
    echo "| Virtual Node CLI Test | ✅ PASSED |" >> "$REPORT_FILE"
else
    echo "| Virtual Node CLI Test | ❌ FAILED |" >> "$REPORT_FILE"
fi

if [ "$BACKUP_RESTORE_RESULT" = "PASSED" ]; then
    echo "| Backup & Restore Test | ✅ PASSED |" >> "$REPORT_FILE"
else
    echo "| Backup & Restore Test | ❌ FAILED |" >> "$REPORT_FILE"
fi

echo "" >> "$REPORT_FILE"

# Overall result (config import is optional, so only fail if it actually failed, not if skipped)
REQUIRED_TESTS_PASSED=true
if [ "$QUICKSTART_RESULT" != "PASSED" ] || [ "$SECURITY_RESULT" != "PASSED" ] || [ "$REVERSE_PROXY_RESULT" != "PASSED" ] || [ "$OIDC_RESULT" != "PASSED" ] || [ "$VIRTUAL_NODE_CLI_RESULT" != "PASSED" ] || [ "$BACKUP_RESTORE_RESULT" != "PASSED" ]; then
    REQUIRED_TESTS_PASSED=false
fi

if [ "$CONFIG_IMPORT_RESULT" = "FAILED" ]; then
    REQUIRED_TESTS_PASSED=false
fi

if [ "$REQUIRED_TESTS_PASSED" = true ]; then
    echo "## ✅ Overall Result: PASSED" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "All deployment configurations are working correctly!" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "### Test Details" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "**Configuration Import:**" >> "$REPORT_FILE"
    echo "- Tests configuration import and device reboot cycle" >> "$REPORT_FILE"
    echo "- Verifies channel roles, PSKs, and LoRa configuration" >> "$REPORT_FILE"
    echo "- Note: Channel name verification skipped due to architectural limitation" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "**Quick Start Test:**" >> "$REPORT_FILE"
    echo "- Zero-config deployment (no SESSION_SECRET or COOKIE_SECURE required)" >> "$REPORT_FILE"
    echo "- HTTP access without HSTS" >> "$REPORT_FILE"
    echo "- Auto-generated admin user with default credentials" >> "$REPORT_FILE"
    echo "- Session cookies work over HTTP" >> "$REPORT_FILE"
    echo "- Meshtastic node connection and message exchange verified" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "**Security Test:**" >> "$REPORT_FILE"
    echo "- Verifies Node IP address hidden from anonymous users in API responses" >> "$REPORT_FILE"
    echo "- Verifies MQTT configuration hidden from anonymous users" >> "$REPORT_FILE"
    echo "- Verifies Node IP address visible to authenticated users" >> "$REPORT_FILE"
    echo "- Verifies MQTT configuration visible to authenticated users" >> "$REPORT_FILE"
    echo "- Verifies protected endpoints require authentication" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "**Reverse Proxy Test:**" >> "$REPORT_FILE"
    echo "- Production deployment with COOKIE_SECURE=true" >> "$REPORT_FILE"
    echo "- HTTPS-ready configuration" >> "$REPORT_FILE"
    echo "- Trust proxy enabled for reverse proxy compatibility" >> "$REPORT_FILE"
    echo "- CORS configured for HTTPS domain" >> "$REPORT_FILE"
    echo "- Meshtastic node connection and message exchange verified" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "**Reverse Proxy + OIDC Test:**" >> "$REPORT_FILE"
    echo "- OIDC authentication integration" >> "$REPORT_FILE"
    echo "- Mock OIDC provider health checks" >> "$REPORT_FILE"
    echo "- Authorization flow and session creation" >> "$REPORT_FILE"
    echo "- Hybrid mode (OIDC + local auth)" >> "$REPORT_FILE"
    echo "- Meshtastic node connection verified" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "**Virtual Node CLI Test:**" >> "$REPORT_FILE"
    echo "- Virtual Node Server enabled on TCP port 4404" >> "$REPORT_FILE"
    echo "- Meshtastic Python client successfully connects" >> "$REPORT_FILE"
    echo "- Node data download and synchronization verified" >> "$REPORT_FILE"
    echo "- Test message sent on gauntlet channel (index 3)" >> "$REPORT_FILE"
    echo "- Message delivery confirmed via Web UI API" >> "$REPORT_FILE"
    echo "- Virtual Node Server connection logging verified" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "**Backup & Restore Test:**" >> "$REPORT_FILE"
    echo "- System backup created from running dev container" >> "$REPORT_FILE"
    echo "- New container spun up with RESTORE_FROM_BACKUP env var" >> "$REPORT_FILE"
    echo "- Data integrity verified (node count, message count, settings)" >> "$REPORT_FILE"
    echo "- Restore event logged in audit log" >> "$REPORT_FILE"
    echo "- Dev container unaffected by restore test" >> "$REPORT_FILE"

    echo -e "${GREEN}=========================================="
    echo "✓ ALL SYSTEM TESTS PASSED"
    echo "==========================================${NC}"
    echo ""
    echo "Your deployment configurations are working correctly!"
    echo "Ready to create or update PR."
    echo ""
    echo "Markdown report generated: $REPORT_FILE"
    exit 0
else
    echo "## ❌ Overall Result: FAILED" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "Some tests failed. Please review the failures above and fix before creating/updating PR." >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"
    echo "### Failed Tests" >> "$REPORT_FILE"
    echo "" >> "$REPORT_FILE"

    if [ "$CONFIG_IMPORT_RESULT" = "FAILED" ]; then
        echo "- **Configuration Import:** Failed to import and verify device configuration" >> "$REPORT_FILE"
    fi
    if [ "$QUICKSTART_RESULT" != "PASSED" ]; then
        echo "- **Quick Start Test:** Zero-config deployment test failed" >> "$REPORT_FILE"
    fi
    if [ "$SECURITY_RESULT" != "PASSED" ]; then
        echo "- **Security Test:** API endpoint security test failed" >> "$REPORT_FILE"
    fi
    if [ "$REVERSE_PROXY_RESULT" != "PASSED" ]; then
        echo "- **Reverse Proxy Test:** Production HTTPS deployment test failed" >> "$REPORT_FILE"
    fi
    if [ "$OIDC_RESULT" != "PASSED" ]; then
        echo "- **Reverse Proxy + OIDC:** OIDC authentication integration test failed" >> "$REPORT_FILE"
    fi
    if [ "$VIRTUAL_NODE_CLI_RESULT" != "PASSED" ]; then
        echo "- **Virtual Node CLI Test:** Virtual Node Server CLI integration test failed" >> "$REPORT_FILE"
    fi
    if [ "$BACKUP_RESTORE_RESULT" != "PASSED" ]; then
        echo "- **Backup & Restore Test:** System backup and restore verification test failed" >> "$REPORT_FILE"
    fi

    echo -e "${RED}=========================================="
    echo "✗ SYSTEM TESTS FAILED"
    echo "==========================================${NC}"
    echo ""
    echo "Please fix failing tests before creating/updating PR."
    echo ""
    echo "Markdown report generated: $REPORT_FILE"
    exit 1
fi
