# MeshMonitor Data Structures

## Overview

This document describes the key data structures and interfaces used throughout the MeshMonitor application. These structures define how data flows between the frontend, backend, and database layers.

## Core Type Definitions

### DeviceInfo Interface

Represents information about a Meshtastic device/node in the mesh network.

```typescript
interface DeviceInfo {
  nodeNum: number;                    // Unique numeric identifier for the node
  user?: {
    id: string;                      // Hexadecimal node ID (e.g., "!a1b2c3d4")
    longName: string;                // User-defined long name
    shortName: string;               // User-defined short name (usually 3-4 chars)
    macaddr: Uint8Array;            // MAC address bytes
    hwModel: number;                 // Hardware model enum value
    role?: number;                   // Node role (0=Client, 2=Router, 4=Repeater)
  };
  hopsAway?: number;                  // Network distance from local node
  position?: {
    latitude: number;                // GPS latitude in decimal degrees
    longitude: number;               // GPS longitude in decimal degrees
    altitude?: number;               // Altitude in meters
    time?: number;                   // Timestamp of position fix
  };
  deviceMetrics?: {
    batteryLevel?: number;           // Battery percentage (0-100)
    voltage?: number;                // Battery voltage in volts
    channelUtilization?: number;     // Channel usage percentage
    airUtilTx?: number;             // Air utilization transmit percentage
  };
  lastHeard?: number;                // Unix timestamp of last communication
  snr?: number;                      // Signal-to-noise ratio in dB
  rssi?: number;                     // Received signal strength in dBm
  firmwareVersion?: string;          // Firmware version string
  isMobile?: boolean;                // True if node has moved >1km based on position telemetry
}
```

**Usage:**
- Displayed in node cards on the frontend
- Stored in the nodes database table
- Updated via Meshtastic HTTP API polling

**Example:**
```typescript
const exampleNode: DeviceInfo = {
  nodeNum: 123456789,
  user: {
    id: "!075bcd15",
    longName: "Base Station Alpha",
    shortName: "BSA",
    macaddr: new Uint8Array([0x07, 0x5b, 0xcd, 0x15]),
    hwModel: 9, // RAK4631
    role: 2 // Router
  },
  hopsAway: 3,
  position: {
    latitude: 40.7128,
    longitude: -74.0060,
    altitude: 10,
    time: 1640995200
  },
  deviceMetrics: {
    batteryLevel: 85,
    voltage: 3.7,
    channelUtilization: 15.2,
    airUtilTx: 8.5
  },
  lastHeard: 1640995200,
  snr: 12.5,
  rssi: -45,
  firmwareVersion: "2.3.0.abc123",
  isMobile: false
};
```

### MeshMessage Interface

Represents a text message sent through the mesh network.

```typescript
interface MeshMessage {
  id: string;                        // Unique message identifier
  from: string;                      // Sender's node ID (hexadecimal)
  to: string;                        // Recipient's node ID (hexadecimal)
  fromNodeId: string;                // Sender's node ID for display
  toNodeId: string;                  // Recipient's node ID for display
  text: string;                      // Message content
  timestamp: Date;                   // When message was sent/received
  channel: number;                   // Channel number (0-7)
  portnum?: number;                  // Meshtastic port number
  acknowledged?: boolean;            // Whether message was acknowledged
  ackFailed?: boolean;               // Whether acknowledgment failed
  isLocalMessage?: boolean;          // Message originated from this node
  hopStart?: number;                 // Initial hop count for routing
  hopLimit?: number;                 // Maximum hop count for routing
  replyId?: number;                  // Message ID being replied to (for threading and tapbacks)
  emoji?: number;                    // Emoji flag: 0=normal message, 1=tapback reaction
}
```

**Usage:**
- Displayed in the messages panel with proper threading
- Stored in the messages database table
- Sent/received via Meshtastic TCP streaming protocol

**Special Values:**
- `to: "!ffffffff"` indicates a broadcast message
- `channel: 0` is the default/primary channel
- `emoji: 1` with `replyId` set indicates a tapback reaction
- `replyId` set with `emoji: 0` or `undefined` indicates a threaded reply

