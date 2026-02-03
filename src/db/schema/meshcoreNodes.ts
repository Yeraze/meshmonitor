/**
 * Drizzle schema definition for MeshCore nodes table
 * Supports SQLite, PostgreSQL, and MySQL
 *
 * MeshCore uses public keys (64-char hex) as primary identifiers
 * instead of numeric node IDs like Meshtastic.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, doublePrecision as pgDoublePrecision, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

/**
 * MeshCore device types
 * 0 = Unknown
 * 1 = Companion (full-featured client)
 * 2 = Repeater (relay-only)
 * 3 = Room Server (BBS-style server)
 */

// ============ SQLite Schema ============

export const meshcoreNodesSqlite = sqliteTable('meshcore_nodes', {
  // Primary identifier - 64 character hex public key
  publicKey: text('publicKey').primaryKey(),

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
  adminPassword: text('adminPassword'), // Stored for convenience (optional)
  lastAdminCheck: integer('lastAdminCheck'),

  // Local node indicator
  isLocalNode: integer('isLocalNode', { mode: 'boolean' }).default(false),

  // Timestamps
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshcoreNodesPostgres = pgTable('meshcore_nodes', {
  publicKey: pgText('publicKey').primaryKey(),

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
  adminPassword: pgText('adminPassword'),
  lastAdminCheck: pgBigint('lastAdminCheck', { mode: 'number' }),

  isLocalNode: pgBoolean('isLocalNode').default(false),

  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshcoreNodesMysql = mysqlTable('meshcore_nodes', {
  publicKey: myVarchar('publicKey', { length: 64 }).primaryKey(),

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
  adminPassword: myVarchar('adminPassword', { length: 255 }),
  lastAdminCheck: myBigint('lastAdminCheck', { mode: 'number' }),

  isLocalNode: myBoolean('isLocalNode').default(false),

  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MeshCoreNodeSqlite = typeof meshcoreNodesSqlite.$inferSelect;
export type NewMeshCoreNodeSqlite = typeof meshcoreNodesSqlite.$inferInsert;
export type MeshCoreNodePostgres = typeof meshcoreNodesPostgres.$inferSelect;
export type NewMeshCoreNodePostgres = typeof meshcoreNodesPostgres.$inferInsert;
export type MeshCoreNodeMysql = typeof meshcoreNodesMysql.$inferSelect;
export type NewMeshCoreNodeMysql = typeof meshcoreNodesMysql.$inferInsert;
