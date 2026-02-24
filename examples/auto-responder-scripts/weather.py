#!/usr/bin/env python3
# mm_meta:
#   name: Weather Lookup
#   emoji: 🌤️
#   language: Python
"""
Weather lookup script for Auto Responder

Environment variables available:
- MESSAGE: Full message text
- FROM_NODE: Sender node number
- PACKET_ID: Message packet ID
- TRIGGER: Matched trigger pattern
- PARAM_*: Extracted parameters from trigger (e.g., PARAM_location)
"""

import os
import json
import sys

try:
    # Get location from parameter
    location = os.environ.get('PARAM_location', 'Unknown')

    # In a real implementation, you would call a weather API here
    # For this example, we'll return a simple response

    response = {
        "response": f"Weather for {location}: Sunny, 72°F",
        # Optional: Add actions for future extensibility
        # "actions": {
        #     "notify": False,
        #     "log": True
        # }
    }

    print(json.dumps(response))

except Exception as e:
    # Log error to stderr (will appear in container logs)
    print(f"Error: {e}", file=sys.stderr)
    # Return error message as response
    error_response = {
        "response": "Sorry, weather lookup failed"
    }
    print(json.dumps(error_response))