**Reply and Tapback Support:**
- **Normal Reply**: `replyId` set, `emoji` is 0 or undefined, `text` contains reply message
- **Tapback Reaction**: `replyId` set, `emoji: 1`, `text` contains emoji character (👍, 👎, ❓, ❗, 😂, 😢, 💩)
- **Regular Message**: `replyId` undefined, `emoji` undefined

**Example - Regular Message:**
```typescript
const regularMessage: MeshMessage = {
  id: "123456789-1640995200",
  from: "!075bcd15",
  to: "!ffffffff",
  fromNodeId: "!075bcd15",
  toNodeId: "!ffffffff",
  text: "Hello mesh network!",
  timestamp: new Date('2024-01-01T12:00:00Z'),
  channel: 0,
  portnum: 1,
  acknowledged: true,
  isLocalMessage: false
};
```

**Example - Reply Message:**
```typescript
const replyMessage: MeshMessage = {
  id: "123456789-1640995250",
  from: "!a1b2c3d4",
  to: "!075bcd15",
  fromNodeId: "!a1b2c3d4",
  toNodeId: "!075bcd15",
  text: "Thanks for the update!",
  timestamp: new Date('2024-01-01T12:01:00Z'),
  channel: 0,
  portnum: 1,
  replyId: 1640995200,  // ID of original message
  emoji: 0
};
```

**Example - Tapback Reaction:**
```typescript
const tapbackMessage: MeshMessage = {
  id: "123456789-1640995260",
  from: "!e5f6g7h8",
  to: "!075bcd15",
  fromNodeId: "!e5f6g7h8",
  toNodeId: "!075bcd15",
  text: "👍",  // Emoji character
  timestamp: new Date('2024-01-01T12:02:00Z'),
  channel: 0,
  portnum: 1,
  replyId: 1640995200,  // ID of message being reacted to
  emoji: 1  // Flag indicating this is a tapback
};
```

## Database Schema Types

### DbNode Interface

Database representation of node information with additional metadata.

```typescript
interface DbNode {
  nodeNum: number;                   // Primary key
  nodeId: string;                    // Unique node identifier
  longName: string;                  // Display name
  shortName: string;                 // Short name/call sign
  hwModel: number;                   // Hardware model enum
  role?: number;                     // Node role enum
  hopsAway?: number;                 // Network distance from local node
  macaddr?: string;                  // MAC address as string
  latitude?: number;                 // GPS coordinates
  longitude?: number;
  altitude?: number;
  batteryLevel?: number;             // Device metrics
  voltage?: number;
  channelUtilization?: number;
  airUtilTx?: number;
  lastHeard?: number;                // Radio metrics
  snr?: number;
  rssi?: number;
  firmwareVersion?: string;          // Firmware version string
  isMobile?: boolean;                // Mobile node detection (>1km movement)
  lastTracerouteRequest?: number;    // Last traceroute request timestamp
  createdAt: number;                 // Record creation timestamp
  updatedAt: number;                 // Last update timestamp
}
```

### DbMessage Interface

Database representation of mesh messages.

```typescript
interface DbMessage {
  id: string;                        // Primary key
  fromNodeNum: number;               // Foreign key to nodes table
  toNodeNum: number;                 // Foreign key to nodes table
  fromNodeId: string;                // Sender node ID for display
  toNodeId: string;                  // Recipient node ID for display
  text: string;                      // Message content
  channel: number;                   // Channel number
  portnum?: number;                  // Meshtastic port number
  timestamp: number;                 // Message timestamp (Unix)
  rxTime?: number;                   // Reception timestamp
  hopStart?: number;                 // Initial hop count for routing
  hopLimit?: number;                 // Maximum hop count for routing
  replyId?: number;                  // Message ID being replied to
  emoji?: number;                    // Emoji flag (0=normal, 1=tapback)
  createdAt: number;                 // Database insertion time
}
```

## Meshtastic Protocol Types

