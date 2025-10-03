# MeshMonitor Database Schema

## Overview

MeshMonitor uses SQLite as its persistence layer with a well-designed schema optimized for Meshtastic mesh network data. The database employs WAL (Write-Ahead Logging) mode for better concurrency and has foreign key constraints enabled for data integrity.

## Database Configuration

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = 10000;
PRAGMA temp_store = memory;
```

## Schema Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                         NODES                               │
├─────────────────────────────────────────────────────────────┤
│ nodeNum (INTEGER, PK)                                       │
│ nodeId (TEXT, UNIQUE, NOT NULL)                             │
│ longName (TEXT)                                             │
│ shortName (TEXT)                                            │
│ hwModel (INTEGER)                                           │
│ role (INTEGER)                                              │
│ hopsAway (INTEGER)                                          │
│ macaddr (TEXT)                                              │
│ latitude (REAL)                                             │
│ longitude (REAL)                                            │
│ altitude (REAL)                                             │
│ batteryLevel (INTEGER)                                      │
│ voltage (REAL)                                              │
│ channelUtilization (REAL)                                   │
│ airUtilTx (REAL)                                            │
│ lastHeard (INTEGER)                                         │
│ snr (REAL)                                                  │
│ rssi (INTEGER)                                              │
│ firmwareVersion (TEXT)                                      │
│ isMobile (BOOLEAN)                                          │
│ lastTracerouteRequest (INTEGER)                             │
│ createdAt (INTEGER, NOT NULL)                               │
│ updatedAt (INTEGER, NOT NULL)                               │
└─────────────────────────────────────────────────────────────┘
                                │
                                │ 1:N
                                │
┌─────────────────────────────────────────────────────────────┐
│                       MESSAGES                              │
├─────────────────────────────────────────────────────────────┤
│ id (TEXT, PK)                                               │
│ fromNodeNum (INTEGER, FK → NODES.nodeNum)                   │
│ toNodeNum (INTEGER, FK → NODES.nodeNum)                     │
│ fromNodeId (TEXT, NOT NULL)                                 │
│ toNodeId (TEXT, NOT NULL)                                   │
│ text (TEXT, NOT NULL)                                       │
│ channel (INTEGER, NOT NULL, DEFAULT 0)                      │
│ portnum (INTEGER)                                           │
│ timestamp (INTEGER, NOT NULL)                               │
│ rxTime (INTEGER)                                            │
│ hopStart (INTEGER)                                          │
│ hopLimit (INTEGER)                                          │
│ replyId (INTEGER)                                           │
│ emoji (INTEGER)                                             │
│ createdAt (INTEGER, NOT NULL)                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                       CHANNELS                              │
├─────────────────────────────────────────────────────────────┤
│ id (INTEGER, PK)                                            │
│ name (TEXT)                                                 │
│ psk (TEXT)                                                  │
│ uplinkEnabled (BOOLEAN, DEFAULT 1)                          │
│ downlinkEnabled (BOOLEAN, DEFAULT 1)                        │
│ createdAt (INTEGER, NOT NULL)                               │
│ updatedAt (INTEGER, NOT NULL)                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      TRACEROUTES                            │
├─────────────────────────────────────────────────────────────┤
│ id (INTEGER, PK, AUTOINCREMENT)                             │
│ fromNodeNum (INTEGER, FK → NODES.nodeNum)                   │
│ toNodeNum (INTEGER, FK → NODES.nodeNum)                     │
│ fromNodeId (TEXT, NOT NULL)                                 │
│ toNodeId (TEXT, NOT NULL)                                   │
│ route (TEXT)                                                │
│ routeBack (TEXT)                                            │
│ snrTowards (TEXT)                                           │
│ snrBack (TEXT)                                              │
│ timestamp (INTEGER, NOT NULL)                               │
│ createdAt (INTEGER, NOT NULL)                               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                      TELEMETRY                              │
├─────────────────────────────────────────────────────────────┤
│ id (INTEGER, PK, AUTOINCREMENT)                             │
│ nodeId (TEXT, NOT NULL)                                     │
│ nodeNum (INTEGER, FK → NODES.nodeNum)                       │
│ telemetryType (TEXT, NOT NULL)                              │
│ timestamp (INTEGER, NOT NULL)                               │
│ value (REAL, NOT NULL)                                      │
│ unit (TEXT)                                                 │
│ createdAt (INTEGER, NOT NULL)                               │
└─────────────────────────────────────────────────────────────┘
```

