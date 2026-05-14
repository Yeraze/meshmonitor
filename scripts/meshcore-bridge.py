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
- set_coords: {"id": "12", "cmd": "set_coords", "lat": 30.0, "lon": -90.0}
- set_advert_loc_policy: {"id": "13", "cmd": "set_advert_loc_policy", "policy": 1}
- set_telemetry_mode_base: {"id": "14", "cmd": "set_telemetry_mode_base", "mode": "always"}
- set_telemetry_mode_loc: {"id": "15", "cmd": "set_telemetry_mode_loc", "mode": "device"}
- set_telemetry_mode_env: {"id": "16", "cmd": "set_telemetry_mode_env", "mode": "never"}
- get_stats: {"id": "17", "cmd": "get_stats", "type": "core" | "radio" | "packets"}
- get_device_time: {"id": "18", "cmd": "get_device_time"}
- device_query: {"id": "19", "cmd": "device_query"}
- request_telemetry: {"id": "20", "cmd": "request_telemetry", "public_key": "...", "timeout": 0}
- shutdown: {"id": "11", "cmd": "shutdown"}

The get_stats / get_device_time / device_query commands hit only the locally-
connected node over its companion-protocol serial/BLE link. They never put a
packet on the air, so they are safe to poll on a fixed interval.
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
    from meshcore.events import EventType
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
    EventType = None


