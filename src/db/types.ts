/**
 * Shared Database Types
 * These types are used by SQLite, PostgreSQL, and MySQL implementations
 * and match the existing DbNode, DbMessage, etc. interfaces in database.ts
 */

// Re-export types from existing database.ts for compatibility
// These will eventually be moved here as the source of truth

export type DatabaseType = 'sqlite' | 'postgres' | 'mysql';

/**
 * Database configuration
 */
export interface DatabaseConfig {
  type: DatabaseType;
  // SQLite specific
  sqlitePath?: string;
  // PostgreSQL specific
  postgresUrl?: string;
  postgresMaxConnections?: number;
  postgresSsl?: boolean | { rejectUnauthorized: boolean };
  // MySQL/MariaDB specific
  mysqlUrl?: string;
  mysqlMaxConnections?: number;
}

/**
 * Unified node type matching DbNode interface
 */
export interface DbNode {
  nodeNum: number;
  nodeId: string;
  longName: string | null;
  shortName: string | null;
  hwModel: number | null;
  role?: number | null;
  hopsAway?: number | null;
  lastMessageHops?: number | null;
  viaMqtt?: boolean | null;
  macaddr?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  altitude?: number | null;
  batteryLevel?: number | null;
  voltage?: number | null;
  channelUtilization?: number | null;
  airUtilTx?: number | null;
  lastHeard?: number | null;
  snr?: number | null;
  rssi?: number | null;
  lastTracerouteRequest?: number | null;
  firmwareVersion?: string | null;
  channel?: number | null;
  isFavorite?: boolean | null;
  isIgnored?: boolean | null;
  mobile?: number | null;
  rebootCount?: number | null;
  publicKey?: string | null;
  hasPKC?: boolean | null;
  lastPKIPacket?: number | null;
  keyIsLowEntropy?: boolean | null;
  duplicateKeyDetected?: boolean | null;
  keyMismatchDetected?: boolean | null;
  keySecurityIssueDetails?: string | null;
  welcomedAt?: number | null;
  positionChannel?: number | null;
  positionPrecisionBits?: number | null;
  positionGpsAccuracy?: number | null;
  positionHdop?: number | null;
  positionTimestamp?: number | null;
  positionOverrideEnabled?: boolean | null;
  latitudeOverride?: number | null;
  longitudeOverride?: number | null;
  altitudeOverride?: number | null;
  positionOverrideIsPrivate?: boolean | null;
  // Remote admin discovery
  hasRemoteAdmin?: boolean | null;
  lastRemoteAdminCheck?: number | null;
  remoteAdminMetadata?: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Unified message type matching DbMessage interface
 */
export interface DbMessage {
  id: string;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  text: string;
  channel: number;
  portnum?: number | null;
  requestId?: number | null;
  timestamp: number;
  rxTime?: number | null;
  hopStart?: number | null;
  hopLimit?: number | null;
  relayNode?: number | null;
  replyId?: number | null;
  emoji?: number | null;
  viaMqtt?: boolean | null;
  rxSnr?: number | null;
  rxRssi?: number | null;
  ackFailed?: boolean | null;
  routingErrorReceived?: boolean | null;
  deliveryState?: string | null;
  wantAck?: boolean | null;
  ackFromNode?: number | null;
  createdAt: number;
  decryptedBy?: 'node' | 'server' | null;
}

/**
 * Unified channel type matching DbChannel interface
 */
export interface DbChannel {
  id: number;
  name: string;
  psk?: string;
  role?: number; // 0=Disabled, 1=Primary, 2=Secondary
  uplinkEnabled: boolean;
  downlinkEnabled: boolean;
  positionPrecision?: number; // Location precision bits (0-32)
  createdAt: number;
  updatedAt: number;
}

/**
 * Unified telemetry type matching DbTelemetry interface
 */
export interface DbTelemetry {
  id?: number;
  nodeId: string;
  nodeNum: number;
  telemetryType: string;
  timestamp: number;
  value: number;
  unit?: string | null;
  createdAt: number;
  packetTimestamp?: number | null;
  packetId?: number | null;
  channel?: number | null;
  precisionBits?: number | null;
  gpsAccuracy?: number | null;
}

/**
 * Unified traceroute type matching DbTraceroute interface
 */
export interface DbTraceroute {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  route: string | null;
  routeBack: string | null;
  snrTowards: string | null;
  snrBack: string | null;
  timestamp: number;
  createdAt: number;
}

/**
 * Unified route segment type matching DbRouteSegment interface
 */
export interface DbRouteSegment {
  id?: number;
  fromNodeNum: number;
  toNodeNum: number;
  fromNodeId: string;
  toNodeId: string;
  distanceKm: number;
  isRecordHolder: boolean | null;
  timestamp: number;
  createdAt: number;
}

/**
 * Unified neighbor info type matching DbNeighborInfo interface
 */
export interface DbNeighborInfo {
  id?: number;
  nodeNum: number;
  neighborNodeNum: number;
  snr?: number | null;
  lastRxTime?: number | null;
  timestamp: number;
  createdAt: number;
}

/**
 * Unified push subscription type matching DbPushSubscription interface
 */
export interface DbPushSubscription {
  id?: number;
  userId?: number | null;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  userAgent?: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt?: number | null;
}

/**
 * Unified packet log type matching DbPacketLog interface
 */
export interface DbPacketLog {
  id?: number;
  packet_id?: number | null;
  timestamp: number;
  from_node: number;
  from_node_id?: string | null;
  from_node_longName?: string | null;
  to_node?: number | null;
  to_node_id?: string | null;
  to_node_longName?: string | null;
  channel?: number | null;
  portnum: number;
  portnum_name?: string | null;
  encrypted: boolean;
  snr?: number | null;
  rssi?: number | null;
  hop_limit?: number | null;
  hop_start?: number | null;
  relay_node?: number | null;
  payload_size?: number | null;
  want_ack?: boolean | null;
  priority?: number | null;
  payload_preview?: string | null;
  metadata?: string | null;
  direction?: 'rx' | 'tx' | null;
  created_at?: number | null;
  decrypted_by?: 'node' | 'server' | null;
  decrypted_channel_id?: number | null;
}

/**
 * Unified custom theme type matching DbCustomTheme interface
 */
export interface DbCustomTheme {
  id?: number;
  name: string;
  slug: string;
  definition: string;
  is_builtin: boolean | number | null;
  created_by?: number | null;
  created_at: number;
  updated_at: number;
}

/**
 * Settings key-value pair
 */
export interface DbSetting {
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Channel Database entry for server-side decryption
 * Stores channel configurations beyond the device's 8 slots
 */
export interface DbChannelDatabase {
  id?: number;
  name: string;
  psk: string; // Base64-encoded PSK
  pskLength: number; // 16 for AES-128, 32 for AES-256
  description?: string | null;
  isEnabled: boolean;
  enforceNameValidation: boolean;
  sortOrder: number; // Order for decryption priority (lower = tried first)
  decryptedPacketCount: number;
  lastDecryptedAt?: number | null;
  createdBy?: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Channel Database Permission for per-user read access
 */
export interface DbChannelDatabasePermission {
  id?: number;
  userId: number;
  channelDatabaseId: number;
  canViewOnMap: boolean;
  canRead: boolean;
  grantedBy?: number | null;
  grantedAt: number;
}
