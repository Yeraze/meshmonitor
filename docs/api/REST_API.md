# MeshMonitor REST API Documentation

## Overview

The MeshMonitor API provides RESTful endpoints for managing Meshtastic mesh network data. All endpoints return JSON responses and follow standard HTTP status codes.

**Base URL:** `http://localhost:8080/api` (production) or `http://localhost:3001/api` (development)

**Content Type:** All requests and responses use `application/json`

## Authentication

Currently, the API does not require authentication. All endpoints are publicly accessible when the application is running.

## Error Handling

The API uses standard HTTP status codes and returns error responses in the following format:

```json
{
  "error": "Error message description",
  "details": "Optional detailed error information"
}
```

**Common Status Codes:**
- `200` - Success
- `400` - Bad Request (invalid parameters)
- `404` - Not Found
- `500` - Internal Server Error

## Endpoints

### Health Check

#### GET /api/health

Returns the current health status of the application.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "nodeEnv": "production"
}
```

**Example:**
```bash
curl -X GET http://localhost:8080/api/health
```

---

## Node Management

### Get All Nodes

#### GET /api/nodes

Retrieves all nodes from the database.

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
    "hopsAway": 3,
    "macaddr": null,
    "latitude": 40.7128,
    "longitude": -74.0060,
    "altitude": 10,
    "batteryLevel": 85,
    "voltage": 3.7,
    "channelUtilization": 15.2,
    "airUtilTx": 8.5,
    "lastHeard": 1640995200,
    "snr": 12.5,
    "rssi": -45,
    "createdAt": 1640990000,
    "updatedAt": 1640995200
  }
]
```

**Example:**
```bash
curl -X GET http://localhost:8080/api/nodes
```

### Get Active Nodes

#### GET /api/nodes/active

Retrieves nodes that have been active within a specified time period.

**Query Parameters:**
- `days` (optional, integer): Number of days to look back (default: 7)

**Response:**
Same as `/api/nodes` but filtered for recent activity.

**Example:**
```bash
# Get nodes active in the last 3 days
curl -X GET "http://localhost:8080/api/nodes/active?days=3"
```

### Set Node Favorite Status

#### POST /api/nodes/:nodeId/favorite

Sets or removes favorite status for a node, with optional synchronization to the Meshtastic device.

**Path Parameters:**
- `nodeId` (required, string): Node ID (e.g., "!a2e4ff4c")

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

**Response:**
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

**Device Sync Status:**
- `success` - Successfully synced to device
- `failed` - Device sync failed (includes error message)
- `skipped` - Device sync was not attempted (syncToDevice=false)

**Response with Device Sync Failure:**
```json
{
  "success": true,
  "nodeNum": 2732916556,
  "isFavorite": false,
  "deviceSync": {
    "status": "failed",
    "error": "Not connected to Meshtastic node"
  }
}
```

**Error Responses:**
- `400`: Missing or invalid nodeId
- `400`: Missing or invalid isFavorite parameter
- `500`: Failed to update database

**Example:**
```bash
# Mark node as favorite and sync to device
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"isFavorite": true, "syncToDevice": true}' \
  http://localhost:8080/api/nodes/!a2e4ff4c/favorite

# Remove favorite (database only, no device sync)
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"isFavorite": false, "syncToDevice": false}' \
  http://localhost:8080/api/nodes/!a2e4ff4c/favorite
```

**Notes:**
- Database update succeeds even if device sync fails (graceful degradation)
- Device sync uses Meshtastic admin messages (ADMIN_APP portnum 6)
- Local TCP connections do not require session passkeys (admin.proto fields 39/40)
- Requires firmware version >= 2.7.0 for device favorites support
- Frontend displays sync status in browser console
- Favorite status is local-only; devices do not broadcast favorite status in NodeInfo

---

## Message Management

### Get Messages

#### GET /api/messages

Retrieves messages with pagination support.

**Query Parameters:**
- `limit` (optional, integer): Maximum number of messages to return (default: 100, max: 1000)
- `offset` (optional, integer): Number of messages to skip (default: 0)