## Table Definitions

### NODES Table

Stores information about Meshtastic devices in the mesh network.

```sql
CREATE TABLE nodes (
  nodeNum INTEGER PRIMARY KEY,
  nodeId TEXT UNIQUE NOT NULL,
  longName TEXT,
  shortName TEXT,
  hwModel INTEGER,
  role INTEGER,
  hopsAway INTEGER,
  macaddr TEXT,
  latitude REAL,
  longitude REAL,
  altitude REAL,
  batteryLevel INTEGER,
  voltage REAL,
  channelUtilization REAL,
  airUtilTx REAL,
  lastHeard INTEGER,
  snr REAL,
  rssi INTEGER,
  firmwareVersion TEXT,
  isMobile BOOLEAN,
  lastTracerouteRequest INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
```

#### Field Descriptions

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `nodeNum` | INTEGER | Unique numeric identifier (Primary Key) | `123456789` |
| `nodeId` | TEXT | Hexadecimal node ID with '!' prefix | `!075bcd15` |
| `longName` | TEXT | User-defined long name | `Base Station Alpha` |
| `shortName` | TEXT | User-defined short name (3-4 chars) | `BSA` |
| `hwModel` | INTEGER | Hardware model enum (see Hardware Models) | `9` (RAK4631) |
| `role` | INTEGER | Node role enum (0=Client, 2=Router, 4=Repeater) | `2` (Router) |
| `hopsAway` | INTEGER | Network distance from local node | `3` |
| `macaddr` | TEXT | MAC address as hex string | `07:5b:cd:15:a1:b2` |
| `latitude` | REAL | GPS latitude in decimal degrees | `40.7128` |
| `longitude` | REAL | GPS longitude in decimal degrees | `-74.0060` |
| `altitude` | REAL | GPS altitude in meters | `10.5` |
| `batteryLevel` | INTEGER | Battery percentage (0-100) | `85` |
| `voltage` | REAL | Battery voltage in volts | `3.7` |
| `channelUtilization` | REAL | Channel usage percentage | `15.2` |
| `airUtilTx` | REAL | Air utilization transmit percentage | `8.5` |
| `lastHeard` | INTEGER | Unix timestamp of last communication | `1640995200` |
| `snr` | REAL | Signal-to-noise ratio in dB | `12.5` |
| `rssi` | INTEGER | Received signal strength in dBm | `-45` |
| `firmwareVersion` | TEXT | Firmware version string | `2.3.0.abc123` |
| `isMobile` | BOOLEAN | True if node has moved >1km (mobile detection) | `1` (true) |
| `lastTracerouteRequest` | INTEGER | Timestamp of last traceroute request | `1640994000` |
| `createdAt` | INTEGER | Record creation timestamp | `1640990000` |
| `updatedAt` | INTEGER | Last update timestamp | `1640995200` |

#### Business Rules

- `nodeNum` is the primary key and must be unique
- `nodeId` must be unique and follow format `![0-9a-fA-F]{8}`
- `latitude` and `longitude` should be present together or both NULL
- **Position Validation**: Coordinates are validated before storage:
  - Latitude must be between -90 and 90 degrees
  - Longitude must be between -180 and 180 degrees
  - Values must be valid numbers (not NaN or Infinity)
  - Invalid coordinates are rejected and logged as warnings
- `batteryLevel` should be between 0 and 100 if present
- **Mobile Node Detection**: `isMobile` is automatically set based on position telemetry:
  - Position data is tracked in the telemetry table
  - Movement variance is calculated from historical position data
  - Nodes with >1km total movement are marked as mobile
  - Detection uses Haversine formula for accurate distance calculation
- `lastHeard`, `createdAt`, and `updatedAt` are Unix timestamps
- Records are automatically updated with current timestamp on modification

