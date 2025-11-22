#!/bin/sh
set -e

# Copy upgrade-related scripts to shared data volume
SCRIPTS_SOURCE_DIR="/app/scripts"
SCRIPTS_DEST_DIR="/data/scripts"
AUDIT_LOG="/data/logs/audit.log"

if [ -d "$SCRIPTS_SOURCE_DIR" ]; then
    echo "Deploying scripts to /data/scripts/..."
    mkdir -p "$SCRIPTS_DEST_DIR" /data/logs

    # Copy upgrade watchdog script
    if [ -f "$SCRIPTS_SOURCE_DIR/upgrade-watchdog.sh" ]; then
        SCRIPT_HASH=$(sha256sum "$SCRIPTS_SOURCE_DIR/upgrade-watchdog.sh" | cut -d' ' -f1 | cut -c1-8)
        cp "$SCRIPTS_SOURCE_DIR/upgrade-watchdog.sh" "$SCRIPTS_DEST_DIR/upgrade-watchdog.sh"
        chmod +x "$SCRIPTS_DEST_DIR/upgrade-watchdog.sh"
        echo "✓ Upgrade watchdog script deployed"

        # Audit log the deployment
        if [ -w "$(dirname "$AUDIT_LOG")" ]; then
            echo "{\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",\"event\":\"upgrade_script_deployed\",\"script_hash\":\"$SCRIPT_HASH\",\"version\":\"${npm_package_version:-unknown}\",\"user\":\"system\"}" >> "$AUDIT_LOG" 2>/dev/null || true
        fi
    fi

    # Copy Docker socket test script
    if [ -f "$SCRIPTS_SOURCE_DIR/test-docker-socket.sh" ]; then
        cp "$SCRIPTS_SOURCE_DIR/test-docker-socket.sh" "$SCRIPTS_DEST_DIR/test-docker-socket.sh"
        chmod +x "$SCRIPTS_DEST_DIR/test-docker-socket.sh"
        echo "✓ Docker socket test script deployed"
    fi
fi

# Execute the original supervisord command
exec "$@"
