#!/usr/bin/env python3
# mm_meta:
#   name: Battery Status Monitor
#   emoji: 🔋
#   language: Python
"""
Battery Status Monitor for Auto Responder

Reports battery status for a configured list of nodes.
Queries the MeshMonitor SQLite database directly.

Trigger examples: battery, batt, batteries

Environment variables available:
- MESSAGE: Full message text
- FROM_NODE: Sender node number
- TRIGGER: Matched trigger pattern
"""

import json
import sqlite3
import sys
import time

# =============================================================================
# CONFIGURATION - Edit this list with your node IDs (hex format with ! prefix)
# =============================================================================
MONITORED_NODES = [
    "!abcd1234",  # Example: Replace with your node IDs
    "!efgh5678",  # Add more nodes as needed
]
# =============================================================================

DATABASE_PATH = "/data/meshmonitor.db"


def format_relative_time(timestamp):
    """Convert Unix timestamp to relative time string."""
    if not timestamp:
        return "unknown"

    now = int(time.time())
    diff = now - timestamp

    if diff < 60:
        return "now"
    elif diff < 3600:
        mins = diff // 60
        return f"{mins}m ago"
    elif diff < 86400:
        hours = diff // 3600
        return f"{hours}h ago"
    else:
        days = diff // 86400
        return f"{days}d ago"


def get_battery_status(conn, node_id):
    """Query battery status for a single node."""
    cursor = conn.cursor()
    cursor.execute(
        """SELECT shortName, longName, batteryLevel, voltage, lastHeard
           FROM nodes WHERE nodeId = ?""",
        (node_id,)
    )
    return cursor.fetchone()


def format_node_status(row):
    """Format a single node's battery status."""
    if not row:
        return None

    short_name, long_name, battery, voltage, last_heard = row
    name = short_name or long_name or "Unknown"

    # Build status string
    parts = [name + ":"]

    if battery is not None:
        parts.append(f"{battery}%")
    else:
        parts.append("?%")

    if voltage is not None:
        parts.append(f"{voltage:.1f}V")

    parts.append(f"({format_relative_time(last_heard)})")

    return " ".join(parts)


def main():
    try:
        if not MONITORED_NODES or MONITORED_NODES[0] == "!abcd1234":
            print(json.dumps({
                "response": "Battery monitor not configured. Edit script to add node IDs."
            }))
            return

        conn = sqlite3.connect(DATABASE_PATH)

        statuses = []
        for node_id in MONITORED_NODES:
            # Ensure node ID has ! prefix
            if not node_id.startswith("!"):
                node_id = "!" + node_id

            row = get_battery_status(conn, node_id)
            if row:
                status = format_node_status(row)
                if status:
                    statuses.append(status)
            else:
                # Node not found in database
                statuses.append(f"{node_id}: not found")

        conn.close()

        if not statuses:
            print(json.dumps({"response": "No battery data available"}))
            return

        # Join all statuses
        combined = " | ".join(statuses)

        # If fits in single message (200 char limit), send as one
        if len(combined) <= 200:
            print(json.dumps({"response": combined}))
        else:
            # Split into multiple messages if needed
            responses = []
            current = ""

            for status in statuses:
                if not current:
                    current = status
                elif len(current) + len(" | ") + len(status) <= 200:
                    current += " | " + status
                else:
                    responses.append(current)
                    current = status

            if current:
                responses.append(current)

            print(json.dumps({"responses": responses}))

    except sqlite3.Error as e:
        print(f"Database error: {e}", file=sys.stderr)
        print(json.dumps({"response": "Database error occurred"}))

    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        print(json.dumps({"response": "Battery check failed"}))


if __name__ == "__main__":
    main()
