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

    # Remove any temporary compose files
    rm -f docker-compose.quick-start-test.yml 2>/dev/null || true
    rm -f docker-compose.reverse-proxy-test.yml 2>/dev/null || true

    # Remove cookie files
    rm -f /tmp/meshmonitor-cookies.txt 2>/dev/null || true
    rm -f /tmp/meshmonitor-reverse-proxy-cookies.txt 2>/dev/null || true

    echo -e "${GREEN}✓${NC} Cleanup complete"
}

# Set trap to cleanup on exit
trap cleanup EXIT

echo -e "${BLUE}Step 1: Bootstrap - Building fresh Docker image${NC}"
echo "This ensures tests run against the latest code..."
echo ""

# Build the Docker image
docker build -t meshmonitor:test -f Dockerfile . --quiet

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

echo -e "${GREEN}✓ Test volumes cleaned${NC}"
echo ""

echo "=========================================="
echo -e "${BLUE}Running Quick Start Test${NC}"
echo "=========================================="
echo ""

# Run Quick Start test
if bash "$SCRIPT_DIR/test-quick-start.sh"; then
    QUICKSTART_RESULT="PASSED"
    echo ""
    echo -e "${GREEN}✓ Quick Start test PASSED${NC}"
else
    QUICKSTART_RESULT="FAILED"
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

# Summary
echo "=========================================="
echo "System Test Results"
echo "=========================================="
echo ""

if [ "$QUICKSTART_RESULT" = "PASSED" ]; then
    echo -e "Quick Start Test:         ${GREEN}✓ PASSED${NC}"
else
    echo -e "Quick Start Test:         ${RED}✗ FAILED${NC}"
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

echo ""

# Overall result
if [ "$QUICKSTART_RESULT" = "PASSED" ] && [ "$REVERSE_PROXY_RESULT" = "PASSED" ] && [ "$OIDC_RESULT" = "PASSED" ]; then
    echo -e "${GREEN}=========================================="
    echo "✓ ALL SYSTEM TESTS PASSED"
    echo "==========================================${NC}"
    echo ""
    echo "Your deployment configurations are working correctly!"
    echo "Ready to create or update PR."
    exit 0
else
    echo -e "${RED}=========================================="
    echo "✗ SYSTEM TESTS FAILED"
    echo "==========================================${NC}"
    echo ""
    echo "Please fix failing tests before creating/updating PR."
    exit 1
fi
