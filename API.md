# MeshMonitor API Documentation

This document provides comprehensive documentation for the MeshMonitor REST API.

## Base URL

- **Development**: `http://localhost:3001`
- **Production**: `http://localhost:8080` (when using Docker)

All API endpoints are prefixed with `/api/`.

## Authentication

Currently, MeshMonitor does not implement authentication. All endpoints are publicly accessible.

## Response Format

All API responses follow a consistent JSON format:

**Success Response:**
```json
{
  "data": { ... },
  "status": "success"
}
```

**Error Response:**
```json
{
  "error": "Error message description",
  "status": "error"
}
```

## Endpoints

### Node Management

#### GET /api/nodes
Retrieve all nodes from the database.

**Response:**
```json
[
  {
    "nodeNum": 3748313172,
    "user": {
      "id": "!df6ab854",
      "longName": "K4FAU",
      "shortName": "K4FA",
      "hwModel": 0
    },
    "position": {
      "latitude": 25.7617,
      "longitude": -80.1918,
      "altitude": 10
    },
    "deviceMetrics": {
      "batteryLevel": 95,
      "voltage": 4.1,
      "channelUtilization": 0.5,
      "airUtilTx": 0.2
    },
    "lastHeard": 1758835127.284,
    "snr": 8.5,
    "rssi": -45
  }
]
```

#### GET /api/nodes/active
Get nodes that have been active within a specified time frame.

**Query Parameters:**
- `days` (optional): Number of days to look back (default: 7)

**Example:** `/api/nodes/active?days=3`

**Response:** Same format as `/api/nodes`

### Message Management

#### GET /api/messages
Retrieve messages with pagination support.

**Query Parameters:**
- `limit` (optional): Maximum number of messages to return (default: 100)
- `offset` (optional): Number of messages to skip (default: 0)

**Example:** `/api/messages?limit=50&offset=100`

**Response:**
```json
[
  {
    "id": "msg_1234567890",
    "from": "!df6ab854",
    "to": "!ffffffff",
    "text": "Hello mesh network!",
    "channel": 0,
    "portnum": 1,
    "timestamp": "2024-01-15T10:30:00.000Z",
    "rxTime": 1642248600000,
    "createdAt": 1642248600000
  }
]
```

#### POST /api/messages/send
Send a text message to a channel.

**Request Body:**
```json
{
  "text": "Hello mesh network!",
  "channel": 0
}
```

**Response:**
```json
{
  "success": true
}
```

**Error Responses:**
- `400`: Missing or invalid message text
- `500`: Failed to send message

#### GET /api/messages/channel/:channel
Get messages from a specific channel.

**Path Parameters:**
- `channel`: Channel number (integer)

**Query Parameters:**
- `limit` (optional): Maximum messages to return (default: 100)

**Example:** `/api/messages/channel/0?limit=20`

**Response:** Same format as `/api/messages`

#### GET /api/messages/direct/:nodeId1/:nodeId2
Get direct messages between two nodes.

**Path Parameters:**
- `nodeId1`: First node ID (string)
- `nodeId2`: Second node ID (string)

**Query Parameters:**
- `limit` (optional): Maximum messages to return (default: 100)

**Example:** `/api/messages/direct/!df6ab854/!a2e4ff4c`

**Response:** Same format as `/api/messages`

### Channel Management

#### GET /api/channels
Retrieve all configured channels.

**Response:**
```json
[
  {
    "id": 0,
    "name": "Primary",
    "psk": null,
    "uplinkEnabled": true,
    "downlinkEnabled": true,
    "createdAt": 1642248600000,
    "updatedAt": 1642248600000
  },
  {
    "id": 1,
    "name": "admin",
    "psk": "encrypted_key",
    "uplinkEnabled": true,
    "downlinkEnabled": true,
    "createdAt": 1642248600000,
    "updatedAt": 1642248600000
  }
]
```

### Traceroute Management

#### GET /api/traceroutes/recent
Get recently collected traceroute data with route paths and SNR information.

**Query Parameters:**
- `hours` (optional): Hours to look back (default: 24)
- `limit` (optional): Maximum number of traceroutes to return (default: 100)

**Example:** `/api/traceroutes/recent?hours=12&limit=50`

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
    "timestamp": 1640995200000,
    "createdAt": 1640995201000
  }
]
```

#### POST /api/traceroutes/send
Send a traceroute request to a specific node.

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

### System Information

#### GET /api/health
Health check endpoint for monitoring system status.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T10:30:00.000Z",
  "nodeEnv": "production"
}
```

#### GET /api/connection
Get the current Meshtastic node connection status.

**Response:**
```json
{
  "connected": true,
  "nodeIp": "192.168.1.100"
}
```

#### GET /api/config
Get application configuration.

**Response:**
```json
{
  "meshtasticNodeIp": "192.168.1.100",
  "meshtasticUseTls": false
}
```

#### GET /api/device-config
Get Meshtastic device configuration.

