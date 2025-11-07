#!/bin/sh
set -e

# Copy upgrade watchdog script to shared data volume if it doesn't exist or needs updating
SCRIPT_SOURCE="/app/scripts/upgrade-watchdog.sh"
SCRIPT_DEST="/data/scripts/upgrade-watchdog.sh"

if [ -f "$SCRIPT_SOURCE" ]; then
    echo "Deploying upgrade watchdog script to /data/scripts/..."
    mkdir -p /data/scripts
    cp "$SCRIPT_SOURCE" "$SCRIPT_DEST"
    chmod +x "$SCRIPT_DEST"
    echo "✓ Upgrade watchdog script deployed"
fi

# Execute the original supervisord command
exec "$@"
