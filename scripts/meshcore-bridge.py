#!/usr/bin/env python3
"""
MeshCore Bridge - Long-lived Python process for MeshCore communication

This script maintains a persistent connection to a MeshCore device and accepts
JSON commands over stdin, returning JSON responses over stdout.

Protocol:
- Each command is a single line of JSON
- Each response is a single line of JSON
- Commands have: {"id": "...", "cmd": "...", ...params}
- Responses have: {"id": "...", "success": true/false, "data": ...} or {"id": "...", "error": "..."}

Commands:
- connect: {"id": "1", "cmd": "connect", "port": "/dev/ttyACM0", "baud": 115200}
- disconnect: {"id": "2", "cmd": "disconnect"}
- get_self_info: {"id": "3", "cmd": "get_self_info"}
- get_contacts: {"id": "4", "cmd": "get_contacts"}
- send_message: {"id": "5", "cmd": "send_message", "text": "hello", "to": "pubkey_or_null"}
- send_advert: {"id": "6", "cmd": "send_advert"}
- login: {"id": "7", "cmd": "login", "public_key": "...", "password": "..."}
- get_status: {"id": "8", "cmd": "get_status", "public_key": "..."}
- set_name: {"id": "9", "cmd": "set_name", "name": "..."}
- set_radio: {"id": "10", "cmd": "set_radio", "freq": 906.875, "bw": 250, "sf": 11, "cr": 8}
- shutdown: {"id": "11", "cmd": "shutdown"}
"""

import asyncio
import json
import sys
import signal
import traceback
from typing import Optional, Any

# Try to import meshcore - will fail gracefully if not installed
try:
    from meshcore import MeshCore, SerialConnection
    try:
        from meshcore import TCPConnection
        TCP_AVAILABLE = True
    except ImportError:
        TCPConnection = None
        TCP_AVAILABLE = False
    MESHCORE_AVAILABLE = True
except ImportError:
    MESHCORE_AVAILABLE = False
    TCP_AVAILABLE = False
    MeshCore = None
    SerialConnection = None
    TCPConnection = None