**Response:**
```json
{
  "basic": {
    "nodeAddress": "192.168.1.100",
    "useTls": false,
    "connected": true
  },
  "radio": {
    "region": "US",
    "modemPreset": "Medium_Fast",
    "hopLimit": 3,
    "txPower": 30,
    "bandwidth": 250,
    "spreadFactor": 9,
    "codingRate": 8
  },
  "mqtt": {
    "enabled": true,
    "server": "mqtt.areyoumeshingwith.us",
    "username": "uplink",
    "encryption": true,
    "json": true,
    "tls": true,
    "rootTopic": "msh"
  },
  "channels": [
    {
      "index": 0,
      "name": "Primary",
      "psk": "None",
      "uplinkEnabled": true,
      "downlinkEnabled": true
    }
  ]
}
```

### Statistics

#### GET /api/stats
Get database and network statistics.

**Response:**
```json
{
  "messageCount": 1250,
  "nodeCount": 45,
  "channelCount": 4,
  "messagesByDay": [
    {
      "date": "2024-01-15",
      "count": 125
    },
    {
      "date": "2024-01-14",
      "count": 98
    }
  ]
}
```

### Data Management

#### POST /api/export
Export all database data for backup purposes.

**Response:**
```json
{
  "nodes": [ ... ],
  "messages": [ ... ]
}
```

**Note:** Response can be large depending on database size.

#### POST /api/import
Import data to restore from backup.

**Request Body:**
```json
{
  "nodes": [ ... ],
  "messages": [ ... ]
}
```

**Response:**
```json
{
  "success": true
}
```

**Warning:** This operation will clear existing data before importing.

### Cleanup Operations

#### POST /api/cleanup/messages
Clean up old messages from the database.

**Request Body:**
```json
{
  "days": 30
}
```

**Response:**
```json
{
  "deletedCount": 145
}
```

#### POST /api/cleanup/nodes
Clean up inactive nodes from the database.

**Request Body:**
```json
{
  "days": 30
}
```

**Response:**
```json
{
  "deletedCount": 12
}
```

#### POST /api/cleanup/channels
Clean up invalid channels from the database.

**Response:**
```json
{
  "deletedCount": 8
}
```

## Error Codes

### HTTP Status Codes

- `200` - Success
- `400` - Bad Request (invalid parameters)
- `404` - Not Found
- `500` - Internal Server Error
- `503` - Service Unavailable (Meshtastic node unreachable)

### Common Error Messages

- `"Failed to fetch nodes"` - Database error when retrieving nodes
- `"Failed to send message"` - Error communicating with Meshtastic node
- `"Message text is required"` - Missing required message text in request
- `"Unable to retrieve device configuration"` - Meshtastic node communication error
- `"Failed to cleanup [resource]"` - Database error during cleanup operations

## Rate Limiting

Currently, no rate limiting is implemented. Consider implementing rate limiting for production deployments.

## WebSocket Support

WebSocket support is planned for future releases to provide real-time updates without polling.

## Data Types

### Node Data
```typescript
interface DeviceInfo {
  nodeNum: number;
  user?: {
    id: string;
    longName: string;
    shortName: string;
    hwModel?: number;
    role?: number;
  };
  hopsAway?: number;
  position?: {
    latitude: number;
    longitude: number;
    altitude?: number;
  };
  deviceMetrics?: {
    batteryLevel?: number;
    voltage?: number;
    channelUtilization?: number;
    airUtilTx?: number;
  };
  lastHeard?: number;
  snr?: number;
  rssi?: number;
}
```

### Message Data
```typescript
interface MeshMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  channel: number;
  portnum?: number;
  timestamp: Date;
  rxTime?: number;
  createdAt: number;
}
```

### Channel Data
```typescript
interface Channel {
  id: number;
  name: string;
  psk?: string;
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
}
```

## Usage Examples

### JavaScript/Node.js
```javascript
// Fetch all nodes
const response = await fetch('/api/nodes');
const nodes = await response.json();

// Send a message
const response = await fetch('/api/messages/send', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    text: 'Hello mesh!',
    channel: 0
  })
});

// Get channel messages
const response = await fetch('/api/messages/channel/0?limit=50');
const messages = await response.json();
```

### cURL
```bash
# Get all nodes
curl http://localhost:8080/api/nodes

# Send a message
curl -X POST http://localhost:8080/api/messages/send \
  -H "Content-Type: application/json" \
  -d '{"text":"Hello mesh!","channel":0}'

# Get statistics
curl http://localhost:8080/api/stats

# Cleanup old messages
curl -X POST http://localhost:8080/api/cleanup/messages \
  -H "Content-Type: application/json" \
  -d '{"days":30}'

# Get recent traceroutes
curl http://localhost:8080/api/traceroutes/recent?hours=24

# Send traceroute to a node
curl -X POST http://localhost:8080/api/traceroutes/send \
  -H "Content-Type: application/json" \
  -d '{"destination":"!12345678"}'
```

## Development

When developing with the API:

1. **CORS**: Enabled for all origins in development
2. **Hot Reload**: Server restarts automatically during development
3. **Logging**: All requests/responses are logged to console
4. **Error Handling**: Comprehensive error logging for debugging

## Security Considerations

1. **Input Validation**: All inputs are validated before processing
2. **SQL Injection**: Prevented through parameterized queries
3. **XSS Protection**: Text content is properly sanitized
4. **CORS Policy**: Configure appropriately for production

---

For more information, see the [Architecture Documentation](ARCHITECTURE.md) and [README](README.md).