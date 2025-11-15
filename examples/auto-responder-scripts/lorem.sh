#!/bin/sh

# Lorem Ipsum Multi-Message Example (Shell)
#
# Demonstrates how scripts can return multiple responses
# that will be queued and sent individually.
#
# Output format: { "responses": ["msg1", "msg2", "msg3"] }

cat << 'EOF'
{
  "responses": [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
    "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur."
  ]
}
EOF