### Hardware Model Enum

Maps numeric hardware model IDs to technical names (116 models supported: 0-114 plus 255).

```typescript
// Representative sample - see src/constants/index.ts for complete list
const HARDWARE_MODELS: Record<number, string> = {
  0: 'UNSET',
  1: 'TLORA_V2',
  2: 'TLORA_V1',
  // ... 3-30 (classic models)
  31: 'STATION_G2',
  // ... 32-42 (additional models)
  43: 'HELTEC_V3',
  // ... 44-47
  48: 'HELTEC_WIRELESS_TRACKER',
  49: 'HELTEC_WIRELESS_PAPER',
  50: 'T_DECK',
  // ... 51-79
  80: 'M5STACK_CORES3',
  // ... 81-95
  96: 'NOMADSTAR_METEOR_PRO',
  97: 'CROWPANEL',
  // ... 98-109
  110: 'HELTEC_V4',
  111: 'M5STACK_C6L',
  112: 'M5STACK_CARDPUTER_ADV',
  113: 'HELTEC_WIRELESS_TRACKER_V2',
  114: 'T_WATCH_ULTRA',
  255: 'PRIVATE_HW'
};
```

*Complete list of 116 models available in `src/constants/index.ts`*

**Hardware Model Name Formatting:**

Technical hardware names are formatted into readable display names using `formatHardwareName()`:

```typescript
function formatHardwareName(name: string): string {
  // Splits on underscores and applies proper casing
  // Preserves abbreviations (LR, TX, RAK, NRF, etc.)
  // Maps brand names to proper capitalization
}

function getHardwareModelName(hwModel: number): string | null {
  const modelName = HARDWARE_MODELS[hwModel];
  if (!modelName) return `Unknown (${hwModel})`;
  return formatHardwareName(modelName);
}
```

**Examples:**
- `STATION_G2` → **Station G2**
- `HELTEC_WIRELESS_PAPER` → **Heltec Wireless Paper**
- `TLORA_V2_1_1P6` → **TLora V2 1 1.6**
- `BETAFPV_2400_TX` → **BetaFPV 2400 TX**
- `LILYGO_TBEAM_S3_CORE` → **Lilygo TBeam S3 Core**

### Node Role Enum

Node role types in Meshtastic mesh networks.

```typescript
enum NodeRole {
  CLIENT = 0,
  CLIENT_MUTE = 1,
  ROUTER = 2,
  ROUTER_CLIENT = 3,
  REPEATER = 4,
  TRACKER = 5,
  SENSOR = 6,
  TAK = 7,
  CLIENT_HIDDEN = 8,
  LOST_AND_FOUND = 9,
  TAK_TRACKER = 10,
  ROUTER_LATE = 11
}

const RoleNames: Record<number, string> = {
  0: 'Client',
  1: 'Client Mute',
  2: 'Router',
  3: 'Router Client',
  4: 'Repeater',
  5: 'Tracker',
  6: 'Sensor',
  7: 'TAK',
  8: 'Client Hidden',
  9: 'Lost and Found',
  10: 'TAK Tracker',
  11: 'Router Late'
};
```

### Port Numbers

Meshtastic application port numbers for different message types.

```typescript
enum PortNum {
  UNKNOWN_APP = 0,
  TEXT_MESSAGE_APP = 1,
  REMOTE_HARDWARE_APP = 2,
  POSITION_APP = 3,
  NODEINFO_APP = 4,
  ROUTING_APP = 5,
  ADMIN_APP = 6,
  TELEMETRY_APP = 67,
  ZPS_APP = 68,
  SIMULATOR_APP = 69,
  TRACEROUTE_APP = 70,
  NEIGHBORINFO_APP = 71,
  ATAK_PLUGIN = 72,
  PRIVATE_APP = 256,
  ATAK_FORWARDER = 257
}
```

## API Response Types

### Node List Response

```typescript
interface NodesResponse {
  nodes: DbNode[];
  count: number;
  lastUpdate: number;
}
```

### Message List Response

