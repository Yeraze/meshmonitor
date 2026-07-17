#!/bin/sh
# mm_meta:
#   name: Meshview Link Responder
#   emoji: 🔗
#   language: Shell
####
# Meshview Link Responder
#
# Looks for the trigger word - !meshview - and responds via DM with a
# Meshview packet info link for the triggering message.
# "Can somebody !meshview me?"
#
# Trigger: {before:.+|^}!meshview{after:.+|$}
#
# Environment variables available:
# - MESSAGE: Full message text
# - FROM_NODE: Sender node number
# - NODE_ID: Destination node ID (e.g., !abcd1234) - for Geofence/AutoResponder3
# - PACKET_ID: Message packet ID
####

# =============================================================================
# CONFIGURATION - Edit these variables for your Meshview instance
# =============================================================================
MESHVIEW_BASE_URL=https://meshview.bayme.sh # Base URL of your Meshview instance
# =============================================================================

# Construct the MeshView link for the specific packet
MESHVIEW_LINK="${MESHVIEW_BASE_URL}/packet/${PACKET_ID}"

# Create JSON response
cat <<EOF
{
  "response": "Here's your Meshview link: ${MESHVIEW_LINK}",
  "private": true
}
EOF