**Response:**
```json
[
  {
    "id": "123456789-1640995200",
    "fromNodeNum": 123456789,
    "toNodeNum": 4294967295,
    "fromNodeId": "!075bcd15",
    "toNodeId": "!ffffffff",
    "text": "Hello mesh network!",
    "channel": 0,
    "portnum": 1,
    "timestamp": 1640995200000,
    "rxTime": 1640995201,
    "createdAt": 1640995201000
  }
]
```

**Example:**
```bash
# Get latest 50 messages
curl -X GET "http://localhost:8080/api/messages?limit=50&offset=0"
```

### Get Channel Messages

#### GET /api/messages/channel/:channel

Retrieves messages for a specific channel.

**Path Parameters:**
- `channel` (required, integer): Channel number (0-7)

**Query Parameters:**
- `limit` (optional, integer): Maximum number of messages to return (default: 100)

**Response:**
Same format as `/api/messages` but filtered by channel.

**Example:**
```bash
# Get messages from channel 1
curl -X GET http://localhost:8080/api/messages/channel/1
```

### Get Direct Messages

#### GET /api/messages/direct/:nodeId1/:nodeId2

Retrieves direct messages between two specific nodes.

**Path Parameters:**
- `nodeId1` (required, string): First node ID (e.g., "!075bcd15")
- `nodeId2` (required, string): Second node ID (e.g., "!a1b2c3d4")

**Query Parameters:**
- `limit` (optional, integer): Maximum number of messages to return (default: 100)

**Response:**
Same format as `/api/messages` but filtered for messages between the specified nodes.

**Example:**
```bash
# Get direct messages between two nodes
curl -X GET http://localhost:8080/api/messages/direct/!075bcd15/!a1b2c3d4
```

### Delete Single Message

#### DELETE /api/messages/:id

Deletes a single message by ID. Requires appropriate permissions based on message type.

**Authentication:** Required

**Permissions:**
- `messages:write` - Required for deleting direct messages
- `channels:write` - Required for deleting channel messages
- Admin users can delete any message

**Path Parameters:**
- `id` (required, string): Message ID to delete

**Response:**
```json
{
  "message": "Message deleted successfully",
  "id": "123456789-1640995200"
}
```

**Error Responses:**
- `403`: Insufficient permissions
- `404`: Message not found
- `500`: Internal server error

**Example:**
```bash
curl -X DELETE http://localhost:8080/api/messages/msg_123456
```

**Notes:**
- Permission check is based on whether the message is in a channel (channel > 0) or a direct message
- Audit log entry is created for all deletions

### Purge Channel Messages

#### DELETE /api/messages/channels/:channelId

Deletes all messages from a specific channel.

**Authentication:** Required

**Permissions:**
- `channels:write` - Required for purging channel messages
- Admin users bypass permission check

**Path Parameters:**
- `channelId` (required, integer): Channel ID (0-7)

**Response:**
```json
{
  "message": "Channel messages purged successfully",
  "channelId": 0,
  "deletedCount": 150
}
```

**Error Responses:**
- `400`: Invalid channel ID
- `403`: Insufficient permissions (requires channels:write)
- `500`: Internal server error

**Example:**
```bash
curl -X DELETE http://localhost:8080/api/messages/channels/0
```

**Notes:**
- This is a destructive operation that cannot be undone
- Audit log entry is created with deletion count

### Purge Direct Messages

#### DELETE /api/messages/direct-messages/:nodeNum

Deletes all direct messages with a specific node.

**Authentication:** Required

**Permissions:**
- `messages:write` - Required for purging direct messages
- Admin users bypass permission check

**Path Parameters:**
- `nodeNum` (required, integer): Node number to purge messages with

**Response:**
```json
{
  "message": "Direct messages purged successfully",
  "nodeNum": 123456789,
  "deletedCount": 45
}
```

**Error Responses:**
- `400`: Invalid node number
- `403`: Insufficient permissions (requires messages:write)
- `500`: Internal server error

**Example:**
```bash
curl -X DELETE http://localhost:8080/api/messages/direct-messages/123456789
```

**Notes:**
- Deletes all messages where the specified node is either sender or recipient
- Excludes broadcast messages (toNodeId != '!ffffffff')
- This is a destructive operation that cannot be undone
- Audit log entry is created with deletion count

---

## Statistics

### Get System Statistics

#### GET /api/stats

Returns statistical information about the system and data.