```typescript
interface MessagesResponse {
  messages: DbMessage[];
  count: number;
  hasMore: boolean;
  offset: number;
}
```

### Statistics Response

```typescript
interface StatsResponse {
  messageCount: number;
  nodeCount: number;
  messagesByDay: Array<{
    date: string;
    count: number;
  }>;
}
```

### Health Check Response

```typescript
interface HealthResponse {
  status: 'ok' | 'error';
  timestamp: string;
  nodeEnv: string;
  database?: {
    connected: boolean;
    tables: string[];
  };
}
```

### Traceroute Response

```typescript
interface TracerouteData {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string;           // JSON array: "[123456789,555555555,987654321]"
  routeBack: string;       // JSON array: "[987654321,555555555,123456789]"
  snrTowards: string;      // JSON array: "[12.5,8.3,10.1]"
  snrBack: string;         // JSON array: "[10.5,9.2,11.3]"
  routePositions?: string; // JSON object: '{"123456789":{"lat":33.12,"lng":-117.56,"alt":150}}'
                           // Snapshots node positions at traceroute completion time
                           // Null for traceroutes recorded before this feature was added
  timestamp: number;
  createdAt: number;
}
```

## Frontend State Types

### Connection Status

```typescript
type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';
```

### Application State

```typescript
interface AppState {
  nodes: DeviceInfo[];
  messages: MeshMessage[];
  connectionStatus: ConnectionStatus;
  deviceInfo: DeviceInfo | null;
  error: string | null;
  nodeAddress: string;
  newMessage: string;
}
```

## Data Transformation Patterns

### Database to Frontend Conversion

```typescript
// Convert database node to frontend DeviceInfo
function dbNodeToDeviceInfo(dbNode: DbNode): DeviceInfo {
  return {
    nodeNum: dbNode.nodeNum,
    user: {
      id: dbNode.nodeId,
      longName: dbNode.longName || 'Unknown',
      shortName: dbNode.shortName || 'UNK',
      macaddr: new Uint8Array(),
      hwModel: dbNode.hwModel || 0,
    },
    position: dbNode.latitude && dbNode.longitude ? {
      latitude: dbNode.latitude,
      longitude: dbNode.longitude,
      altitude: dbNode.altitude,
      time: dbNode.lastHeard,
    } : undefined,
    deviceMetrics: {
      batteryLevel: dbNode.batteryLevel,
      voltage: dbNode.voltage,
      channelUtilization: dbNode.channelUtilization,
      airUtilTx: dbNode.airUtilTx,
    },
    lastHeard: dbNode.lastHeard,
    snr: dbNode.snr,
    rssi: dbNode.rssi,
  };
}

// Convert database message to frontend MeshMessage
function dbMessageToMeshMessage(dbMessage: DbMessage): MeshMessage {
  return {
    id: dbMessage.id,
    from: dbMessage.fromNodeId,
    to: dbMessage.toNodeId,
    text: dbMessage.text,
    timestamp: new Date(dbMessage.timestamp),
    channel: dbMessage.channel,
    portnum: dbMessage.portnum,
  };
}
```

### Frontend to Database Conversion

```typescript
// Convert frontend DeviceInfo to database DbNode
function deviceInfoToDbNode(deviceInfo: DeviceInfo): Partial<DbNode> {
  return {
    nodeNum: deviceInfo.nodeNum,
    nodeId: deviceInfo.user?.id || nodeNumToId(deviceInfo.nodeNum),
    longName: deviceInfo.user?.longName,
    shortName: deviceInfo.user?.shortName,
    hwModel: deviceInfo.user?.hwModel,
    role: deviceInfo.user?.role,
    hopsAway: deviceInfo.hopsAway,
    latitude: deviceInfo.position?.latitude,
    longitude: deviceInfo.position?.longitude,
    altitude: deviceInfo.position?.altitude,
    batteryLevel: deviceInfo.deviceMetrics?.batteryLevel,
    voltage: deviceInfo.deviceMetrics?.voltage,
    channelUtilization: deviceInfo.deviceMetrics?.channelUtilization,
    airUtilTx: deviceInfo.deviceMetrics?.airUtilTx,
    lastHeard: deviceInfo.lastHeard,
    snr: deviceInfo.snr,
    rssi: deviceInfo.rssi,
  };
}

// Convert frontend MeshMessage to database DbMessage
function meshMessageToDbMessage(message: MeshMessage): DbMessage {
  return {
    id: message.id,
    fromNodeNum: parseInt(message.from.replace('!', ''), 16),
    toNodeNum: parseInt(message.to.replace('!', ''), 16),
    fromNodeId: message.from,
    toNodeId: message.to,
    text: message.text,
    channel: message.channel,
    portnum: message.portnum,
    timestamp: message.timestamp.getTime(),
    createdAt: Date.now(),
  };
}
```

