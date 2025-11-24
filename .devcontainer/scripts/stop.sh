#!/bin/bash
# Stop the dev container
# Usage: ./stop.sh
# Handles: VS Code devcontainers, manually spawned compose containers, and name-based matches

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Stopping dev container..."

# Method 1: Docker Compose (manual spawns)
docker compose -f "${SCRIPT_DIR}/../docker-compose.yml" stop 2>/dev/null && echo "✓ Compose-managed containers stopped"

# Method 2: VS Code devcontainers (by label)
VSCODE_CONTAINERS=$(docker ps -q --filter "label=devcontainer.local_folder")
if [ -n "$VSCODE_CONTAINERS" ]; then
    echo "Found VS Code devcontainer: $VSCODE_CONTAINERS"
    docker stop $VSCODE_CONTAINERS
    echo "✓ VS Code container stopped"
fi

# Method 3: Name-based match (catches any meshmonitor_devcontainer*)
NAME_CONTAINERS=$(docker ps -q --filter "name=meshmonitor_devcontainer")
if [ -n "$NAME_CONTAINERS" ]; then
    echo "Found container by name: $NAME_CONTAINERS"
    docker stop $NAME_CONTAINERS
    echo "✓ Named container stopped"
fi

echo ""
echo "✓ Container(s) stopped successfully!"
