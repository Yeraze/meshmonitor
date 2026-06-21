/**
 * Drizzle schema definition for MeshCore nodes table
 * Supports SQLite, PostgreSQL, and MySQL
 *
 * MeshCore uses public keys (64-char hex) as primary identifiers
 * instead of numeric node IDs like Meshtastic.
 */
import { sqliteTable, text, integer, real, primaryKey as sqlitePrimaryKey } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, doublePrecision as pgDoublePrecision, boolean as pgBoolean, bigint as pgBigint, primaryKey as pgPrimaryKey } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint, primaryKey as myPrimaryKey } from 'drizzle-orm/mysql-core';

/**
 * MeshCore device types
 * 0 = Unknown
 * 1 = Companion (full-featured client)
 * 2 = Repeater (relay-only)
 * 3 = Room Server (BBS-style server)
 */

// ============ SQLite Schema ============

export const meshcoreNodesSqlite = sqliteTable('meshcore_nodes', {
  // 64 character hex public key — part of composite PK after migration 061
  publicKey: text('publicKey').notNull(),

  // Node identity
  name: text('name'),
  advType: integer('advType'), // 1=Companion, 2=Repeater, 3=RoomServer

  // Radio configuration
  txPower: integer('txPower'),
  maxTxPower: integer('maxTxPower'),
  radioFreq: real('radioFreq'),      // MHz (e.g., 910.525)
  radioBw: real('radioBw'),          // Bandwidth in kHz (e.g., 62.5)
  radioSf: integer('radioSf'),       // Spreading factor (e.g., 7)
  radioCr: integer('radioCr'),       // Coding rate (e.g., 5)

  // Position (if available)
  latitude: real('latitude'),
  longitude: real('longitude'),
  altitude: real('altitude'),

  // Telemetry
  batteryMv: integer('batteryMv'),   // Battery voltage in millivolts
  uptimeSecs: integer('uptimeSecs'), // Uptime in seconds

  // Signal quality (from last received packet)
  rssi: integer('rssi'),
  snr: real('snr'),
  lastHeard: integer('lastHeard'),   // Unix timestamp

  // Admin status
  hasAdminAccess: integer('hasAdminAccess', { mode: 'boolean' }).default(false),
  lastAdminCheck: integer('lastAdminCheck'),
  // Optional saved admin password — AES-256-GCM ciphertext + metadata as JSON
  // (see migration 070 and src/server/services/meshcoreCredentialStore.ts).
  // NULL means "no saved credential, prompt the user". Persistence is only
  // offered when SESSION_SECRET was explicitly configured (otherwise the
  // ciphertext would be unrecoverable across restarts).
  adminCredential: text('adminCredential'),

  // Local node indicator
  isLocalNode: integer('isLocalNode', { mode: 'boolean' }).default(false),

  // Favorite indicator (migration 094). MeshCore firmware has no native
  // favorite concept, so this is stored server-side only and never pushed to
  // the device. Favorited nodes are pinned to the top of the node list.
  isFavorite: integer('isFavorite', { mode: 'boolean' }).default(false),

  // Owning source — required as part of composite PK after migration 061.
  sourceId: text('sourceId').notNull(),

  // Per-node remote-telemetry retrieval config (migration 060). The
  // MeshCoreRemoteTelemetryScheduler reads these to decide whether to
  // send `req_telemetry_sync` to this node on each tick.
  telemetryEnabled: integer('telemetryEnabled', { mode: 'boolean' }).default(false),
  telemetryIntervalMinutes: integer('telemetryIntervalMinutes').default(60),
  lastTelemetryRequestAt: integer('lastTelemetryRequestAt'),

  // Per-room-server sync config (migration 072).
  roomSyncEnabled: integer('roomSyncEnabled', { mode: 'boolean' }).default(false),
  roomSyncIntervalMinutes: integer('roomSyncIntervalMinutes').default(60),
  lastRoomSyncAt: integer('lastRoomSyncAt'),
  lastRoomPostAt: integer('lastRoomPostAt'),
  roomCredential: text('roomCredential'),

  // MeshCore per-contact forwarding route (migration 068).
  // `outPath` is a comma-separated hex chain of hop hashes ("a3,7f,02");
  // `pathLen` is the hop count. Both NULL when the firmware's
  // OUT_PATH_UNKNOWN (0xFF) sentinel is set — next send will flood.
  outPath: text('out_path'),
  pathLen: integer('path_len'),

  // Timestamps
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
}, (table) => ({
  pk: sqlitePrimaryKey({ columns: [table.sourceId, table.publicKey] }),
}));

// ============ PostgreSQL Schema ============

