#!/bin/sh
set -e

# Check if running as root - needed for PUID/PGID and chown operations
# In Kubernetes with runAsNonRoot, we skip these operations as fsGroup handles permissions
RUNNING_AS_ROOT=false
if [ "$(id -u)" = "0" ]; then
    RUNNING_AS_ROOT=true
fi

# PUID/PGID Support (only when running as root)
# If PUID and/or PGID environment variables are set, modify the node user/group
# to match those IDs. This is useful for NAS systems like Synology where the
# host directory ownership may differ from the default container user.
#
# Note: Alpine Linux doesn't have usermod/groupmod, so we use sed to modify
# /etc/passwd and /etc/group directly. This is the standard approach for Alpine.

PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [ "$RUNNING_AS_ROOT" = "true" ]; then
    # Validate PUID/PGID are numeric and in valid range (0-65534)
    validate_id() {
        local id="$1"
        local name="$2"
        if ! echo "$id" | grep -qE '^[0-9]+$'; then
            echo "ERROR: $name must be a numeric value, got: $id" >&2
            exit 1
        fi
        if [ "$id" -lt 0 ] || [ "$id" -gt 65534 ]; then
            echo "ERROR: $name must be between 0 and 65534, got: $id" >&2
            exit 1
        fi
    }

    validate_id "$PUID" "PUID"
    validate_id "$PGID" "PGID"

    # Get current node user/group IDs
    CURRENT_UID=$(id -u node)
    CURRENT_GID=$(id -g node)

    # Track if we need to update the GID in passwd (only if PGID actually changed)
    NEW_GID="$CURRENT_GID"

    # Only modify group if GID differs from current
    if [ "$PGID" != "$CURRENT_GID" ]; then
        echo "Setting node group GID to $PGID..."
        # Delete existing group with target GID if it exists (and isn't node's group)
        EXISTING_GROUP=$(getent group "$PGID" 2>/dev/null | cut -d: -f1 || true)
        if [ -n "$EXISTING_GROUP" ] && [ "$EXISTING_GROUP" != "node" ]; then
            echo "  Removing conflicting group: $EXISTING_GROUP"
            delgroup "$EXISTING_GROUP" 2>/dev/null || true
        fi
        # Modify node group GID in /etc/group
        sed -i "s/^node:x:$CURRENT_GID:/node:x:$PGID:/" /etc/group
        NEW_GID="$PGID"
    fi

    # Only modify user if UID differs from current
    if [ "$PUID" != "$CURRENT_UID" ]; then
        echo "Setting node user UID to $PUID..."
        # Delete existing user with target UID if it exists (and isn't node)
        EXISTING_USER=$(getent passwd "$PUID" 2>/dev/null | cut -d: -f1 || true)
        if [ -n "$EXISTING_USER" ] && [ "$EXISTING_USER" != "node" ]; then
            echo "  Removing conflicting user: $EXISTING_USER"
            deluser "$EXISTING_USER" 2>/dev/null || true
        fi
        # Modify node user UID and GID in /etc/passwd
        sed -i "s/^node:x:$CURRENT_UID:$CURRENT_GID:/node:x:$PUID:$NEW_GID:/" /etc/passwd
    elif [ "$NEW_GID" != "$CURRENT_GID" ]; then
        # UID unchanged but GID changed - update GID reference in passwd
        sed -i "s/^node:x:$CURRENT_UID:$CURRENT_GID:/node:x:$CURRENT_UID:$NEW_GID:/" /etc/passwd
    fi
else
    echo "Running as non-root (UID $(id -u)), skipping PUID/PGID configuration"
    echo "Kubernetes fsGroup should handle file permissions"
fi

# Copy upgrade-related scripts to internal directory (separate from user scripts)
# User scripts go in /data/scripts (may be bind-mounted)
# Internal MeshMonitor scripts go in /data/.meshmonitor-internal (never bind-mounted)
SCRIPTS_SOURCE_DIR="/app/scripts"
INTERNAL_SCRIPTS_DIR="/data/.meshmonitor-internal"
AUDIT_LOG="/data/logs/audit.log"

# Create directories first (as root), then chown after
# Note: /data/scripts is for USER scripts and may be bind-mounted - we don't create it here
mkdir -p "$INTERNAL_SCRIPTS_DIR" /data/logs /data/apprise-config

# Fix ownership of data directory and app dist
# Only attempt chown if running as root (UID 0)
# In Kubernetes with runAsNonRoot, fsGroup handles permissions instead
if [ "$RUNNING_AS_ROOT" = "true" ]; then
    echo "Setting ownership of /data and /app/dist to node ($PUID:$PGID)..."
    chown -R node:node /data /app/dist
fi

if [ -d "$SCRIPTS_SOURCE_DIR" ]; then
    echo "Deploying internal scripts to $INTERNAL_SCRIPTS_DIR/..."

    # Copy upgrade watchdog script
    if [ -f "$SCRIPTS_SOURCE_DIR/upgrade-watchdog.sh" ]; then
        SCRIPT_HASH=$(sha256sum "$SCRIPTS_SOURCE_DIR/upgrade-watchdog.sh" | cut -d' ' -f1 | cut -c1-8)
        cp "$SCRIPTS_SOURCE_DIR/upgrade-watchdog.sh" "$INTERNAL_SCRIPTS_DIR/upgrade-watchdog.sh"
        chmod +x "$INTERNAL_SCRIPTS_DIR/upgrade-watchdog.sh"
        echo "✓ Upgrade watchdog script deployed"

        # Audit log the deployment
        if [ -w "$(dirname "$AUDIT_LOG")" ]; then
            echo "{\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",\"event\":\"upgrade_script_deployed\",\"script_hash\":\"$SCRIPT_HASH\",\"version\":\"${npm_package_version:-unknown}\",\"user\":\"system\"}" >> "$AUDIT_LOG" 2>/dev/null || true
        fi
    fi

    # Copy Docker socket test script
    if [ -f "$SCRIPTS_SOURCE_DIR/test-docker-socket.sh" ]; then
        cp "$SCRIPTS_SOURCE_DIR/test-docker-socket.sh" "$INTERNAL_SCRIPTS_DIR/test-docker-socket.sh"
        chmod +x "$INTERNAL_SCRIPTS_DIR/test-docker-socket.sh"
        echo "✓ Docker socket test script deployed"
    fi
fi

# Execute the original supervisord command
exec "$@"