### MESSAGES Table

Stores text messages exchanged through the mesh network.

```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  text TEXT NOT NULL,
  channel INTEGER NOT NULL DEFAULT 0,
  portnum INTEGER,
  timestamp INTEGER NOT NULL,
  rxTime INTEGER,
  hopStart INTEGER,
  hopLimit INTEGER,
  replyId INTEGER,
  emoji INTEGER,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
  FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
);
```

#### Field Descriptions

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | TEXT | Unique message identifier (Primary Key) | `123456789-1640995200` |
| `fromNodeNum` | INTEGER | Sender's numeric node ID (Foreign Key) | `123456789` |
| `toNodeNum` | INTEGER | Recipient's numeric node ID (Foreign Key) | `4294967295` |
| `fromNodeId` | TEXT | Sender's hex node ID for display | `!075bcd15` |
| `toNodeId` | TEXT | Recipient's hex node ID for display | `!ffffffff` |
| `text` | TEXT | Message content | `Hello mesh network!` |
| `channel` | INTEGER | Channel number (0-7) | `0` |
| `portnum` | INTEGER | Meshtastic port number | `1` |
| `timestamp` | INTEGER | Message timestamp in milliseconds | `1640995200000` |
| `rxTime` | INTEGER | Reception timestamp (Unix) | `1640995201` |
| `hopStart` | INTEGER | Initial hop count for message routing | `3` |
| `hopLimit` | INTEGER | Maximum hop count for message routing | `3` |
| `replyId` | INTEGER | ID of message being replied to | `123456` |
| `emoji` | INTEGER | Emoji reaction code | `1` |
| `createdAt` | INTEGER | Database insertion timestamp | `1640995201000` |

#### Business Rules

- `id` must be unique across all messages
- `fromNodeNum` and `toNodeNum` should reference valid nodes
- `toNodeId` of `!ffffffff` indicates broadcast message
- `channel` should be between 0 and 7
- `text` cannot be empty
- `timestamp` is in milliseconds, others in seconds

### CHANNELS Table

Stores channel configuration information (for future use).

```sql
CREATE TABLE channels (
  id INTEGER PRIMARY KEY,
  name TEXT,
  psk TEXT,
  uplinkEnabled BOOLEAN DEFAULT 1,
  downlinkEnabled BOOLEAN DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);
```

### TELEMETRY Table

Stores time-series telemetry data from nodes.

```sql
CREATE TABLE telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nodeId TEXT NOT NULL,
  nodeNum INTEGER NOT NULL,
  telemetryType TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  value REAL NOT NULL,
  unit TEXT,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum)
);
```

#### Field Descriptions

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | INTEGER | Auto-incrementing primary key | `1` |
| `nodeId` | TEXT | Node's hex ID | `!075bcd15` |
| `nodeNum` | INTEGER | Node's numeric ID (Foreign Key) | `123456789` |
| `telemetryType` | TEXT | Type of telemetry data | `batteryLevel` |
| `timestamp` | INTEGER | When telemetry was recorded | `1640995200000` |
| `value` | REAL | Telemetry value | `85.5` |
| `unit` | TEXT | Unit of measurement | `%` |
| `createdAt` | INTEGER | Database insertion timestamp | `1640995201000` |

#### Telemetry Types

- `batteryLevel` - Battery percentage (0-100)
- `voltage` - Battery voltage in volts
- `channelUtilization` - Channel usage percentage
- `airUtilTx` - Transmit air time utilization
- `temperature` - Temperature in Celsius
- `humidity` - Humidity percentage
- `pressure` - Barometric pressure in hPa
- `latitude` - GPS latitude in decimal degrees
- `longitude` - GPS longitude in decimal degrees
- `altitude` - GPS altitude in meters

### TRACEROUTES Table

Stores traceroute data for network topology discovery and path analysis.

```sql
CREATE TABLE traceroutes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fromNodeNum INTEGER NOT NULL,
  toNodeNum INTEGER NOT NULL,
  fromNodeId TEXT NOT NULL,
  toNodeId TEXT NOT NULL,
  route TEXT,
  routeBack TEXT,
  snrTowards TEXT,
  snrBack TEXT,
  timestamp INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum),
  FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)
);
```