**Response:**
```json
{
  "messageCount": 1250,
  "nodeCount": 15,
  "messagesByDay": [
    {
      "date": "2024-01-01",
      "count": 45
    },
    {
      "date": "2024-01-02",
      "count": 67
    }
  ]
}
```

**Example:**
```bash
curl -X GET http://localhost:8080/api/stats
```

---

## Data Management

### Export Data

#### POST /api/export

Exports all system data for backup purposes.

**Response:**
```json
{
  "nodes": [
    {
      "nodeNum": 123456789,
      "nodeId": "!075bcd15",
      // ... full node data
    }
  ],
  "messages": [
    {
      "id": "123456789-1640995200",
      "fromNodeNum": 123456789,
      // ... full message data
    }
  ]
}
```

**Example:**
```bash
curl -X POST http://localhost:8080/api/export > backup.json
```

### Import Data

#### POST /api/import

Imports data from a backup file. **Warning:** This replaces all existing data.

**Request Body:**
```json
{
  "nodes": [
    // Array of node objects
  ],
  "messages": [
    // Array of message objects
  ]
}
```

**Response:**
```json
{
  "success": true
}
```

**Example:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d @backup.json \
  http://localhost:8080/api/import
```

---

## Traceroute Management

### Get Recent Traceroutes

#### GET /api/traceroutes/recent

Retrieves recent traceroute data with route paths and SNR information for network topology visualization.

**Query Parameters:**
- `hours` (optional, integer): Number of hours to look back (default: 24)
- `limit` (optional, integer): Maximum number of traceroutes to return (default: 100)

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
    "routePositions": "{\"123456789\":{\"lat\":33.1234,\"lng\":-117.5678,\"alt\":150},\"555555555\":{\"lat\":33.1500,\"lng\":-117.6000},\"987654321\":{\"lat\":33.2345,\"lng\":-117.6789}}",
    "timestamp": 1640995200000,
    "createdAt": 1640995201000
  }
]
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `routePositions` | string (nullable) | JSON object mapping node numbers to `{lat, lng, alt?}` positions at traceroute completion time. Used to render historical traceroutes at correct positions even when nodes move. Null for traceroutes recorded before v3.5.0. |

**Example:**
```bash
# Get traceroutes from last 12 hours
curl -X GET "http://localhost:8080/api/traceroutes/recent?hours=12&limit=50"
```

### Send Traceroute

#### POST /api/traceroutes/send

Manually trigger a traceroute request to a specific node to discover the network path.

**Request Body:**
```json
{
  "destination": "!3ade68b1"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Traceroute sent to !3ade68b1"
}
```

**Error Responses:**
- `400`: Missing or invalid destination node ID
- `500`: Failed to send traceroute

**Example:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"destination":"!3ade68b1"}' \
  http://localhost:8080/api/traceroutes/send
```

**Notes:**
- Traceroutes are automatically scheduled every 3 minutes by the system
- Manual traceroutes can be useful for immediate path discovery
- Results are stored in the database for historical analysis

---

## Data Cleanup

### Cleanup Old Messages

#### POST /api/cleanup/messages

Removes messages older than the specified number of days.

**Request Body:**
```json
{
  "days": 30
}
```

**Response:**
```json
{
  "deletedCount": 150
}
```

**Example:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"days": 30}' \
  http://localhost:8080/api/cleanup/messages
```

### Cleanup Inactive Nodes

#### POST /api/cleanup/nodes

Removes nodes that haven't been heard from in the specified number of days.

**Request Body:**
```json
{
  "days": 90
}
```

**Response:**
```json
{
  "deletedCount": 3
}
```

**Example:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"days": 90}' \
  http://localhost:8080/api/cleanup/nodes
```

---

## Notification Management

### Web Push Notifications

#### GET /api/push/vapid-key

Get the public VAPID key for Web Push subscriptions.

**Authentication:** Optional

**Response:**
```json
{
  "publicKey": "BKxJ3F..."
}
```

#### GET /api/push/status

Get Web Push notification service status.

**Authentication:** Optional

**Response:**
```json
{
  "available": true,
  "hasKeys": true
}
```

#### POST /api/push/subscribe

Subscribe to Web Push notifications.

**Authentication:** Optional

