#!/bin/sh
# mm_meta:
#   name: System Info
#   emoji: ℹ️
#   language: Shell
# System info script for Auto Responder
#
# Environment variables available:
# - MESSAGE: Full message text
# - FROM_NODE: Sender node number
# - PACKET_ID: Message packet ID
# - TRIGGER: Matched trigger pattern
# - PARAM_*: Extracted parameters from trigger

# Get uptime (first word only)
UPTIME=$(uptime | awk '{print $3}')

# Create JSON response
cat <<EOF
{
  "response": "System uptime: ${UPTIME}. From node: ${FROM_NODE}"
}
EOF