class MeshCoreBridge:
    """Bridge between Node.js and MeshCore Python library"""

    def __init__(self):
        self.connection: Optional[Any] = None
        self.meshcore: Optional[Any] = None
        self.connected = False
        self.running = True

    async def handle_command(self, cmd_data: dict) -> dict:
        """Handle a single command and return response"""
        cmd_id = cmd_data.get('id', 'unknown')
        cmd = cmd_data.get('cmd', '')

        try:
            if cmd == 'connect':
                return await self.cmd_connect(cmd_id, cmd_data)
            elif cmd == 'disconnect':
                return await self.cmd_disconnect(cmd_id)
            elif cmd == 'get_self_info':
                return await self.cmd_get_self_info(cmd_id)
            elif cmd == 'get_contacts':
                return await self.cmd_get_contacts(cmd_id)
            elif cmd == 'send_message':
                return await self.cmd_send_message(cmd_id, cmd_data)
            elif cmd == 'send_advert':
                return await self.cmd_send_advert(cmd_id)
            elif cmd == 'login':
                return await self.cmd_login(cmd_id, cmd_data)
            elif cmd == 'get_status':
                return await self.cmd_get_status(cmd_id, cmd_data)
            elif cmd == 'set_name':
                return await self.cmd_set_name(cmd_id, cmd_data)
            elif cmd == 'set_radio':
                return await self.cmd_set_radio(cmd_id, cmd_data)
            elif cmd == 'shutdown':
                return await self.cmd_shutdown(cmd_id)
            elif cmd == 'ping':
                return {'id': cmd_id, 'success': True, 'data': 'pong'}
            else:
                return {'id': cmd_id, 'success': False, 'error': f'Unknown command: {cmd}'}
        except Exception as e:
            return {'id': cmd_id, 'success': False, 'error': str(e), 'traceback': traceback.format_exc()}

    async def cmd_connect(self, cmd_id: str, cmd_data: dict) -> dict:
        """Connect to MeshCore device (serial or TCP)"""
        if not MESHCORE_AVAILABLE:
            return {'id': cmd_id, 'success': False, 'error': 'meshcore library not installed. Run: pip install meshcore'}

        if self.connected:
            await self.cmd_disconnect(cmd_id)

        connection_type = cmd_data.get('type', 'serial')

        if connection_type == 'tcp':
            if not TCP_AVAILABLE:
                return {'id': cmd_id, 'success': False, 'error': 'TCP not supported - meshcore TCPConnection not available'}
            host = cmd_data.get('host', 'localhost')
            port = cmd_data.get('tcp_port', 4403)
            self.connection = TCPConnection(host, port)
        else:
            port = cmd_data.get('port', '/dev/ttyACM0')
            baud = cmd_data.get('baud', 115200)
            self.connection = SerialConnection(port, baudrate=baud)

        self.meshcore = MeshCore(self.connection)
        result = await self.meshcore.connect()

        if result is None:
            self.meshcore = None
            self.connection = None
            return {
                'id': cmd_id,
                'success': False,
                'error': 'No response from device — check connection and ensure it is a Companion node (not a Repeater)'
            }

        self.connected = True

        # Get initial info
        info = self.meshcore.self_info or {}

        return {
            'id': cmd_id,
            'success': True,
            'data': {
                'connected': True,
                'self_info': self._serialize_self_info(info)
            }
        }

    async def cmd_disconnect(self, cmd_id: str) -> dict:
        """Disconnect from device"""
        if self.meshcore:
            try:
                await self.meshcore.disconnect()
            except:
                pass
        self.meshcore = None
        self.connection = None
        self.connected = False
        return {'id': cmd_id, 'success': True, 'data': {'connected': False}}

    async def cmd_get_self_info(self, cmd_id: str) -> dict:
        """Get local node info"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        info = self.meshcore.self_info or {}
        return {'id': cmd_id, 'success': True, 'data': self._serialize_self_info(info)}

    async def cmd_get_contacts(self, cmd_id: str) -> dict:
        """Get contacts list"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        await self.meshcore.commands.get_contacts()
        contacts = []
        for key, contact in self.meshcore.contacts.items():
            lat = contact.get('adv_lat') or contact.get('latitude') or contact.get('lat')
            lon = contact.get('adv_lon') or contact.get('longitude') or contact.get('lon')
            # Filter out 0,0 (no GPS)
            if lat == 0.0:
                lat = None
            if lon == 0.0:
                lon = None
            contacts.append({
                'public_key': key,
                'adv_name': contact.get('adv_name', ''),
                'name': contact.get('name', ''),
                'rssi': contact.get('rssi'),
                'snr': contact.get('snr'),
                'adv_type': contact.get('type'),
                'latitude': lat,
                'longitude': lon,
            })
        return {'id': cmd_id, 'success': True, 'data': contacts}

    async def cmd_send_message(self, cmd_id: str, cmd_data: dict) -> dict:
        """Send a message"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        text = cmd_data.get('text', '')
        to_key = cmd_data.get('to')

        if to_key:
            await self.meshcore.commands.send_msg(to_key, text)
        else:
            await self.meshcore.commands.send_chan_msg(0, text)

        return {'id': cmd_id, 'success': True, 'data': {'sent': True}}

    async def cmd_send_advert(self, cmd_id: str) -> dict:
        """Send advertisement"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        await self.meshcore.commands.send_advert()
        return {'id': cmd_id, 'success': True, 'data': {'sent': True}}

    async def cmd_login(self, cmd_id: str, cmd_data: dict) -> dict:
        """Login to remote node"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        public_key = cmd_data.get('public_key', '')
        password = cmd_data.get('password', '')

        await self.meshcore.commands.send_login(public_key, password)
        return {'id': cmd_id, 'success': True, 'data': {'logged_in': True}}

    async def cmd_get_status(self, cmd_id: str, cmd_data: dict) -> dict:
        """Get status from remote node"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        public_key = cmd_data.get('public_key', '')
        status = await self.meshcore.commands.req_status_sync(public_key, timeout=10)

        if status:
            return {
                'id': cmd_id,
                'success': True,
                'data': {
                    'bat_mv': status.get('bat_mv'),
                    'up_secs': status.get('up_secs'),
                    'tx_power': status.get('tx_power'),
                    'radio_freq': status.get('radio_freq'),
                    'radio_bw': status.get('radio_bw'),
                    'radio_sf': status.get('radio_sf'),
                    'radio_cr': status.get('radio_cr'),
                }
            }
        else:
            return {'id': cmd_id, 'success': False, 'error': 'No status received'}

    async def cmd_set_name(self, cmd_id: str, cmd_data: dict) -> dict:
        """Set device name"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        name = cmd_data.get('name', '')
        await self.meshcore.commands.set_name(name)
        return {'id': cmd_id, 'success': True, 'data': {'name': name}}

    async def cmd_set_radio(self, cmd_id: str, cmd_data: dict) -> dict:
        """Set radio parameters"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        freq = cmd_data.get('freq')
        bw = cmd_data.get('bw')
        sf = cmd_data.get('sf')
        cr = cmd_data.get('cr')

        await self.meshcore.commands.set_radio(freq, bw, sf, cr)
        return {'id': cmd_id, 'success': True, 'data': {'set': True}}

    async def cmd_shutdown(self, cmd_id: str) -> dict:
        """Shutdown the bridge"""
        self.running = False
        if self.connected:
            await self.cmd_disconnect(cmd_id)
        return {'id': cmd_id, 'success': True, 'data': {'shutdown': True}}

    def _serialize_self_info(self, info: dict) -> dict:
        """Serialize self_info to JSON-safe format"""
        lat = info.get('adv_lat') or info.get('latitude')
        lon = info.get('adv_lon') or info.get('longitude')
        # Filter out 0,0 (no GPS)
        if lat == 0.0:
            lat = None
        if lon == 0.0:
            lon = None
        return {
            'public_key': info.get('public_key', ''),
            'name': info.get('name', ''),
            'adv_type': info.get('adv_type'),
            'tx_power': info.get('tx_power'),
            'max_tx_power': info.get('max_tx_power'),
            'radio_freq': info.get('radio_freq'),
            'radio_bw': info.get('radio_bw'),
            'radio_sf': info.get('radio_sf'),
            'radio_cr': info.get('radio_cr'),
            'latitude': lat,
            'longitude': lon,
        }

    async def run(self):
        """Main loop - read commands from stdin, write responses to stdout"""
        # Set up signal handlers
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda: asyncio.create_task(self.shutdown_handler()))

        # Send ready message
        print(json.dumps({
            'type': 'ready',
            'meshcore_available': MESHCORE_AVAILABLE,
            'tcp_available': TCP_AVAILABLE
        }), flush=True)

        reader = asyncio.StreamReader()
        protocol = asyncio.StreamReaderProtocol(reader)
        await loop.connect_read_pipe(lambda: protocol, sys.stdin)

        while self.running:
            try:
                line = await asyncio.wait_for(reader.readline(), timeout=1.0)
                if not line:
                    # EOF - stdin closed
                    break

                line = line.decode('utf-8').strip()
                if not line:
                    continue

                try:
                    cmd_data = json.loads(line)
                except json.JSONDecodeError as e:
                    print(json.dumps({'id': 'unknown', 'success': False, 'error': f'Invalid JSON: {e}'}), flush=True)
                    continue

                response = await self.handle_command(cmd_data)
                print(json.dumps(response), flush=True)

            except asyncio.TimeoutError:
                # No input, continue loop
                continue
            except Exception as e:
                print(json.dumps({'id': 'unknown', 'success': False, 'error': str(e)}), flush=True)

        # Clean disconnect
        if self.connected:
            await self.cmd_disconnect('shutdown')

    async def shutdown_handler(self):
        """Handle shutdown signals"""
        self.running = False


async def main():
    bridge = MeshCoreBridge()
    await bridge.run()


if __name__ == '__main__':
    asyncio.run(main())
