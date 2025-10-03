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
  text: string;                      // Message content
  timestamp: Date;                   // When message was sent/received
  channel: number;                   // Channel number (0-7)
  portnum?: number;                  // Meshtastic port number
}
```

**Usage:**
- Displayed in the messages panel
- Stored in the messages database table
- Sent/received via Meshtastic HTTP API

**Special Values:**
- `to: "!ffffffff"` indicates a broadcast message
- `channel: 0` is the default/primary channel

**Example:**
```typescript
const exampleMessage: MeshMessage = {
  id: "123456789-1640995200",
  from: "!075bcd15",
  to: "!ffffffff", // Broadcast
  text: "Hello mesh network!",
  timestamp: new Date('2024-01-01T12:00:00Z'),
  channel: 0,
  portnum: 1
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
  createdAt: number;                 // Database insertion time
}
```

## Meshtastic Protocol Types

### Hardware Model Enum

Maps numeric hardware model IDs to technical names (116 models supported: 0-114 plus 255).

```typescript
const HARDWARE_MODELS: Record<number, string> = {
  1: 'TLORA_V2',
  2: 'TLORA_V1',
  3: 'TLORA_V2_1_1P6',
  4: 'TBEAM',
  5: 'HELTEC_V2_0',
  6: 'TBEAM_V0P7',
  7: 'T_ECHO',
  8: 'TLORA_V1_1P3',
  9: 'RAK4631',
  10: 'HELTEC_V2_1',
  11: 'HELTEC_V1',
  12: 'LILYGO_TBEAM_S3_CORE',
  13: 'RAK11200',
  14: 'NANO_G1',
  15: 'TLORA_V2_1_1P8',
  16: 'TLORA_T3_S3',
  17: 'NANO_G1_EXPLORER',
  18: 'NANO_G2_ULTRA',
  19: 'LORA_TYPE',
  20: 'WIPHONE',
  21: 'WIO_WM1110',
  22: 'RAK2560',
  23: 'HELTEC_HRU_3601',
  24: 'HELTEC_VISION_MASTER_T190',
  25: 'HELTEC_VISION_MASTER_E213',
  26: 'HELTEC_VISION_MASTER_E290',
  27: 'HELTEC_MESH_NODE_T114',
  28: 'SENSECAP_INDICATOR',
  29: 'TRACKER_T1000_E',
  30: 'RAK3172',
  31: 'STATION_G2',
  32: 'LR1110',
  33: 'LR1120',
  34: 'LR1121',
  35: 'RADIOMASTER_900_BANDIT_NANO',
  36: 'HELTEC_CAPSULE_SENSOR_V3',
  37: 'HELTEC_WIRELESS_TRACKER',
  38: 'HELTEC_WIRELESS_PAPER_V1_0',
  39: 'T_DECK',
  40: 'T_WATCH_S3',
  41: 'PICOMPUTER_S3',
  42: 'HELTEC_HT62',
  43: 'HELTEC_WIRELESS_PAPER',
  44: 'HELTEC_WIRELESS_TRACKER_V1_0',
  45: 'UNPHONE',
  46: 'TD_LORAC',
  47: 'CDEBYTE_EORA_S3',
  48: 'TWC_MESH_V4',
  49: 'NRF52_UNKNOWN',
  50: 'PORTDUINO',
  51: 'ANDROID_SIM',
  52: 'DIY_V1',
  53: 'NRF52840_PCA10056',
  54: 'DR_DEV',
  55: 'M5STACK',
  56: 'HELTEC_V3',
  57: 'HELTEC_WSL_V3',
  58: 'BETAFPV_2400_TX',
  59: 'BETAFPV_900_NANO_TX',
  60: 'RPI_PICO',
  61: 'SEEED_XIAO_S3',
  62: 'RADIOMASTER_900_BANDIT',
  63: 'ME_CONNECT',
  64: 'CHATTER_2',
  65: 'HELTEC_CAPSULE_SENSOR_V3',
  66: 'HELTEC_VISION_MASTER_T190',
  // ... 67-114 (additional models)
  114: 'T_WATCH_ULTRA',
  255: 'PRIVATE_HW'
};
```

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
  text: string;
  channel?: number;
  destination?: string;
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