export const meshcoreNodesPostgres = pgTable('meshcore_nodes', {
  publicKey: pgText('publicKey').notNull(),

  name: pgText('name'),
  advType: pgInteger('advType'),

  txPower: pgInteger('txPower'),
  maxTxPower: pgInteger('maxTxPower'),
  radioFreq: pgReal('radioFreq'),
  radioBw: pgReal('radioBw'),
  radioSf: pgInteger('radioSf'),
  radioCr: pgInteger('radioCr'),

  latitude: pgDoublePrecision('latitude'),
  longitude: pgDoublePrecision('longitude'),
  altitude: pgDoublePrecision('altitude'),

  batteryMv: pgInteger('batteryMv'),
  uptimeSecs: pgBigint('uptimeSecs', { mode: 'number' }),

  rssi: pgInteger('rssi'),
  snr: pgReal('snr'),
  lastHeard: pgBigint('lastHeard', { mode: 'number' }),

  hasAdminAccess: pgBoolean('hasAdminAccess').default(false),
  lastAdminCheck: pgBigint('lastAdminCheck', { mode: 'number' }),
  adminCredential: pgText('adminCredential'),

  isLocalNode: pgBoolean('isLocalNode').default(false),

  isFavorite: pgBoolean('isFavorite').default(false),

  sourceId: pgText('sourceId').notNull(),

  telemetryEnabled: pgBoolean('telemetryEnabled').default(false),
  telemetryIntervalMinutes: pgInteger('telemetryIntervalMinutes').default(60),
  lastTelemetryRequestAt: pgBigint('lastTelemetryRequestAt', { mode: 'number' }),

  roomSyncEnabled: pgBoolean('roomSyncEnabled').default(false),
  roomSyncIntervalMinutes: pgInteger('roomSyncIntervalMinutes').default(60),
  lastRoomSyncAt: pgBigint('lastRoomSyncAt', { mode: 'number' }),
  lastRoomPostAt: pgBigint('lastRoomPostAt', { mode: 'number' }),
  roomCredential: pgText('roomCredential'),

  outPath: pgText('out_path'),
  pathLen: pgInteger('path_len'),

  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: pgPrimaryKey({ columns: [table.sourceId, table.publicKey] }),
}));

// ============ MySQL Schema ============

export const meshcoreNodesMysql = mysqlTable('meshcore_nodes', {
  publicKey: myVarchar('publicKey', { length: 64 }).notNull(),

  name: myVarchar('name', { length: 255 }),
  advType: myInt('advType'),

  txPower: myInt('txPower'),
  maxTxPower: myInt('maxTxPower'),
  radioFreq: myDouble('radioFreq'),
  radioBw: myDouble('radioBw'),
  radioSf: myInt('radioSf'),
  radioCr: myInt('radioCr'),

  latitude: myDouble('latitude'),
  longitude: myDouble('longitude'),
  altitude: myDouble('altitude'),

  batteryMv: myInt('batteryMv'),
  uptimeSecs: myBigint('uptimeSecs', { mode: 'number' }),

  rssi: myInt('rssi'),
  snr: myDouble('snr'),
  lastHeard: myBigint('lastHeard', { mode: 'number' }),

  hasAdminAccess: myBoolean('hasAdminAccess').default(false),
  lastAdminCheck: myBigint('lastAdminCheck', { mode: 'number' }),
  adminCredential: myVarchar('adminCredential', { length: 1024 }),

  isLocalNode: myBoolean('isLocalNode').default(false),

  isFavorite: myBoolean('isFavorite').default(false),

  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),

  telemetryEnabled: myBoolean('telemetryEnabled').default(false),
  telemetryIntervalMinutes: myInt('telemetryIntervalMinutes').default(60),
  lastTelemetryRequestAt: myBigint('lastTelemetryRequestAt', { mode: 'number' }),

  roomSyncEnabled: myBoolean('roomSyncEnabled').default(false),
  roomSyncIntervalMinutes: myInt('roomSyncIntervalMinutes').default(60),
  lastRoomSyncAt: myBigint('lastRoomSyncAt', { mode: 'number' }),
  lastRoomPostAt: myBigint('lastRoomPostAt', { mode: 'number' }),
  roomCredential: myVarchar('roomCredential', { length: 1024 }),

  outPath: myVarchar('out_path', { length: 255 }),
  pathLen: myInt('path_len'),

  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
}, (table) => ({
  pk: myPrimaryKey({ columns: [table.sourceId, table.publicKey] }),
}));

// ============ Type Inference ============

export type MeshCoreNodeSqlite = typeof meshcoreNodesSqlite.$inferSelect;
export type NewMeshCoreNodeSqlite = typeof meshcoreNodesSqlite.$inferInsert;
export type MeshCoreNodePostgres = typeof meshcoreNodesPostgres.$inferSelect;
export type NewMeshCoreNodePostgres = typeof meshcoreNodesPostgres.$inferInsert;
export type MeshCoreNodeMysql = typeof meshcoreNodesMysql.$inferSelect;
export type NewMeshCoreNodeMysql = typeof meshcoreNodesMysql.$inferInsert;
