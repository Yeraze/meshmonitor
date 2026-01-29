#!/usr/bin/env python3
# mm_meta:
#   name: Remote Admin
#   emoji: 🔧
#   language: Python
"""
Remote Admin Script for MeshMonitor

Sends remote admin commands to Meshtastic nodes via the CLI.
Works with Geofence triggers, Timer triggers, and Auto Responder.

Usage with MeshMonitor Script Arguments (Recommended):
    In the MeshMonitor UI, set:
    - Script: remote-admin.py
    - Arguments: --reboot
    - Arguments: --set lora.region US
    - Arguments: --setlat 40.7128 --setlon -74.0060

    Arguments support token expansion:
    - Arguments: --dest {NODE_ID} --reboot
    - Arguments: --set device.role CLIENT

    For Timer triggers (no automatic NODE_ID), specify destination:
    - Arguments: --dest !abcd1234 --reboot

Usage as a standalone script:
    ./remote-admin.py --dest !abcd1234 --set lora.region US
    ./remote-admin.py --ip 192.168.1.100 --dest !abcd1234 --reboot

Environment variables (set automatically by MeshMonitor):
    MESHTASTIC_IP      - IP address of the connected Meshtastic node
    MESHTASTIC_PORT    - TCP port (usually 4403)
    NODE_ID            - Node ID that triggered the event
    NODE_NUM           - Node number (decimal)
    NODE_LONG_NAME     - Node's long name (if known)
    GEOFENCE_NAME      - Name of the geofence (for geofence triggers)
    GEOFENCE_EVENT     - Event type: entry, exit, while_inside

Common meshtastic CLI arguments:
    --reboot                      Reboot the node
    --set <setting> <value>       Set a configuration value
    --setlat <lat> --setlon <lon> Set node position
    --ch-set <setting> <value>    Modify channel settings
    --factory-reset               Factory reset the node
    --get <setting>               Get a configuration value
"""

import os
import sys
import json
import subprocess
import argparse


def get_meshtastic_host():
    """Get the Meshtastic host from environment or args."""
    ip = os.environ.get('MESHTASTIC_IP', '')
    port = os.environ.get('MESHTASTIC_PORT', '4403')

    if ip:
        return f"{ip}:{port}"
    return None


def get_dest_node():
    """Get destination node from environment."""
    return os.environ.get('NODE_ID', '')


def run_meshtastic_command(host, dest, args):
    """Run a meshtastic CLI command and return the result."""
    cmd = ['meshtastic', '--host', host]

    if dest:
        cmd.extend(['--dest', dest])

    cmd.extend(args)

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=30
        )
        return {
            'success': result.returncode == 0,
            'stdout': result.stdout.strip(),
            'stderr': result.stderr.strip(),
            'command': ' '.join(cmd)
        }
    except subprocess.TimeoutExpired:
        return {
            'success': False,
            'error': 'Command timed out after 30 seconds',
            'command': ' '.join(cmd)
        }
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'command': ' '.join(cmd)
        }


def main():
    parser = argparse.ArgumentParser(
        description='Send remote admin commands to Meshtastic nodes',
        epilog='Any additional arguments are passed directly to the meshtastic CLI'
    )
    parser.add_argument(
        '--ip',
        help='Meshtastic node IP (default: from MESHTASTIC_IP env var)'
    )
    parser.add_argument(
        '--port',
        default='4403',
        help='Meshtastic TCP port (default: 4403 or MESHTASTIC_PORT env var)'
    )
    parser.add_argument(
        '--dest',
        help='Destination node ID (default: from NODE_ID env var)'
    )
    parser.add_argument(
        '--quiet', '-q',
        action='store_true',
        help='Suppress output (for geofence scripts with no mesh output)'
    )

    # Parse known args, pass rest to meshtastic CLI
    args, meshtastic_args = parser.parse_known_args()

    # Determine host
    if args.ip:
        host = f"{args.ip}:{args.port}"
    else:
        host = get_meshtastic_host()
        if not host:
            error_msg = "No Meshtastic host specified. Use --ip or set MESHTASTIC_IP"
            if args.quiet:
                sys.exit(1)
            print(json.dumps({
                'success': False,
                'error': error_msg
            }))
            sys.exit(1)

    # Determine destination node
    dest = args.dest or get_dest_node()

    # Must have meshtastic args
    if not meshtastic_args:
        error_msg = "No meshtastic command specified. Add arguments like --reboot, --set, etc."
        if args.quiet:
            sys.exit(1)
        print(json.dumps({
            'success': False,
            'error': error_msg
        }))
        sys.exit(1)

    # Run the command
    result = run_meshtastic_command(host, dest, meshtastic_args)

    # Output result
    if args.quiet:
        sys.exit(0 if result['success'] else 1)

    # For geofence scripts, output JSON that MeshMonitor can parse
    if result['success']:
        # Build a response message
        node_name = os.environ.get('NODE_LONG_NAME', dest or 'node')
        event = os.environ.get('GEOFENCE_EVENT', 'command')
        geofence = os.environ.get('GEOFENCE_NAME', '')

        if geofence:
            response = f"Remote admin {event} for {node_name} at {geofence}: OK"
        else:
            response = f"Remote admin command for {node_name}: OK"

        print(json.dumps({
            'success': True,
            'response': response,
            'details': result.get('stdout', '')
        }))
    else:
        error = result.get('error') or result.get('stderr', 'Unknown error')
        print(json.dumps({
            'success': False,
            'error': error,
            'command': result.get('command', '')
        }))
        sys.exit(1)


if __name__ == '__main__':
    main()