**Request Body:**
```json
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/...",
    "keys": {
      "p256dh": "BL7ELU...",
      "auth": "8eeIz4..."
    }
  }
}
```

**Response:**
```json
{
  "success": true
}
```

#### POST /api/push/unsubscribe

Unsubscribe from Web Push notifications.

**Authentication:** Optional

**Request Body:**
```json
{
  "endpoint": "https://fcm.googleapis.com/..."
}
```

**Response:**
```json
{
  "success": true
}
```

#### POST /api/push/test

Send a test Web Push notification (admin only).

**Authentication:** Admin required

**Response:**
```json
{
  "success": true,
  "sent": 2,
  "failed": 0
}
```

#### GET /api/push/preferences

Get current user's notification preferences.

**Authentication:** Required

**Response:**
```json
{
  "enableWebPush": true,
  "enableApprise": false,
  "enabledChannels": [0, 1, 2],
  "enableDirectMessages": true,
  "whitelist": ["Help", "Emergency"],
  "blacklist": ["Test", "Copy"]
}
```

#### POST /api/push/preferences

Update notification preferences.

**Authentication:** Required

**Request Body:**
```json
{
  "enableWebPush": true,
  "enableApprise": true,
  "enabledChannels": [0, 1, 2],
  "enableDirectMessages": true,
  "whitelist": ["Help", "Emergency"],
  "blacklist": ["Test", "Copy"]
}
```

**Response:**
```json
{
  "success": true
}
```

**Notes:**
- Filtering preferences apply to both Web Push and Apprise
- **Priority order**: Whitelist (highest) → Blacklist → Channel/DM settings
- Empty arrays disable that filter type

### Apprise Notifications

#### GET /api/apprise/status

Get Apprise notification service status.

**Authentication:** Admin required

**Response:**
```json
{
  "available": true,
  "enabled": true,
  "url": "http://apprise-api:8000"
}
```

#### POST /api/apprise/test

Test Apprise notification service connection.

**Authentication:** Admin required

**Response:**
```json
{
  "success": true,
  "message": "Apprise API is reachable",
  "details": {
    "version": "1.0.0"
  }
}
```

**Error Response:**
```json
{
  "success": false,
  "message": "Connection failed: ECONNREFUSED"
}
```

#### GET /api/apprise/urls

Get configured Apprise notification URLs (admin only).

**Authentication:** Admin required

**Response:**
```json
{
  "urls": [
    "discord://webhook_id/webhook_token",
    "slack://token_a/token_b/token_c",
    "mailto://user:password@gmail.com"
  ]
}
```

**Notes:**
- Returns empty array if no URLs configured
- URLs may contain sensitive tokens - admin access required

#### POST /api/apprise/configure

Configure Apprise notification URLs.

**Authentication:** Admin required

**Request Body:**
```json
{
  "urls": [
    "discord://webhook_id/webhook_token",
    "slack://token_a/token_b/token_c",
    "mailto://user:password@gmail.com"
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Configured 3 notification URLs"
}
```

**Error Responses:**
- `400`: Missing or invalid URLs
- `500`: Failed to configure Apprise

**Example:**
```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"urls":["discord://webhook_id/token"]}' \
  http://localhost:8080/api/apprise/configure
```

