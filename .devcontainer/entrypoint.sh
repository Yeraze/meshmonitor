#!/bin/bash
# Entrypoint script for MeshMonitor DevContainer
# Running as root to ensure all permissions work correctly

set -e

echo "DevContainer entrypoint: Ensuring directories exist..."

# Create common directories if they don't exist
mkdir -p /workspace/node_modules /workspace/dist /workspace/.vite /workspace/.tsc-cache 2>/dev/null || true
mkdir -p /root/.npm /root/.cache 2>/dev/null || true

echo "DevContainer entrypoint: Ready"

# Execute the command
exec "$@"