#### Field Descriptions

| Field | Type | Description | Example |
|-------|------|-------------|------|
| `id` | INTEGER | Auto-incrementing primary key | `1` |
| `fromNodeNum` | INTEGER | Originating node number (Foreign Key) | `123456789` |
| `toNodeNum` | INTEGER | Destination node number (Foreign Key) | `987654321` |
| `fromNodeId` | TEXT | Originating node hex ID | `!075bcd15` |
| `toNodeId` | TEXT | Destination node hex ID | `!3ade68b1` |
| `route` | TEXT | JSON array of node numbers in forward path | `[123456789,555555555,987654321]` |
| `routeBack` | TEXT | JSON array of node numbers in return path | `[987654321,555555555,123456789]` |
| `snrTowards` | TEXT | JSON array of SNR values for forward path | `[12.5,8.3,10.1]` |
| `snrBack` | TEXT | JSON array of SNR values for return path | `[10.5,9.2,11.3]` |
| `timestamp` | INTEGER | When traceroute was completed | `1640995200000` |
| `createdAt` | INTEGER | Database insertion timestamp | `1640995201000` |

#### Business Rules

- `fromNodeNum` and `toNodeNum` must reference valid nodes
- `route` and `routeBack` are stored as JSON arrays
- `snrTowards` and `snrBack` arrays should match route array lengths
- `timestamp` is in milliseconds
- Used for network topology mapping and visualization

#### Field Descriptions

| Field | Type | Description | Example |
|-------|------|-------------|---------|
| `id` | INTEGER | Channel number (0-7) | `0` |
| `name` | TEXT | Channel display name | `Primary` |
| `psk` | TEXT | Pre-shared key (base64) | `AQ==` |
| `uplinkEnabled` | BOOLEAN | Can send to internet | `1` |
| `downlinkEnabled` | BOOLEAN | Can receive from internet | `1` |
| `createdAt` | INTEGER | Record creation timestamp | `1640990000` |
| `updatedAt` | INTEGER | Last update timestamp | `1640995200` |

## Indexes

The database includes comprehensive indexes for optimal query performance:

### Primary Indexes

```sql
-- Automatic primary key indexes
CREATE UNIQUE INDEX sqlite_autoindex_nodes_1 ON nodes(nodeNum);
CREATE UNIQUE INDEX sqlite_autoindex_nodes_2 ON nodes(nodeId);
CREATE UNIQUE INDEX sqlite_autoindex_messages_1 ON messages(id);
CREATE UNIQUE INDEX sqlite_autoindex_channels_1 ON channels(id);
```

### Performance Indexes

```sql
-- Node-related indexes
CREATE INDEX idx_nodes_nodeId ON nodes(nodeId);
CREATE INDEX idx_nodes_lastHeard ON nodes(lastHeard);
CREATE INDEX idx_nodes_updatedAt ON nodes(updatedAt);

-- Message-related indexes
CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_fromNodeId ON messages(fromNodeId);
CREATE INDEX idx_messages_toNodeId ON messages(toNodeId);
CREATE INDEX idx_messages_channel ON messages(channel);
CREATE INDEX idx_messages_createdAt ON messages(createdAt);

-- Telemetry indexes
CREATE INDEX idx_telemetry_nodeId ON telemetry(nodeId);
CREATE INDEX idx_telemetry_timestamp ON telemetry(timestamp);
CREATE INDEX idx_telemetry_type ON telemetry(telemetryType);
CREATE INDEX idx_telemetry_node_type ON telemetry(nodeId, telemetryType);

-- Composite indexes for common queries
CREATE INDEX idx_messages_channel_timestamp ON messages(channel, timestamp);
CREATE INDEX idx_messages_from_to_timestamp ON messages(fromNodeId, toNodeId, timestamp);

-- Traceroute indexes
CREATE INDEX idx_traceroutes_timestamp ON traceroutes(timestamp);
CREATE INDEX idx_traceroutes_fromNode ON traceroutes(fromNodeNum);
CREATE INDEX idx_traceroutes_toNode ON traceroutes(toNodeNum);
CREATE INDEX idx_traceroutes_nodes ON traceroutes(fromNodeNum, toNodeNum);
```