**Supported URL Formats:**
- Discord: `discord://webhook_id/webhook_token`
- Slack: `slack://token_a/token_b/token_c`
- Telegram: `tgram://bot_token/chat_id`
- Email (SMTP): `mailto://user:password@gmail.com`
- Custom Webhook: `json://webhook.example.com/path`
- See [Apprise Documentation](https://github.com/caronc/apprise) for full list

#### PUT /api/apprise/enabled

Enable or disable Apprise notifications system-wide.

**Authentication:** Admin required

**Request Body:**
```json
{
  "enabled": true
}
```

**Response:**
```json
{
  "success": true
}
```

**Notes:**
- System-wide toggle independent of per-user preferences
- Users must still enable Apprise in their own preferences

---

## WebSocket API (Future)

*Note: WebSocket endpoints are planned for future implementation to provide real-time updates.*

### Planned WebSocket Events

#### Connection Events
- `connect` - Client connects to WebSocket
- `disconnect` - Client disconnects from WebSocket

#### Data Events
- `node_update` - Node information updated
- `new_message` - New message received
- `connection_status` - Meshtastic connection status change

---

## Rate Limiting

Currently, no rate limiting is implemented. In production deployments, consider implementing:

- **Per-IP rate limiting**: 100 requests per minute
- **Export rate limiting**: 1 export per 5 minutes
- **Import rate limiting**: 1 import per 10 minutes

---

## API Client Examples

### JavaScript/TypeScript

```typescript
class MeshMonitorAPI {
  private baseURL: string;

  constructor(baseURL: string = 'http://localhost:8080/api') {
    this.baseURL = baseURL;
  }

  async getNodes(): Promise<Node[]> {
    const response = await fetch(`${this.baseURL}/nodes`);
    if (!response.ok) throw new Error('Failed to fetch nodes');
    return response.json();
  }

  async getMessages(limit = 100, offset = 0): Promise<Message[]> {
    const response = await fetch(
      `${this.baseURL}/messages?limit=${limit}&offset=${offset}`
    );
    if (!response.ok) throw new Error('Failed to fetch messages');
    return response.json();
  }

  async getStats(): Promise<Stats> {
    const response = await fetch(`${this.baseURL}/stats`);
    if (!response.ok) throw new Error('Failed to fetch stats');
    return response.json();
  }

  async exportData(): Promise<ExportData> {
    const response = await fetch(`${this.baseURL}/export`, {
      method: 'POST'
    });
    if (!response.ok) throw new Error('Failed to export data');
    return response.json();
  }
}
```

### Python

```python
import requests
from typing import List, Dict, Any

class MeshMonitorAPI:
    def __init__(self, base_url: str = "http://localhost:8080/api"):
        self.base_url = base_url

    def get_nodes(self) -> List[Dict[str, Any]]:
        response = requests.get(f"{self.base_url}/nodes")
        response.raise_for_status()
        return response.json()

    def get_messages(self, limit: int = 100, offset: int = 0) -> List[Dict[str, Any]]:
        params = {"limit": limit, "offset": offset}
        response = requests.get(f"{self.base_url}/messages", params=params)
        response.raise_for_status()
        return response.json()

    def get_stats(self) -> Dict[str, Any]:
        response = requests.get(f"{self.base_url}/stats")
        response.raise_for_status()
        return response.json()

    def export_data(self) -> Dict[str, Any]:
        response = requests.post(f"{self.base_url}/export")
        response.raise_for_status()
        return response.json()

    def cleanup_messages(self, days: int) -> Dict[str, int]:
        data = {"days": days}
        response = requests.post(f"{self.base_url}/cleanup/messages", json=data)
        response.raise_for_status()
        return response.json()
```

### cURL Examples

```bash
#!/bin/bash

API_BASE="http://localhost:8080/api"

# Get system health
curl -X GET "$API_BASE/health" | jq '.'

# Get all nodes
curl -X GET "$API_BASE/nodes" | jq '.[] | {nodeId, longName, lastHeard}'

# Get recent messages
curl -X GET "$API_BASE/messages?limit=10" | jq '.[] | {from: .fromNodeId, text, timestamp}'

# Get channel 0 messages
curl -X GET "$API_BASE/messages/channel/0?limit=5" | jq '.'

# Get system statistics
curl -X GET "$API_BASE/stats" | jq '.'

# Export data to file
curl -X POST "$API_BASE/export" > "meshmonitor_backup_$(date +%Y%m%d_%H%M%S).json"

# Cleanup old messages (older than 30 days)
curl -X POST \
  -H "Content-Type: application/json" \
  -d '{"days": 30}' \
  "$API_BASE/cleanup/messages" | jq '.'
```

---

## OpenAPI Specification

For automated API client generation, an OpenAPI 3.0 specification will be provided in future versions. This will include:

- Complete endpoint definitions
- Request/response schemas
- Parameter validation rules
- Authentication requirements
- Example requests and responses

---

## API Versioning

The current API is version 1.0. Future versions will be backward compatible where possible, with breaking changes introduced in new major versions using URL versioning (e.g., `/api/v2/`).

This API documentation provides comprehensive coverage of all available endpoints and their usage patterns for the MeshMonitor system.