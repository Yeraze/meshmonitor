# MeshMonitor API Reference

## Complete REST API Documentation

This document provides comprehensive documentation for all MeshMonitor API endpoints.

**Base URL:** `http://localhost:3001/api` (development) or `http://localhost:8080/api` (production)

**Content Type:** `application/json`

## Table of Contents

- [Health & Status](#health--status)
- [Node Management](#node-management)
- [Message Operations](#message-operations)
- [Channel Management](#channel-management)
- [Telemetry Data](#telemetry-data)
- [Traceroute Operations](#traceroute-operations)
- [System Configuration](#system-configuration)
- [Data Management](#data-management)
- [Statistics](#statistics)

---

## Health & Status

### GET /api/health
Health check endpoint.

**Response:**
```json
{
  "status": "ok"
}
```

### GET /api/system/status
Comprehensive system status including database and connection info.

**Response:**
```json
{
  "status": "running",
  "uptime": 3600,
  "database": {
    "connected": true,
    "messageCount": 1234,
    "nodeCount": 42,
    "oldestMessage": 1640995200000,
    "newestMessage": 1641995200000
  },
  "connection": {
    "connected": true,
    "nodeId": "!075bcd15",
    "lastActivity": 1641995200000
  },
  "version": "1.1.0"
}
```

---

## Node Management

### GET /api/nodes
Get all nodes from the database.

**Response:**
```json
[
  {
    "nodeNum": 123456789,
    "nodeId": "!075bcd15",
    "longName": "Base Station Alpha",
    "shortName": "BSA",
    "hwModel": 9,
    "role": 2,
    "hopsAway": 0,
    "isFavorite": 1,
    "latitude": 40.7128,
    "longitude": -74.0060,
    "altitude": 10.5,
    "batteryLevel": 85,
    "voltage": 3.7,
    "channelUtilization": 15.2,
    "airUtilTx": 8.5,
    "lastHeard": 1641995200,
    "snr": 12.5,
    "rssi": -45,
    "lastTracerouteRequest": 1641990000,
    "createdAt": 1640990000,
    "updatedAt": 1641995200
  }
]
```

### GET /api/nodes/active
Get active nodes (heard within specified days).

**Query Parameters:**
- `days` (optional): Number of days to consider active (default: 7)

**Example:**
```
GET /api/nodes/active?days=3
```

### POST /api/nodes/refresh
Force refresh of node information from the Meshtastic device.

**Response:**
```json
{
  "success": true,
  "message": "Node refresh initiated",
  "nodeCount": 42
}
```

### POST /api/nodes/:nodeId/favorite
Set or remove favorite status for a node with optional device synchronization.

**Path Parameters:**
- `nodeId` (required): Node ID (e.g., "!a2e4ff4c")

**Request Body:**
```json
{
  "isFavorite": true,
  "syncToDevice": true
}
```

**Parameters:**
- `isFavorite` (required, boolean): Whether to mark the node as favorite
- `syncToDevice` (optional, boolean): Whether to sync to device via admin messages (default: true)

**Response (success):**
```json
{
  "success": true,
  "nodeNum": 2732916556,
  "isFavorite": true,
  "deviceSync": {
    "status": "success"
  }
}
```

**Response (database-only mode):**
```json
{
  "success": true,
  "nodeNum": 2732916556,
  "isFavorite": false,
  "deviceSync": {
    "status": "skipped"
  }
}
```

**Response (device sync failed):**
```json
{
  "success": true,
  "nodeNum": 2732916556,
  "isFavorite": true,
  "deviceSync": {
    "status": "failed",
    "error": "Not connected to Meshtastic node"
  }
}
```

**Device Sync Details:**
- Uses Meshtastic admin messages (ADMIN_APP portnum 6)
- Local TCP connections do not require session passkeys
- Requires firmware version >= 2.7.0 for device support
- Database update succeeds even if device sync fails (graceful degradation)
- Favorite status is local-only; devices do not broadcast favorites

**Example:**
```bash
# Mark node as favorite and sync to device
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"isFavorite": true, "syncToDevice": true}' \
  http://localhost:3001/api/nodes/!a2e4ff4c/favorite

# Remove favorite (database only)
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"isFavorite": false, "syncToDevice": false}' \
  http://localhost:3001/api/nodes/!a2e4ff4c/favorite
```

---

## Message Operations

### GET /api/messages
Get messages with pagination.

**Query Parameters:**
- `limit` (optional): Number of messages to return (default: 100)
- `offset` (optional): Number of messages to skip (default: 0)

**Example:**
```
GET /api/messages?limit=50&offset=100
```

### GET /api/messages/channel/:channel
Get messages for a specific channel.

**Path Parameters:**
- `channel`: Channel number (0-7)

**Query Parameters:**
- `limit` (optional): Number of messages to return (default: 100)

**Example:**
```
GET /api/messages/channel/0?limit=50
```

### GET /api/messages/direct/:nodeId1/:nodeId2
Get direct messages between two nodes.

**Path Parameters:**
- `nodeId1`: First node ID (e.g., "!075bcd15")
- `nodeId2`: Second node ID (e.g., "!a1b2c3d4")

**Query Parameters:**
- `limit` (optional): Number of messages to return (default: 100)

### POST /api/messages/send
Send a text message to the mesh network.

**Request Body:**
```json
{
  "text": "Hello, mesh network!",
  "toNodeId": "!ffffffff",
  "channelIndex": 0,
  "wantResponse": false
}
```

**Parameters:**
- `text` (required): Message text
- `toNodeId` (required): Destination node ID ("!ffffffff" for broadcast)
- `channelIndex` (optional): Channel to send on (default: 0)
- `wantResponse` (optional): Request acknowledgment (default: false)

**Response:**
```json
{
  "success": true,
  "messageId": "123456789-1641995200"
}
```

---

## Channel Management

### GET /api/channels
Get all configured channels.

**Response:**
```json
[
  {
    "id": 0,
    "name": "Primary",
    "psk": null,
    "uplinkEnabled": true,
    "downlinkEnabled": true,
    "createdAt": 1640990000,
    "updatedAt": 1641995200
  }
]
```

### GET /api/channels/debug
Debug endpoint showing channel information from both database and device.

**Response:**
```json
{
  "dbChannels": [...],
  "deviceChannels": [...],
  "channelCount": 2
}
```

### POST /api/channels/refresh
Refresh channel information from the Meshtastic device.

**Response:**
```json
{
  "success": true,
  "message": "Channels refreshed successfully",
  "channels": 2
}
```

### POST /api/cleanup/channels
Clean up empty or unused channels.

**Response:**
```json
{
  "deleted": 3,
  "message": "Cleaned up 3 empty channels"
}
```

---

## Telemetry Data

### GET /api/telemetry/:nodeId
Get telemetry data for a specific node.

**Path Parameters:**
- `nodeId`: Node ID (e.g., "!075bcd15")

**Query Parameters:**
- `hours` (optional): Number of hours of history (default: 24)
- `limit` (optional): Maximum records to return (default: 1000)

**Example:**
```
GET /api/telemetry/!075bcd15?hours=48
```

**Response:**
```json
[
  {
    "id": 1,
    "nodeId": "!075bcd15",
    "nodeNum": 123456789,
    "telemetryType": "batteryLevel",
    "timestamp": 1641995200000,
    "value": 85.5,
    "unit": "%",
    "createdAt": 1641995201000
  }
]
```

### GET /api/telemetry/available/nodes
Get list of nodes that have telemetry data.

**Response:**
```json
{
  "nodes": [
    {
      "nodeId": "!075bcd15",
      "nodeNum": 123456789,
      "longName": "Base Station Alpha",
      "types": ["batteryLevel", "voltage", "channelUtilization"],
      "latestTimestamp": 1641995200000,
      "dataPoints": 150
    }
  ]
}
```

### POST /api/purge/telemetry
Delete all telemetry data from the database.

**Request Body:** None required

**Response:**
```json
{
  "success": true,
  "message": "All telemetry data purged"
}
```

---

## Traceroute Operations

### POST /api/traceroute
Initiate a traceroute to a specific node.

**Request Body:**
```json
{
  "toNodeNum": 987654321
}
```

**Response:**
```json
{
  "success": true,
  "message": "Traceroute sent to node 987654321"
}
```

### GET /api/traceroutes/recent
Get recent traceroute results.

**Query Parameters:**
- `limit` (optional): Number of traceroutes to return (default: 20)

**Response:**
```json
[
  {
    "id": 1,
    "fromNodeNum": 123456789,
    "toNodeNum": 987654321,
    "fromNodeId": "!075bcd15",
    "toNodeId": "!3ade68b1",
    "route": "[123456789,555555555,987654321]",
    "routeBack": "[987654321,555555555,123456789]",
    "snrTowards": "[12.5,8.3,10.1]",
    "snrBack": "[10.5,9.2,11.3]",
    "timestamp": 1641995200000,
    "createdAt": 1641995201000
  }
]
```

---

## System Configuration

### GET /api/connection
Get current connection status.

**Response:**
```json
{
  "connected": true,
  "nodeId": "!075bcd15",
  "nodeNum": 123456789
}
```

### GET /api/config
Get application configuration.

**Response:**
```json
{
  "meshtasticHost": "192.168.1.100",
  "meshtasticTls": false,
  "fetchInterval": 2000,
  "messageRetention": 30,
  "nodeRetention": 90
}
```

### GET /api/device-config
Get Meshtastic device configuration.

**Response:**
```json
{
  "lora": {
    "region": "US",
    "hopLimit": 3,
    "txEnabled": true,
    "txPower": 30,
    "channelNum": 20
  },
  "bluetooth": {
    "enabled": false
  },
  "display": {
    "screenOnSecs": 60
  },
  "position": {
    "positionBroadcastSecs": 900,
    "gpsUpdateInterval": 30
  }
}
```

### POST /api/settings/traceroute-interval
Update the automatic traceroute interval.

**Request Body:**
```json
{
  "interval": 600000
}
```

**Response:**
```json
{
  "success": true,
  "interval": 600000,
  "message": "Traceroute interval updated to 10 minutes"
}
```

### POST /api/set-node-owner
Set the node's long name and short name.

**Request Body:**
```json
{
  "longName": "Base Station Alpha",
  "shortName": "BSA"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Node names updated successfully"
}
```

**Note:** This triggers a device reboot to apply changes.

### POST /api/set-device-config
Configure device settings including role and broadcast intervals.

**Request Body:**
```json
{
  "role": 2,
  "nodeInfoBroadcastSecs": 3600
}
```

**Parameters:**
- `role` (required, number): Device role (0=Client, 1=Client Mute, 2=Router, 3=Router Client, 4=Repeater, 5=Tracker, 6=Sensor, 7=TAK, 8=Client Hidden, 9=Lost and Found, 10=TAK Tracker, 11=Router Late, 12=Client Base)
- `nodeInfoBroadcastSecs` (required, number): Interval for broadcasting node info (minimum 3600 seconds)

**Response:**
```json
{
  "success": true,
  "message": "Device configuration updated successfully"
}
```

**Note:** This triggers a device reboot to apply changes.

### POST /api/set-lora-config
Configure LoRa radio settings.

**Request Body:**
```json
{
  "usePreset": true,
  "modemPreset": 0,
  "region": 1,
  "hopLimit": 3
}
```

**Parameters:**
- `usePreset` (optional, boolean): Use modem preset instead of custom settings
- `modemPreset` (optional, number): Modem preset (0=LONG_FAST, 1=LONG_SLOW, 2=VERY_LONG_SLOW, 3=MEDIUM_SLOW, 4=MEDIUM_FAST, 5=SHORT_SLOW, 6=SHORT_FAST, 7=LONG_MODERATE)
- `region` (optional, number): LoRa region (e.g., 1=US, 2=EU_433, 3=EU_868, etc.)
- `hopLimit` (optional, number): Maximum number of hops for mesh routing (1-7)

**Response:**
```json
{
  "success": true,
  "message": "LoRa configuration updated successfully"
}
```

**Note:** This triggers a device reboot to apply changes.

### POST /api/set-position-config
Configure position and GPS settings, including fixed position.

**Request Body:**
```json
{
  "positionBroadcastSecs": 900,
  "positionBroadcastSmartEnabled": true,
  "fixedPosition": true,
  "latitude": 40.7128,
  "longitude": -74.0060,
  "altitude": 10
}
```

**Parameters:**
- `positionBroadcastSecs` (optional, number): Position broadcast interval in seconds
- `positionBroadcastSmartEnabled` (optional, boolean): Enable smart position broadcasting
- `fixedPosition` (optional, boolean): Enable fixed position mode
- `latitude` (optional, number): Fixed latitude in decimal degrees (-90 to 90)
- `longitude` (optional, number): Fixed longitude in decimal degrees (-180 to 180)
- `altitude` (optional, number): Fixed altitude in meters

**Response:**
```json
{
  "success": true,
  "message": "Position configuration updated successfully"
}
```

**Important:** When setting a fixed position, coordinates must be sent FIRST using the internal `set_fixed_position` admin message, then the position config flag is set. This is handled automatically by the API.

**Note:** This triggers a device reboot to apply changes.

### POST /api/set-mqtt-config
Configure MQTT server and settings.

**Request Body:**
```json
{
  "enabled": true,
  "address": "mqtt.example.com",
  "username": "user",
  "password": "pass",
  "encryptionEnabled": true,
  "jsonEnabled": false,
  "root": "msh/US/2/e/"
}
```

**Parameters:**
- `enabled` (optional, boolean): Enable MQTT connection
- `address` (optional, string): MQTT server address
- `username` (optional, string): MQTT username
- `password` (optional, string): MQTT password
- `encryptionEnabled` (optional, boolean): Use encryption for MQTT messages
- `jsonEnabled` (optional, boolean): Enable JSON encoding for MQTT messages
- `root` (optional, string): MQTT root topic

**Response:**
```json
{
  "success": true,
  "message": "MQTT configuration updated successfully"
}
```

**Note:** This triggers a device reboot to apply changes.

### POST /api/reboot
Reboot the connected Meshtastic device.

**Request Body:**
```json
{
  "delay": 5
}
```

**Parameters:**
- `delay` (optional, number): Delay in seconds before reboot (default: 5)

**Response:**
```json
{
  "success": true,
  "message": "Device will reboot in 5 seconds"
}
```

---

## Data Management

### GET /api/stats
Get database statistics.

**Response:**
```json
{
  "messageCount": 5432,
  "nodeCount": 42,
  "channelCount": 3,
  "telemetryCount": 1500,
  "tracerouteCount": 25,
  "messagesByDay": [
    { "date": "2024-01-01", "count": 234 },
    { "date": "2024-01-02", "count": 456 }
  ],
  "nodesByRole": {
    "CLIENT": 20,
    "ROUTER": 15,
    "REPEATER": 7
  }
}
```

### POST /api/export
Export database data as JSON.

**Response:**
```json
{
  "nodes": [...],
  "messages": [...],
  "channels": [...],
  "telemetry": [...],
  "traceroutes": [...],
  "exportedAt": 1641995200000
}
```

### POST /api/import
Import database data from JSON.

**Request Body:**
```json
{
  "nodes": [...],
  "messages": [...],
  "channels": [...],
  "telemetry": [...],
  "traceroutes": [...]
}
```

**Response:**
```json
{
  "success": true,
  "imported": {
    "nodes": 42,
    "messages": 5432,
    "channels": 3,
    "telemetry": 1500,
    "traceroutes": 25
  }
}
```

### POST /api/cleanup/messages
Clean up old messages.

**Request Body:**
```json
{
  "days": 30
}
```

**Response:**
```json
{
  "deleted": 1234,
  "message": "Deleted 1234 messages older than 30 days"
}
```

### POST /api/cleanup/nodes
Clean up inactive nodes.

**Request Body:**
```json
{
  "days": 90
}
```

**Response:**
```json
{
  "deleted": 5,
  "message": "Deleted 5 nodes not heard from in 90 days"
}
```

### POST /api/purge/nodes
Delete ALL nodes and traceroutes from the database, then trigger a refresh (dangerous!).

**Request Body:** None required

**Response:**
```json
{
  "success": true,
  "message": "All nodes and traceroutes purged, refresh triggered"
}
```

### POST /api/purge/messages
Delete ALL messages from the database (dangerous!).

**Request Body:** None required

**Response:**
```json
{
  "success": true,
  "message": "All messages purged"
}
```

---

## Error Responses

All endpoints may return error responses in this format:

```json
{
  "error": "Error message",
  "details": "Additional error information"
}
```

**Common Status Codes:**
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `404` - Not Found
- `500` - Internal Server Error
- `503` - Service Unavailable (Meshtastic not connected)

---

## Rate Limiting

Currently, there is no rate limiting on the API. However, be mindful of:
- Database performance with large queries
- Meshtastic device limitations
- Network bandwidth when polling frequently

---

## WebSocket Support

WebSocket support is planned for future versions to provide real-time updates without polling.

---

## Authentication

Currently, the API does not require authentication. All endpoints are accessible when the application is running. Future versions may include:
- API key authentication
- JWT token support
- Role-based access control

---

## Examples

### Using cURL

```bash
# Get all nodes
curl http://localhost:3001/api/nodes

# Send a message
curl -X POST http://localhost:3001/api/messages/send \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello","toNodeId":"!ffffffff","channelIndex":0}'

# Get telemetry for a node
curl http://localhost:3001/api/telemetry/!075bcd15?hours=24

# Export database
curl -X POST http://localhost:3001/api/export > backup.json
```

### Using JavaScript/Fetch

```javascript
// Get nodes
const response = await fetch('http://localhost:3001/api/nodes');
const nodes = await response.json();

// Send message
const message = {
  text: 'Hello, mesh!',
  toNodeId: '!ffffffff',
  channelIndex: 0
};

const response = await fetch('http://localhost:3001/api/messages/send', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(message)
});
```

### Using Python

```python
import requests

# Get nodes
response = requests.get('http://localhost:3001/api/nodes')
nodes = response.json()

# Send message
message = {
    'text': 'Hello from Python!',
    'toNodeId': '!ffffffff',
    'channelIndex': 0
}

response = requests.post(
    'http://localhost:3001/api/messages/send',
    json=message
)
```

---

## Changelog

### Version 1.1.0
- Added telemetry endpoints
- Added traceroute support
- Added purge operations
- Added system status endpoint
- Added device configuration endpoint

### Version 1.0.0
- Initial API release
- Basic node and message operations
- Channel management
- Statistics and data export/import