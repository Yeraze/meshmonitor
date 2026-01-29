#!/bin/sh
# mm_meta:
#   name: Remote Admin (Shell)
#   emoji: 🔧
#   language: Shell
#
# Simple shell wrapper for remote admin commands
# Works with Geofence triggers, Timer triggers, and Auto Responder.
#
# Usage with MeshMonitor Script Arguments (Recommended):
#   In the MeshMonitor UI, set:
#   - Script: remote-admin.sh
#   - Arguments: --reboot
#   - Arguments: --set lora.region US
#   - Arguments: --setlat 40.7128 --setlon -74.0060
#
#   Arguments support token expansion:
#   - Arguments: --dest {NODE_ID} --reboot
#   - Arguments: --set device.role CLIENT
#
#   For Timer triggers (no automatic NODE_ID), include --dest in args:
#   - Arguments: --dest '!abcd1234' --reboot
#
# Usage as a standalone script:
#   ./remote-admin.sh --reboot
#   ./remote-admin.sh --set lora.region US
#
# Environment variables (set automatically by MeshMonitor):
#   MESHTASTIC_IP   - IP address of connected node
#   MESHTASTIC_PORT - TCP port (usually 4403)
#   NODE_ID         - Destination node ID (e.g., !abcd1234) - for Geofence/AutoResponder
#
# All arguments are passed directly to the meshtastic CLI.
# For Timer triggers, include --dest in your script arguments.

# Check required environment variables
if [ -z "$MESHTASTIC_IP" ]; then
    echo '{"success": false, "error": "MESHTASTIC_IP not set"}'
    exit 1
fi

# Build the host string
HOST="${MESHTASTIC_IP}:${MESHTASTIC_PORT:-4403}"

# Build command: if NODE_ID is set from env, add --dest; otherwise user must include it in args
if [ -n "$NODE_ID" ]; then
    # Geofence/AutoResponder context - add dest from env var
    OUTPUT=$(meshtastic --host "$HOST" --dest "$NODE_ID" "$@" 2>&1)
else
    # Timer context - user should include --dest in script args
    OUTPUT=$(meshtastic --host "$HOST" "$@" 2>&1)
fi
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
