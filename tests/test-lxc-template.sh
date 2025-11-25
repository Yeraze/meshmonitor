#!/bin/bash
#
# LXC Template Validation Test Script
# Tests the LXC template structure and configuration
#
# Usage: ./test-lxc-template.sh [template-file]
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_TOTAL=0

# Test results
RESULTS=()

# Function to print test result
test_result() {
    local test_name="$1"
    local result="$2"
    local message="$3"

    TESTS_TOTAL=$((TESTS_TOTAL + 1))

    if [ "$result" = "PASS" ]; then
        TESTS_PASSED=$((TESTS_PASSED + 1))
        echo -e "${GREEN}✓${NC} $test_name"
        RESULTS+=("PASS: $test_name")
    elif [ "$result" = "FAIL" ]; then
        TESTS_FAILED=$((TESTS_FAILED + 1))
        echo -e "${RED}✗${NC} $test_name"
        echo -e "  ${RED}Error:${NC} $message"
        RESULTS+=("FAIL: $test_name - $message")
    elif [ "$result" = "WARN" ]; then
        echo -e "${YELLOW}⚠${NC} $test_name"
        echo -e "  ${YELLOW}Warning:${NC} $message"
        RESULTS+=("WARN: $test_name - $message")
    fi
}

# Function to check if file exists in template
check_file_exists() {
    local file_path="$1"
    local temp_dir="$2"

    if [ -f "$temp_dir/$file_path" ] || [ -d "$temp_dir/$file_path" ]; then
        return 0
    else
        return 1
    fi
}

# Function to check systemd unit syntax
check_systemd_unit() {
    local unit_file="$1"
    local temp_dir="$2"

    if ! command -v systemd-analyze &> /dev/null; then
        return 2  # Skip test
    fi

    # Extract the unit file for testing
    local test_file="/tmp/test-$(basename "$unit_file")"
    cp "$temp_dir/$unit_file" "$test_file"

    if systemd-analyze verify "$test_file" 2>&1 | grep -q "Failed"; then
        rm "$test_file"
        return 1
    fi

    rm "$test_file"
    return 0
}