## Data Types and Constraints

### SQLite Type Mapping

| Application Type | SQLite Type | Storage Class | Notes |
|-----------------|-------------|---------------|-------|
| Node ID | TEXT | TEXT | Hex string with '!' prefix |
| Timestamps | INTEGER | INTEGER | Unix timestamps |
| Coordinates | REAL | REAL | Decimal degrees |
| Percentages | REAL | REAL | 0.0 to 100.0 |
| Signal Strength | INTEGER | INTEGER | dBm values (negative) |
| Boolean | INTEGER | INTEGER | 0 = false, 1 = true |

### Constraints

```sql
-- Foreign key constraints
FOREIGN KEY (fromNodeNum) REFERENCES nodes(nodeNum)
FOREIGN KEY (toNodeNum) REFERENCES nodes(nodeNum)

-- Check constraints (if needed in future versions)
-- CHECK (batteryLevel >= 0 AND batteryLevel <= 100)
-- CHECK (channel >= 0 AND channel <= 7)
-- CHECK (latitude >= -90 AND latitude <= 90)
-- CHECK (longitude >= -180 AND longitude <= 180)
```

## Hardware Model Reference

Hardware model enum values used in the `hwModel` field (116 models supported: 0-114 plus 255):

| ID | Technical Name | Formatted Name |
|----|----------------|----------------|
| 1 | TLORA_V2 | TLora V2 |
| 2 | TLORA_V1 | TLora V1 |
| 3 | TLORA_V2_1_1P6 | TLora V2 1 1.6 |
| 4 | TBEAM | TBeam |
| 5 | HELTEC_V2_0 | Heltec V2 0 |
| 9 | RAK4631 | RAK4631 |
| 12 | LILYGO_TBEAM_S3_CORE | Lilygo TBeam S3 Core |
| 31 | STATION_G2 | Station G2 |
| 43 | HELTEC_V3 | Heltec V3 |
| 48 | HELTEC_WIRELESS_TRACKER | Heltec Wireless Tracker |
| 49 | HELTEC_WIRELESS_PAPER | Heltec Wireless Paper |
| 50 | T_DECK | T Deck |
| 80 | M5STACK_CORES3 | M5Stack CoreS3 |
| 96 | NOMADSTAR_METEOR_PRO | NomadStar Meteor Pro |
| 110 | HELTEC_V4 | Heltec V4 |
| 114 | T_WATCH_ULTRA | T Watch Ultra |
| 255 | PRIVATE_HW | Private HW |

*Note: Full list of 116 models (0-114 plus 255) defined in `src/constants/index.ts`. Hardware names are automatically formatted for display using `formatHardwareName()` from `src/utils/nodeHelpers.ts`.*

**Hardware Name Formatting:**
- Technical names (e.g., `STATION_G2`) are converted to readable format (e.g., "Station G2")
- Brand names use proper capitalization (Heltec, Lilygo, BetaFPV)
- Version numbers are formatted with periods (V2P0 becomes V2.0)
- Abbreviations are preserved uppercase (LR, TX, RAK, NRF, etc.)

## Common Queries

### Node Queries

```sql
-- Get all active nodes (last heard within 7 days)
SELECT * FROM nodes
WHERE lastHeard > (strftime('%s', 'now') - 7 * 24 * 3600)
ORDER BY lastHeard DESC;

-- Get nodes with GPS coordinates
SELECT nodeId, longName, latitude, longitude
FROM nodes
WHERE latitude IS NOT NULL AND longitude IS NOT NULL;

-- Get nodes with low battery
SELECT nodeId, longName, batteryLevel
FROM nodes
WHERE batteryLevel IS NOT NULL AND batteryLevel < 20
ORDER BY batteryLevel ASC;
```

### Message Queries