class MeshCoreBridge:
    """Bridge between Node.js and MeshCore Python library"""

    def __init__(self):
        self.connection: Optional[Any] = None
        self.meshcore: Optional[Any] = None
        self.connected = False
        self.running = True
        self.subscriptions = []

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
            elif cmd == 'set_coords':
                return await self.cmd_set_coords(cmd_id, cmd_data)
            elif cmd == 'set_advert_loc_policy':
                return await self.cmd_set_advert_loc_policy(cmd_id, cmd_data)
            elif cmd == 'set_telemetry_mode_base':
                return await self.cmd_set_telemetry_mode_base(cmd_id, cmd_data)
            elif cmd == 'set_telemetry_mode_loc':
                return await self.cmd_set_telemetry_mode_loc(cmd_id, cmd_data)
            elif cmd == 'set_telemetry_mode_env':
                return await self.cmd_set_telemetry_mode_env(cmd_id, cmd_data)
            elif cmd == 'get_stats':
                return await self.cmd_get_stats(cmd_id, cmd_data)
            elif cmd == 'get_device_time':
                return await self.cmd_get_device_time(cmd_id)
            elif cmd == 'device_query':
                return await self.cmd_device_query(cmd_id)
            elif cmd == 'request_telemetry':
                return await self.cmd_request_telemetry(cmd_id, cmd_data)
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

        # Start auto message fetching and subscribe to incoming messages
        await self._setup_message_subscriptions()

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

    def _emit_event(self, event_type: str, data: dict) -> None:
        """Emit an unsolicited event to stdout for Node.js to consume"""
        print(json.dumps({
            'type': 'event',
            'event_type': event_type,
            'data': data
        }), flush=True)

    async def _setup_message_subscriptions(self) -> None:
        """Subscribe to incoming message events and start auto-fetching"""
        if not self.meshcore or not EventType:
            return

        async def on_contact_message(event):
            payload = event.payload
            self._emit_event('contact_message', {
                'pubkey_prefix': payload.get('pubkey_prefix', ''),
                'text': payload.get('text', ''),
                'sender_timestamp': payload.get('sender_timestamp', 0),
                'path_len': payload.get('path_len', 0),
                'snr': payload.get('SNR'),
            })

        async def on_channel_message(event):
            payload = event.payload
            self._emit_event('channel_message', {
                'channel_idx': payload.get('channel_idx', 0),
                'text': payload.get('text', ''),
                'sender_timestamp': payload.get('sender_timestamp', 0),
                'path_len': payload.get('path_len', 0),
                'snr': payload.get('SNR'),
            })

        async def on_advertisement(event):
            try:
                payload = event.payload
                self._emit_event('contact_advertised', {
                    'public_key': payload.get('public_key', ''),
                    'adv_name': payload.get('adv_name', ''),
                    'adv_type': payload.get('type'),
                    'last_advert': payload.get('last_advert'),
                    'latitude': payload.get('adv_lat'),
                    'longitude': payload.get('adv_lon'),
                })
            except Exception as e:
                self._emit_event('debug', {'message': f'Error in on_advertisement: {e}'})

        async def on_new_contact(event):
            try:
                payload = event.payload
                self._emit_event('contact_added', {
                    'public_key': payload.get('public_key', ''),
                    'adv_name': payload.get('adv_name', ''),
                    'adv_type': payload.get('type'),
                    'last_advert': payload.get('last_advert'),
                    'latitude': payload.get('adv_lat'),
                    'longitude': payload.get('adv_lon'),
                })
            except Exception as e:
                self._emit_event('debug', {'message': f'Error in on_new_contact: {e}'})

        async def on_path_update(event):
            try:
                payload = event.payload
                self._emit_event('contact_path_updated', {
                    'public_key': payload.get('public_key', ''),
                })
            except Exception as e:
                self._emit_event('debug', {'message': f'Error in on_path_update: {e}'})

        sub1 = self.meshcore.subscribe(EventType.CONTACT_MSG_RECV, on_contact_message)
        sub2 = self.meshcore.subscribe(EventType.CHANNEL_MSG_RECV, on_channel_message)
        sub3 = self.meshcore.subscribe(EventType.ADVERTISEMENT, on_advertisement)
        sub4 = self.meshcore.subscribe(EventType.NEW_CONTACT, on_new_contact)
        sub5 = self.meshcore.subscribe(EventType.PATH_UPDATE, on_path_update)
        self.subscriptions = [sub1, sub2, sub3, sub4, sub5]

        # Start auto message fetching (polls device when MESSAGES_WAITING is received)
        auto_sub = await self.meshcore.start_auto_message_fetching()
        self.subscriptions.append(auto_sub)

    async def _cleanup_subscriptions(self) -> None:
        """Unsubscribe from all message events"""
        if self.meshcore:
            try:
                self.meshcore.stop_auto_message_fetching()
            except Exception as e:
                print(json.dumps({'type': 'event', 'event_type': 'debug', 'data': {'message': f'Error stopping auto-fetch: {e}'}}), flush=True)
            for sub in self.subscriptions:
                try:
                    self.meshcore.unsubscribe(sub)
                except Exception as e:
                    print(json.dumps({'type': 'event', 'event_type': 'debug', 'data': {'message': f'Error unsubscribing: {e}'}}), flush=True)
        self.subscriptions = []

    async def cmd_disconnect(self, cmd_id: str) -> dict:
        """Disconnect from device"""
        await self._cleanup_subscriptions()
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

        result = await self.meshcore.commands.set_radio(freq, bw, sf, cr)
        if result is not None and getattr(result, 'is_error', lambda: False)():
            err = getattr(result, 'payload', None) or 'device rejected set_radio'
            return {'id': cmd_id, 'success': False, 'error': str(err)}
        return {'id': cmd_id, 'success': True, 'data': {'set': True, 'freq': freq, 'bw': bw, 'sf': sf, 'cr': cr}}

    async def cmd_set_coords(self, cmd_id: str, cmd_data: dict) -> dict:
        """Set device GPS coordinates (lat/lon in decimal degrees)"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        lat = cmd_data.get('lat')
        lon = cmd_data.get('lon')
        if lat is None or lon is None:
            return {'id': cmd_id, 'success': False, 'error': 'lat and lon required'}

        await self.meshcore.commands.set_coords(float(lat), float(lon))
        return {'id': cmd_id, 'success': True, 'data': {'lat': float(lat), 'lon': float(lon)}}

    async def cmd_set_advert_loc_policy(self, cmd_id: str, cmd_data: dict) -> dict:
        """Set advert location policy (0 = off, 1 = include coords in adverts)"""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        policy = cmd_data.get('policy')
        if policy is None:
            return {'id': cmd_id, 'success': False, 'error': 'policy required'}

        await self.meshcore.commands.set_advert_loc_policy(int(policy))
        return {'id': cmd_id, 'success': True, 'data': {'policy': int(policy)}}

    @staticmethod
    def _parse_telemetry_mode(mode: Any) -> Optional[int]:
        """Convert string/int mode to wire-level int (0=never, 1=device, 2=always)."""
        if mode is None:
            return None
        if isinstance(mode, int):
            if mode in (0, 1, 2):
                return mode
            return None
        if isinstance(mode, str):
            m = mode.strip().lower()
            if m == 'always' or m == 'all':
                return 2
            if m == 'device' or m == 'selected':
                return 1
            if m == 'never' or m == 'off':
                return 0
        return None

    async def _set_telemetry_mode(self, cmd_id: str, cmd_data: dict, field: str) -> dict:
        """Shared implementation for set_telemetry_mode_{base,loc,env}."""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        mode_value = self._parse_telemetry_mode(cmd_data.get('mode'))
        if mode_value is None:
            return {'id': cmd_id, 'success': False, 'error': 'mode must be always|device|never'}

        setter_name = f'set_telemetry_mode_{field}'
        setter = getattr(self.meshcore.commands, setter_name, None)
        if setter is None:
            return {'id': cmd_id, 'success': False, 'error': f'meshcore lacks {setter_name}'}

        result = await setter(mode_value)
        if result is not None and getattr(result, 'is_error', lambda: False)():
            err = getattr(result, 'payload', None) or f'device rejected {setter_name}'
            return {'id': cmd_id, 'success': False, 'error': str(err)}
        return {'id': cmd_id, 'success': True, 'data': {'mode': mode_value}}

    async def cmd_set_telemetry_mode_base(self, cmd_id: str, cmd_data: dict) -> dict:
        """Set basic telemetry sharing mode."""
        return await self._set_telemetry_mode(cmd_id, cmd_data, 'base')

    async def cmd_set_telemetry_mode_loc(self, cmd_id: str, cmd_data: dict) -> dict:
        """Set location telemetry sharing mode."""
        return await self._set_telemetry_mode(cmd_id, cmd_data, 'loc')

    async def cmd_set_telemetry_mode_env(self, cmd_id: str, cmd_data: dict) -> dict:
        """Set environment telemetry sharing mode."""
        return await self._set_telemetry_mode(cmd_id, cmd_data, 'env')

    async def cmd_get_stats(self, cmd_id: str, cmd_data: dict) -> dict:
        """Fetch local-node stats. type ∈ {core, radio, packets}.

        These are GetStats(subtype) over the companion-protocol link to the
        locally-connected node ONLY — they do not transmit on the air.
        """
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        stats_type = (cmd_data.get('type') or '').strip().lower()
        if stats_type == 'core':
            getter = getattr(self.meshcore.commands, 'get_stats_core', None)
        elif stats_type == 'radio':
            getter = getattr(self.meshcore.commands, 'get_stats_radio', None)
        elif stats_type == 'packets':
            getter = getattr(self.meshcore.commands, 'get_stats_packets', None)
        else:
            return {'id': cmd_id, 'success': False, 'error': 'type must be core|radio|packets'}

        if getter is None:
            return {'id': cmd_id, 'success': False, 'error': f'meshcore lacks get_stats_{stats_type}'}

        try:
            event = await getter()
        except Exception as e:
            return {'id': cmd_id, 'success': False, 'error': f'get_stats_{stats_type} threw: {e}'}

        if event is None:
            return {'id': cmd_id, 'success': False, 'error': f'no response for get_stats_{stats_type}'}
        if getattr(event, 'is_error', lambda: False)():
            err = getattr(event, 'payload', None) or f'device rejected get_stats_{stats_type}'
            return {'id': cmd_id, 'success': False, 'error': str(err)}

        payload = getattr(event, 'payload', None)
        if not isinstance(payload, dict):
            return {'id': cmd_id, 'success': False, 'error': f'unexpected stats payload: {payload!r}'}

        # Pass the dict through verbatim — Node side decides which fields it
        # wants. python-meshcore field names: battery_mv, uptime_secs, errors,
        # queue_len, noise_floor, last_rssi, last_snr, tx_air_secs, rx_air_secs,
        # recv, sent, flood_tx, direct_tx, flood_rx, direct_rx, recv_errors.
        return {'id': cmd_id, 'success': True, 'data': {'type': stats_type, **payload}}

    async def cmd_get_device_time(self, cmd_id: str) -> dict:
        """Read the RTC on the locally-connected node. Local only — no RF."""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        getter = getattr(self.meshcore.commands, 'get_time', None)
        if getter is None:
            return {'id': cmd_id, 'success': False, 'error': 'meshcore lacks get_time'}

        try:
            event = await getter()
        except Exception as e:
            return {'id': cmd_id, 'success': False, 'error': f'get_time threw: {e}'}

        if event is None:
            return {'id': cmd_id, 'success': False, 'error': 'no response for get_time'}
        if getattr(event, 'is_error', lambda: False)():
            err = getattr(event, 'payload', None) or 'device rejected get_time'
            return {'id': cmd_id, 'success': False, 'error': str(err)}

        payload = getattr(event, 'payload', None) or {}
        return {'id': cmd_id, 'success': True, 'data': {'time': payload.get('time')}}

    async def cmd_device_query(self, cmd_id: str) -> dict:
        """DeviceQuery → DeviceInfo. Local only — no RF."""
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        getter = getattr(self.meshcore.commands, 'send_device_query', None)
        if getter is None:
            return {'id': cmd_id, 'success': False, 'error': 'meshcore lacks send_device_query'}

        try:
            event = await getter()
        except Exception as e:
            return {'id': cmd_id, 'success': False, 'error': f'send_device_query threw: {e}'}

        if event is None:
            return {'id': cmd_id, 'success': False, 'error': 'no response for device_query'}
        if getattr(event, 'is_error', lambda: False)():
            err = getattr(event, 'payload', None) or 'device rejected device_query'
            return {'id': cmd_id, 'success': False, 'error': str(err)}

        payload = getattr(event, 'payload', None) or {}
        # Forward verbatim: fw ver, fw_build (date string), model, ver, etc.
        return {'id': cmd_id, 'success': True, 'data': dict(payload)}

    async def cmd_request_telemetry(self, cmd_id: str, cmd_data: dict) -> dict:
        """Request telemetry from a remote node over RF.

        Calls `meshcore.commands.binary.req_telemetry_sync(contact)`. This
        DOES transmit on the air — collision avoidance is the caller's
        responsibility (the Node-side scheduler enforces a 60s global
        minimum between requests). Returns the LPP frame as a list of
        `{channel, type, value}` records.
        """
        if not self.connected or not self.meshcore:
            return {'id': cmd_id, 'success': False, 'error': 'Not connected'}

        public_key = cmd_data.get('public_key', '')
        if not public_key:
            return {'id': cmd_id, 'success': False, 'error': 'public_key required'}

        contact = self.meshcore.contacts.get(public_key)
        if not contact:
            # Refresh once in case the cache hasn't seen this contact yet.
            try:
                await self.meshcore.commands.get_contacts()
                contact = self.meshcore.contacts.get(public_key)
            except Exception as e:
                return {'id': cmd_id, 'success': False, 'error': f'get_contacts threw: {e}'}
        if not contact:
            return {'id': cmd_id, 'success': False, 'error': f'no contact for {public_key[:16]}…'}

        try:
            timeout = float(cmd_data.get('timeout') or 0)
        except (TypeError, ValueError):
            timeout = 0.0

        try:
            lpp = await self.meshcore.commands.req_telemetry_sync(contact, timeout=timeout)
        except Exception as e:
            return {'id': cmd_id, 'success': False, 'error': f'req_telemetry_sync threw: {e}'}

        if lpp is None:
            return {'id': cmd_id, 'success': False, 'error': 'no telemetry response (timeout?)'}

        # `lpp` is a cayennelpp.LppFrame. `.data` is a list of LppData entries,
        # each with .channel, .type (an LppType enum-ish wrapper), .value
        # (tuple of floats). Serialize to plain dicts so we can ship over JSON.
        try:
            records = []
            for item in getattr(lpp, 'data', []) or []:
                # `type` is an LppType-ish object that compares to int — we
                # forward the raw numeric LPP type id so the Node side can
                # decide on a string name without depending on the python lib.
                type_id = getattr(item.type, 'type', None)
                if type_id is None:
                    # Fall back: some versions stash type id directly.
                    type_id = getattr(item, 'type_id', None)
                value = item.value
                if isinstance(value, (list, tuple)):
                    serialized_value = [float(v) if isinstance(v, (int, float)) else v for v in value]
                    if len(serialized_value) == 1:
                        serialized_value = serialized_value[0]
                else:
                    serialized_value = value
                records.append({
                    'channel': int(getattr(item, 'channel', 0)),
                    'type': int(type_id) if type_id is not None else None,
                    'value': serialized_value,
                })
        except Exception as e:
            return {'id': cmd_id, 'success': False, 'error': f'failed to serialize lpp: {e}'}

        return {'id': cmd_id, 'success': True, 'data': {'records': records}}

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
            'adv_loc_policy': info.get('adv_loc_policy'),
            'telemetry_mode_base': info.get('telemetry_mode_base'),
            'telemetry_mode_loc': info.get('telemetry_mode_loc'),
            'telemetry_mode_env': info.get('telemetry_mode_env'),
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