# Main test function
run_tests() {
    local template_file="$1"

    echo "========================================"
    echo "LXC Template Validation Tests"
    echo "========================================"
    echo "Template: $template_file"
    echo ""

    # Check if template file exists
    if [ ! -f "$template_file" ]; then
        echo -e "${RED}ERROR:${NC} Template file not found: $template_file"
        exit 1
    fi

    # Create temporary directory for extraction
    TEMP_DIR=$(mktemp -d)
    trap "rm -rf $TEMP_DIR" EXIT

    echo "Extracting template..."
    tar xzf "$template_file" -C "$TEMP_DIR"

    echo ""
    echo "Running validation tests..."
    echo ""

    # Test 1: Check for essential system directories
    check_file_exists "opt/meshmonitor" "$TEMP_DIR" && \
        test_result "Application directory exists" "PASS" || \
        test_result "Application directory exists" "FAIL" "/opt/meshmonitor not found"

    # Test 2: Check for data directory
    check_file_exists "data" "$TEMP_DIR" && \
        test_result "Data directory exists" "PASS" || \
        test_result "Data directory exists" "FAIL" "/data not found"

    # Test 3: Check for systemd service units
    check_file_exists "etc/systemd/system/meshmonitor.service" "$TEMP_DIR" && \
        test_result "MeshMonitor service unit exists" "PASS" || \
        test_result "MeshMonitor service unit exists" "FAIL" "systemd unit not found"

    check_file_exists "etc/systemd/system/meshmonitor-apprise.service" "$TEMP_DIR" && \
        test_result "Apprise service unit exists" "PASS" || \
        test_result "Apprise service unit exists" "FAIL" "systemd unit not found"

    # Test 4: Check systemd unit syntax (if systemd-analyze available)
    if command -v systemd-analyze &> /dev/null; then
        check_systemd_unit "etc/systemd/system/meshmonitor.service" "$TEMP_DIR"
        case $? in
            0)
                test_result "MeshMonitor service syntax valid" "PASS"
                ;;
            1)
                test_result "MeshMonitor service syntax valid" "FAIL" "systemd-analyze reported errors"
                ;;
            2)
                test_result "MeshMonitor service syntax valid" "WARN" "systemd-analyze not available"
                ;;
        esac

        check_systemd_unit "etc/systemd/system/meshmonitor-apprise.service" "$TEMP_DIR"
        case $? in
            0)
                test_result "Apprise service syntax valid" "PASS"
                ;;
            1)
                test_result "Apprise service syntax valid" "FAIL" "systemd-analyze reported errors"
                ;;
            2)
                test_result "Apprise service syntax valid" "WARN" "systemd-analyze not available"
                ;;
        esac
    else
        test_result "Systemd unit syntax check" "WARN" "systemd-analyze not available, skipping"
    fi

    # Test 5: Check for configuration files
    check_file_exists "etc/meshmonitor/meshmonitor.env.example" "$TEMP_DIR" && \
        test_result "Example environment file exists" "PASS" || \
        test_result "Example environment file exists" "FAIL" "env.example not found"

    # Test 6: Check for required Node.js files
    check_file_exists "opt/meshmonitor/dist" "$TEMP_DIR" && \
        test_result "Built application exists" "PASS" || \
        test_result "Built application exists" "FAIL" "dist/ directory not found"

    check_file_exists "opt/meshmonitor/node_modules" "$TEMP_DIR" && \
        test_result "Node modules exist" "PASS" || \
        test_result "Node modules exist" "FAIL" "node_modules/ not found"

    check_file_exists "opt/meshmonitor/package.json" "$TEMP_DIR" && \
        test_result "Package manifest exists" "PASS" || \
        test_result "Package manifest exists" "FAIL" "package.json not found"

    # Test 7: Check for protobuf files
    check_file_exists "opt/meshmonitor/protobufs/meshtastic/mesh.proto" "$TEMP_DIR" && \
        test_result "Protobuf definitions exist" "PASS" || \
        test_result "Protobuf definitions exist" "FAIL" "protobufs not found"

    # Test 8: Check for Python virtual environment
    check_file_exists "opt/apprise-venv" "$TEMP_DIR" && \
        test_result "Apprise Python venv exists" "PASS" || \
        test_result "Apprise Python venv exists" "FAIL" "/opt/apprise-venv not found"

    check_file_exists "opt/apprise-venv/bin/python" "$TEMP_DIR" && \
        test_result "Python binary in venv" "PASS" || \
        test_result "Python binary in venv" "FAIL" "python not found in venv"

    # Test 9: Check for Apprise API script
    check_file_exists "opt/meshmonitor/docker/apprise-api.py" "$TEMP_DIR" && \
        test_result "Apprise API script exists" "PASS" || \
        test_result "Apprise API script exists" "FAIL" "apprise-api.py not found"

    # Test 10: Check for meshmonitor user
    if [ -f "$TEMP_DIR/etc/passwd" ]; then
        if grep -q "^meshmonitor:" "$TEMP_DIR/etc/passwd"; then
            test_result "meshmonitor user exists" "PASS"
        else
            test_result "meshmonitor user exists" "FAIL" "user not found in /etc/passwd"
        fi
    else
        test_result "meshmonitor user exists" "WARN" "/etc/passwd not found in template"
    fi

    # Test 11: Check file permissions
    if [ -d "$TEMP_DIR/data" ]; then
        DATA_OWNER=$(stat -c '%U' "$TEMP_DIR/data" 2>/dev/null || echo "unknown")
        if [ "$DATA_OWNER" = "meshmonitor" ] || [ "$DATA_OWNER" = "1000" ]; then
            test_result "Data directory ownership" "PASS"
        else
            test_result "Data directory ownership" "WARN" "Owner is $DATA_OWNER (expected meshmonitor or 1000)"
        fi
    fi

    # Test 12: Check for Node.js binary
    if [ -f "$TEMP_DIR/usr/bin/node" ]; then
        test_result "Node.js binary exists" "PASS"
    else
        test_result "Node.js binary exists" "FAIL" "/usr/bin/node not found"
    fi

    # Test 13: Estimate template size
    TEMPLATE_SIZE=$(du -h "$template_file" | cut -f1)
    if [ ${TEMPLATE_SIZE%M} -lt 1000 ] 2>/dev/null; then
        test_result "Template size reasonable" "PASS" "Size: $TEMPLATE_SIZE"
    else
        test_result "Template size reasonable" "WARN" "Size may be large: $TEMPLATE_SIZE"
    fi

    # Test 14: Check for locale configuration
    if [ -f "$TEMP_DIR/etc/locale.gen" ] && grep -q "en_US.UTF-8" "$TEMP_DIR/etc/locale.gen"; then
        test_result "Locale configuration" "PASS"
    else
        test_result "Locale configuration" "WARN" "Locale may not be configured"
    fi

    echo ""
    echo "========================================"
    echo "Test Summary"
    echo "========================================"
    echo "Total tests: $TESTS_TOTAL"
    echo -e "${GREEN}Passed: $TESTS_PASSED${NC}"
    echo -e "${RED}Failed: $TESTS_FAILED${NC}"
    echo ""

    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}All critical tests passed!${NC}"
        echo "Template appears to be valid and ready for deployment."
        return 0
    else
        echo -e "${RED}Some tests failed.${NC}"
        echo "Please review the errors above and rebuild the template."
        return 1
    fi
}

# Script entry point
if [ $# -eq 0 ]; then
    # Try to find template in default location
    DEFAULT_TEMPLATE="lxc/build/meshmonitor-latest-amd64.tar.gz"
    if [ -f "$DEFAULT_TEMPLATE" ]; then
        echo "Using default template: $DEFAULT_TEMPLATE"
        run_tests "$DEFAULT_TEMPLATE"
    else
        echo "Usage: $0 <template-file.tar.gz>"
        echo "Example: $0 lxc/build/meshmonitor-2.19.4-amd64.tar.gz"
        exit 1
    fi
else
    run_tests "$1"
fi

exit $?
