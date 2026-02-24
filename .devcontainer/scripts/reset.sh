#!/bin/bash
# Reset the dev container environment (clean and rebuild)
# Usage: ./reset.sh

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Resetting dev container environment..."

# Run clean script
"${SCRIPT_DIR}/clean.sh"

echo "Rebuilding container image (no cache)..."
docker compose -f "${SCRIPT_DIR}/../docker-compose.yml" build --no-cache

echo "Reset complete. You can now reopen the project in the container."
