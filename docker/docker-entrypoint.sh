#!/bin/sh
set -e

# Copy upgrade watchdog script to shared data volume if it doesn't exist or needs updating
SCRIPT_SOURCE="/app/scripts/upgrade-watchdog.sh"
SCRIPT_DEST="/data/scripts/upgrade-watchdog.sh"
AUDIT_LOG="/data/logs/audit.log"

if [ -f "$SCRIPT_SOURCE" ]; then
    echo "Deploying upgrade watchdog script to /data/scripts/..."
    mkdir -p /data/scripts /data/logs

    # Get script version/hash for audit trail
    SCRIPT_HASH=$(sha256sum "$SCRIPT_SOURCE" | cut -d' ' -f1 | cut -c1-8)

    cp "$SCRIPT_SOURCE" "$SCRIPT_DEST"
    chmod +x "$SCRIPT_DEST"
    echo "✓ Upgrade watchdog script deployed"

    # Audit log the deployment
    if [ -w "$(dirname "$AUDIT_LOG")" ]; then
        echo "{\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",\"event\":\"upgrade_script_deployed\",\"script_hash\":\"$SCRIPT_HASH\",\"version\":\"${npm_package_version:-unknown}\",\"user\":\"system\"}" >> "$AUDIT_LOG" 2>/dev/null || true
    fi
fi

# Execute the original supervisord command
exec "$@"
