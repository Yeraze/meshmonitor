#!/bin/bash
# Clean the dev container environment (remove container and volumes)
# Usage: ./clean.sh
# Handles: VS Code devcontainers, manually spawned compose containers, and name-based matches

# Get the directory where this script is located
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

echo "Cleaning dev container environment..."

# Method 1: Docker Compose (manual spawns)
echo "Checking for docker-compose managed containers..."
docker compose -f "${SCRIPT_DIR}/../docker-compose.yml" down -v 2>/dev/null && echo "✓ Compose-managed containers cleaned"

# Method 2: VS Code devcontainers (by label)
echo "Checking for VS Code devcontainers..."
VSCODE_CONTAINERS=$(docker ps -aq --filter "label=devcontainer.local_folder")
if [ -n "$VSCODE_CONTAINERS" ]; then
    echo "Found VS Code devcontainer(s): $VSCODE_CONTAINERS"
    docker stop $VSCODE_CONTAINERS 2>/dev/null
    docker rm $VSCODE_CONTAINERS 2>/dev/null
    echo "✓ VS Code containers removed"
fi

# Method 3: Name-based match (catches any meshmonitor_devcontainer*)
echo "Checking for containers by name pattern..."
NAME_CONTAINERS=$(docker ps -aq --filter "name=meshmonitor_devcontainer")
if [ -n "$NAME_CONTAINERS" ]; then
    echo "Found container(s) by name: $NAME_CONTAINERS"
    docker stop $NAME_CONTAINERS 2>/dev/null
    docker rm $NAME_CONTAINERS 2>/dev/null
    echo "✓ Named containers removed"
fi

# Remove volumes (runtime data)
echo "Removing devcontainer volumes..."
REMOVED_VOLUMES=0

# Method 1: By compose label
COMPOSE_VOLUMES=$(docker volume ls -q --filter "label=com.docker.compose.project=meshmonitor_devcontainer")
if [ -n "$COMPOSE_VOLUMES" ]; then
    # Remove volumes individually to avoid pipeline failures
    while IFS= read -r vol; do
        if docker volume rm "$vol" 2>/dev/null; then
            REMOVED_VOLUMES=$((REMOVED_VOLUMES + 1))
        else
            echo "Warning: Failed to remove volume $vol (may be in use)"
        fi
    done <<< "$COMPOSE_VOLUMES"
fi

# Method 2: By name pattern
NAME_VOLUMES=$(docker volume ls -q --filter "name=meshmonitor_devcontainer")
if [ -n "$NAME_VOLUMES" ]; then
    while IFS= read -r vol; do
        if docker volume rm "$vol" 2>/dev/null; then
            REMOVED_VOLUMES=$((REMOVED_VOLUMES + 1))
        else
            echo "Warning: Failed to remove volume $vol (may be in use)"
        fi
    done <<< "$NAME_VOLUMES"
fi

if [ $REMOVED_VOLUMES -gt 0 ]; then
    echo "✓ Removed $REMOVED_VOLUMES volume(s)"
else
    echo "No volumes to remove"
fi

# Optional: Remove images (saves disk space, but requires rebuild)
if [ "$CLEAN_IMAGES" = "true" ]; then
    echo ""
    echo "Removing devcontainer images..."
    IMAGES=$(docker images --filter "reference=*meshmonitor*devcontainer*" -q)
    if [ -n "$IMAGES" ]; then
        echo "$IMAGES" | xargs docker rmi -f 2>/dev/null
        echo "✓ Images removed (run 'Rebuild Container' to recreate)"
    else
        echo "No devcontainer images found"
    fi
fi

echo ""
echo "✓ Environment cleaned successfully!"
echo ""
echo "Tip: To also remove images, run: CLEAN_IMAGES=true ./clean.sh"
