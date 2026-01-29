#!/bin/sh
# mm_meta:
#   name: Remote Admin (Shell)
#   emoji: 🔧
#   language: Shell
#
# Simple shell wrapper for remote admin commands
#
# Usage:
#   ./remote-admin.sh --reboot
#   ./remote-admin.sh --set lora.region US
#   ./remote-admin.sh --setlat 40.7128 --setlon -74.0060
#
# Environment variables (set automatically by MeshMonitor):
#   MESHTASTIC_IP   - IP address of connected node
#   MESHTASTIC_PORT - TCP port (usually 4403)
#   NODE_ID         - Destination node ID (e.g., !abcd1234)
#
# All arguments are passed directly to the meshtastic CLI

# Check required environment variables
if [ -z "$MESHTASTIC_IP" ]; then
    echo '{"success": false, "error": "MESHTASTIC_IP not set"}'
    exit 1
fi

if [ -z "$NODE_ID" ]; then
    echo '{"success": false, "error": "NODE_ID not set"}'
    exit 1
fi

# Build the host string
HOST="${MESHTASTIC_IP}:${MESHTASTIC_PORT:-4403}"

# Run meshtastic command with all passed arguments
OUTPUT=$(meshtastic --host "$HOST" --dest "$NODE_ID" "$@" 2>&1)
RESULT=$?

if [ $RESULT -eq 0 ]; then
    NODE_NAME="${NODE_LONG_NAME:-$NODE_ID}"
    EVENT="${GEOFENCE_EVENT:-command}"
    cat <<EOF
{
  "success": true,
  "response": "Remote admin ${EVENT} for ${NODE_NAME}: OK"
}
EOF
else
    # Escape quotes in output for JSON
    ESCAPED_OUTPUT=$(echo "$OUTPUT" | sed 's/"/\\"/g' | tr '\n' ' ')
    cat <<EOF
{
  "success": false,
  "error": "${ESCAPED_OUTPUT}"
}
EOF
    exit 1
fi