## Utility Functions

### Node ID Conversion

```typescript
// Convert numeric node number to hexadecimal ID string
function nodeNumToId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

// Convert hexadecimal ID string to numeric node number
function nodeIdToNum(nodeId: string): number {
  return parseInt(nodeId.replace('!', ''), 16);
}
```

### Timestamp Utilities

```typescript
// Convert Unix timestamp to JavaScript Date
function unixToDate(timestamp: number): Date {
  return new Date(timestamp * 1000);
}

// Convert JavaScript Date to Unix timestamp
function dateToUnix(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

// Format timestamp for display
function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleTimeString();
}
```

## Data Validation

### Input Validation Types

```typescript
// Validation schemas for API inputs
interface NodeUpdateRequest {
  nodeNum: number;
  longName?: string;
  shortName?: string;
  // ... other optional fields
}

interface MessageSendRequest {
  text: string;                      // Message text content (required)
  channel?: number;                  // Channel number (0-7, default: 0)
  destination?: string;              // Node ID for direct message (optional)
  replyId?: number;                  // Message ID being replied to (optional)
  emoji?: number;                    // Emoji flag: 0=normal, 1=tapback (optional)
}

interface CleanupRequest {
  days: number;
  dryRun?: boolean;
}
```

### Validation Functions

```typescript
// Validate node ID format
function isValidNodeId(nodeId: string): boolean {
  return /^![0-9a-fA-F]{8}$/.test(nodeId);
}

// Validate channel number
function isValidChannel(channel: number): boolean {
  return Number.isInteger(channel) && channel >= 0 && channel <= 7;
}

// Validate message text
function isValidMessageText(text: string): boolean {
  return typeof text === 'string' && text.length > 0 && text.length <= 237;
}

// Validate node role
function isValidRole(role: number): boolean {
  return Number.isInteger(role) && role >= 0 && role <= 11;
}

// Parse traceroute route array
function parseRouteArray(route: string): number[] {
  try {
    return JSON.parse(route);
  } catch {
    return [];
  }
}
```

## Traceroute Data Structures

### Route Segment

```typescript
interface RouteSegment {
  fromNodeNum: number;
  toNodeNum: number;
  snr?: number;
  distance?: number;
  fromLatitude?: number;   // Position snapshot at recording time
  fromLongitude?: number;
  toLatitude?: number;
  toLongitude?: number;
}
```

### Route Path

```typescript
interface RoutePath {
  nodes: number[];         // Array of node numbers in order
  snrValues: number[];     // SNR value for each hop
  totalHops: number;
  averageSnr: number;
}
```

### Network Topology

```typescript
interface NetworkTopology {
  nodes: Map<number, DeviceInfo>;
  routes: Map<string, RouteSegment[]>;
  lastUpdated: number;
}
```

### Map Visualization Data

```typescript
interface MapRouteData {
  key: string;                    // Unique identifier for route segment
  positions: [number, number][];  // [lat, lng] coordinates
  nodeNums: number[];             // Node numbers in segment
  weight: number;                 // Line thickness (2-8)
  color: string;                  // Line color
  opacity: number;                // Line opacity
}
```

This comprehensive data structure documentation ensures consistent data handling across all layers of the MeshMonitor application.