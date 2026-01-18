#!/usr/bin/env python3
# mm_meta:
#   name: Lorem Ipsum (Multi-Message)
#   emoji: 📜
#   language: Python
"""
Lorem Ipsum Multi-Message Example (Python)

Demonstrates how scripts can return multiple responses
that will be queued and sent individually.

Output format: { "responses": ["msg1", "msg2", "msg3"] }
"""

import json

lorem_ipsum_lines = [
    "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.",
    "Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
    "Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur."
]

# Return multiple responses
output = {
    "responses": lorem_ipsum_lines
}

print(json.dumps(output))
