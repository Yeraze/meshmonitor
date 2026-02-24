#!/usr/bin/env python3
# mm_meta:
#   name: API Query Example
#   emoji: 🔌
#   language: Python
"""
API Query Script - Demonstrates using MeshMonitor's v1 API from scripts.

This script shows how to use an API token to query the MeshMonitor v1 API
for complex data operations like looking up nodes, messages, and telemetry.

Requirements:
- Python 3.6+
- MM_API_TOKEN environment variable (generate from Settings > API Tokens)
- MM_API_URL environment variable (defaults to http://localhost:3001/meshmonitor)

Setup:
1. Generate an API token in MeshMonitor: Settings > API Tokens > Generate Token
2. Add to docker-compose.yaml environment variables:
   - MM_API_TOKEN=your_api_token_here
   - MM_API_URL=http://localhost:3001/meshmonitor  # Optional, defaults to localhost
3. Copy this script to your scripts directory
4. Configure trigger in MeshMonitor UI:
   - Trigger Pattern: nodeinfo, nodeinfo {nodeid}
   - Response Type: Script
   - Response: /data/scripts/api-query.py

Usage:
- nodeinfo - Shows info about the sender node
- nodeinfo !abc12345 - Shows info about a specific node

Environment Variables Available:
- FROM_NODE: Sender's node number
- FROM_LAT, FROM_LON: Sender's location (if known)
- MM_LAT, MM_LON: MeshMonitor node location (if known)
- MM_API_TOKEN: API token for authentication
- MM_API_URL: Base URL for API (e.g., http://localhost:3001/meshmonitor)
"""

import os
import sys
import json
import urllib.request
import urllib.error
from typing import Optional, Dict, Any

# Configuration
API_TOKEN = os.environ.get("MM_API_TOKEN", "")
API_URL = os.environ.get("MM_API_URL", "http://localhost:3001/meshmonitor")


def api_request(endpoint: str, timeout: int = 5) -> Optional[Dict[str, Any]]:
    """
    Make an authenticated request to the MeshMonitor v1 API.

    Args:
        endpoint: API endpoint (e.g., '/api/v1/nodes')
        timeout: Request timeout in seconds

    Returns:
        Parsed JSON response or None on error
    """
    if not API_TOKEN:
        return None

    url = f"{API_URL.rstrip('/')}{endpoint}"
    headers = {
        "Authorization": f"Bearer {API_TOKEN}",
        "Accept": "application/json",
        "User-Agent": "MeshMonitor-Script/1.0"
    }

    try:
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        print(f"API HTTP error: {e.code}", file=sys.stderr)
        return None
    except urllib.error.URLError as e:
        print(f"API URL error: {e.reason}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"API error: {e}", file=sys.stderr)
        return None


def get_node_info(node_id: str) -> Optional[Dict[str, Any]]:
    """
    Get information about a specific node.

    Args:
        node_id: Node ID (e.g., '!abc12345')

    Returns:
        Node data or None if not found
    """
    result = api_request(f"/api/v1/nodes/{node_id}")
    if result and result.get("success"):
        return result.get("data")
    return None


def get_all_nodes() -> list:
    """Get all nodes from the mesh network."""
    result = api_request("/api/v1/nodes")
    if result and result.get("success"):
        return result.get("data", [])
    return []


def format_node_info(node: Dict[str, Any]) -> str:
    """Format node information for display."""
    parts = []

    # Basic info
    name = node.get("longName") or node.get("shortName") or "Unknown"
    node_id = node.get("nodeId", "?")
    parts.append(f"{name} ({node_id})")

    # Hardware
    hw_model = node.get("hwModel")
    if hw_model:
        parts.append(f"HW: {hw_model}")

    # Location
    lat = node.get("latitude")
    lon = node.get("longitude")
    if lat and lon:
        parts.append(f"Loc: {lat:.4f},{lon:.4f}")

    # Battery
    battery = node.get("batteryLevel")
    if battery and battery > 0:
        parts.append(f"Batt: {battery}%")

    # Last seen
    last_heard = node.get("lastHeard")
    if last_heard:
        # Convert to relative time
        import time
        try:
            elapsed = int(time.time()) - int(last_heard)
            if elapsed < 60:
                parts.append(f"Seen: {elapsed}s ago")
            elif elapsed < 3600:
                parts.append(f"Seen: {elapsed // 60}m ago")
            elif elapsed < 86400:
                parts.append(f"Seen: {elapsed // 3600}h ago")
            else:
                parts.append(f"Seen: {elapsed // 86400}d ago")
        except (ValueError, TypeError):
            pass

    return " | ".join(parts)


def main():
    """Main function to handle node info requests."""
    try:
        # Get parameters
        from_node = os.environ.get("FROM_NODE", "0")
        param_nodeid = os.environ.get("PARAM_nodeid", "").strip()

        # Check if API token is configured
        if not API_TOKEN:
            output = {
                "response": "API token not configured. Set MM_API_TOKEN in environment."
            }
            print(json.dumps(output))
            return

        # Determine which node to look up
        if param_nodeid:
            # User specified a node ID
            target_node_id = param_nodeid
            if not target_node_id.startswith("!"):
                # Try to interpret as hex node number
                try:
                    node_num = int(target_node_id, 16)
                    target_node_id = f"!{target_node_id.lower()}"
                except ValueError:
                    target_node_id = f"!{target_node_id}"
        else:
            # Look up the sender's node
            try:
                from_num = int(from_node)
                target_node_id = f"!{from_num:08x}"
            except ValueError:
                output = {"response": "Invalid sender node number"}
                print(json.dumps(output))
                return

        # Query the API
        node = get_node_info(target_node_id)

        if node:
            info = format_node_info(node)
            output = {"response": info[:200]}  # Truncate to Meshtastic limit
        else:
            # Try to find by searching all nodes
            all_nodes = get_all_nodes()
            matching = [n for n in all_nodes if target_node_id.lower() in (n.get("nodeId", "").lower())]

            if matching:
                info = format_node_info(matching[0])
                output = {"response": info[:200]}
            else:
                output = {"response": f"Node {target_node_id} not found"}

        print(json.dumps(output))

    except Exception as e:
        error_msg = f"Error: {str(e)}"
        if len(error_msg) > 195:
            error_msg = error_msg[:192] + "..."
        output = {"response": error_msg}
        print(json.dumps(output))
        print(f"Script error: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
