#!/bin/sh
set -e

# ============================================================================
# Permission Check and Auto-Fix
# ============================================================================
# The container runs as UID 1000 (node user). On some systems (like unRAID),
# the /data volume may have different ownership, causing permission errors.
# This section checks and attempts to fix permissions automatically.

echo "Checking /data directory permissions..."

# Test if we can write to /data as the node user
if ! su-exec node:node test -w /data 2>/dev/null; then
    echo "⚠️  WARNING: /data is not writable by node user (UID 1000)"
    echo "Attempting to fix permissions automatically..."

    # Attempt to fix ownership (we're running as root at this point)
    if chown -R node:node /data 2>/dev/null; then
        echo "✓ Successfully fixed /data permissions (set to node:node)"
        echo "  Container should now start normally"
    else
        echo ""
        echo "═══════════════════════════════════════════════════════════"
        echo "❌ ERROR: Cannot fix /data directory permissions"
        echo "═══════════════════════════════════════════════════════════"
        echo ""
        echo "The container needs write access to /data but cannot change"
        echo "the ownership automatically."
        echo ""
        echo "To fix this, run ONE of these commands:"
        echo ""
        echo "Option 1 (from host terminal):"
        echo "  chown -R 1000:1000 /mnt/user/appdata/meshmonitor"
        echo ""
        echo "Option 2 (from Docker):"
        echo "  docker exec meshmonitor chown -R node:node /data"
        echo ""
        echo "Then restart the container."
        echo "═══════════════════════════════════════════════════════════"
        echo ""
        exit 1
    fi
else
    echo "✓ /data directory permissions are correct"
fi

# ============================================================================
# Upgrade Watchdog Script Deployment
# ============================================================================
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
