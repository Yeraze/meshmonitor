#!/bin/bash
# Dev Mode Test Wrapper
# Runs system tests against your currently running development environment
# Usage: ./tests/dev-test.sh [URL]
# Example: ./tests/dev-test.sh http://localhost:3001

set -e

# Default to local backend port
TARGET_URL="${1:-http://localhost:3001}"

echo "=========================================="
echo "Dev Mode System Tests"
echo "=========================================="
echo "Target: $TARGET_URL"
echo ""

# Export environment variables for test scripts
export TEST_EXTERNAL_APP_URL="$TARGET_URL"
export KEEP_ALIVE=true

# Get script directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Run Quick Start Test (API & Basic Auth)
echo "Running Quick Start Test against dev environment..."
bash "$SCRIPT_DIR/test-quick-start.sh"

echo ""
echo "=========================================="
echo "Dev Mode Tests Complete"
echo "=========================================="