```sql
-- Get recent messages (last 100)
SELECT m.*, n1.longName as fromName, n2.longName as toName
FROM messages m
LEFT JOIN nodes n1 ON m.fromNodeNum = n1.nodeNum
LEFT JOIN nodes n2 ON m.toNodeNum = n2.nodeNum
ORDER BY m.timestamp DESC
LIMIT 100;

-- Get messages for specific channel
SELECT * FROM messages
WHERE channel = 0
ORDER BY timestamp DESC
LIMIT 50;

-- Get direct messages between two nodes
SELECT * FROM messages
WHERE (fromNodeId = '!075bcd15' AND toNodeId = '!a1b2c3d4')
   OR (fromNodeId = '!a1b2c3d4' AND toNodeId = '!075bcd15')
ORDER BY timestamp ASC;

-- Get message statistics by day
SELECT date(timestamp/1000, 'unixepoch') as date,
       COUNT(*) as message_count
FROM messages
WHERE timestamp > (strftime('%s', 'now', '-30 days') * 1000)
GROUP BY date(timestamp/1000, 'unixepoch')
ORDER BY date;
```

### Analytics Queries

```sql
-- Most active nodes by message count
SELECT fromNodeId, COUNT(*) as message_count
FROM messages
WHERE timestamp > (strftime('%s', 'now', '-7 days') * 1000)
GROUP BY fromNodeId
ORDER BY message_count DESC
LIMIT 10;

-- Channel activity
SELECT channel, COUNT(*) as message_count
FROM messages
WHERE timestamp > (strftime('%s', 'now', '-7 days') * 1000)
GROUP BY channel
ORDER BY message_count DESC;

-- Average signal strength by node
SELECT nodeId, longName,
       AVG(snr) as avg_snr,
       AVG(rssi) as avg_rssi
FROM nodes
WHERE snr IS NOT NULL OR rssi IS NOT NULL
GROUP BY nodeId, longName;
```

## Database Maintenance

### Regular Maintenance Tasks

```sql
-- Vacuum database (reclaim space)
VACUUM;

-- Update statistics for query optimization
ANALYZE;

-- Check database integrity
PRAGMA integrity_check;

-- Check foreign key constraints
PRAGMA foreign_key_check;
```

### Cleanup Operations

```sql
-- Delete messages older than 30 days
DELETE FROM messages
WHERE timestamp < (strftime('%s', 'now', '-30 days') * 1000);

-- Delete nodes not heard from in 90 days
DELETE FROM nodes
WHERE lastHeard < strftime('%s', 'now', '-90 days')
   OR lastHeard IS NULL;

-- Reset auto-increment counters
UPDATE sqlite_sequence SET seq = 0 WHERE name = 'channels';
```

### Backup and Restore

```sql
-- Create backup
.backup backup.db

-- Restore from backup
.restore backup.db

-- Export as SQL
.output backup.sql
.dump

-- Import from SQL
.read backup.sql
```

## Performance Considerations

### Query Optimization

1. **Use indexes effectively**: Ensure WHERE clauses match existing indexes
2. **Limit result sets**: Always use LIMIT for potentially large queries
3. **Use prepared statements**: Prevent SQL injection and improve performance
4. **Batch operations**: Group multiple INSERTs in transactions

### Storage Optimization

1. **Regular VACUUM**: Reclaim deleted space
2. **Appropriate data types**: Use most efficient SQLite types
3. **Selective indexing**: Don't over-index, balance query speed vs. storage
4. **Archive old data**: Move historical data to separate tables/files

### Connection Management

```typescript
// Example connection management
class DatabaseConnection {
  private db: Database;

  constructor(filename: string) {
    this.db = new Database(filename, {
      verbose: process.env.NODE_ENV === 'development' ? console.log : undefined
    });

    // Enable optimizations
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = 10000');
    this.db.pragma('temp_store = memory');
  }

  // Use transactions for multiple operations
  insertMultipleNodes(nodes: Node[]) {
    const transaction = this.db.transaction(() => {
      const stmt = this.db.prepare(`INSERT INTO nodes (...) VALUES (...)`);
      for (const node of nodes) {
        stmt.run(node);
      }
    });
    transaction();
  }
}
```

This comprehensive database schema documentation provides all the information needed to understand, maintain, and optimize the MeshMonitor database.