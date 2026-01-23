/**
 * Drizzle schema definition for the nodes table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite schema
export const nodesSqlite = sqliteTable('nodes', {
  nodeNum: integer('nodeNum').primaryKey(),
  nodeId: text('nodeId').notNull().unique(),
  longName: text('longName'),
  shortName: text('shortName'),
  hwModel: integer('hwModel'),
  role: integer('role'),
  hopsAway: integer('hopsAway'),
  lastMessageHops: integer('lastMessageHops'),
  viaMqtt: integer('viaMqtt', { mode: 'boolean' }),
  macaddr: text('macaddr'),
  latitude: real('latitude'),
  longitude: real('longitude'),
  altitude: real('altitude'),
  batteryLevel: integer('batteryLevel'),
  voltage: real('voltage'),
  channelUtilization: real('channelUtilization'),
  airUtilTx: real('airUtilTx'),
  lastHeard: integer('lastHeard'),
  snr: real('snr'),
  rssi: integer('rssi'),
  lastTracerouteRequest: integer('lastTracerouteRequest'),
  firmwareVersion: text('firmwareVersion'),
  channel: integer('channel'),
  isFavorite: integer('isFavorite', { mode: 'boolean' }).default(false),
  isIgnored: integer('isIgnored', { mode: 'boolean' }).default(false),
  mobile: integer('mobile').default(0),
  rebootCount: integer('rebootCount'),
  publicKey: text('publicKey'),
  hasPKC: integer('hasPKC', { mode: 'boolean' }),
  lastPKIPacket: integer('lastPKIPacket'),
  keyIsLowEntropy: integer('keyIsLowEntropy', { mode: 'boolean' }),
  duplicateKeyDetected: integer('duplicateKeyDetected', { mode: 'boolean' }),
  keyMismatchDetected: integer('keyMismatchDetected', { mode: 'boolean' }),
  keySecurityIssueDetails: text('keySecurityIssueDetails'),
  welcomedAt: integer('welcomedAt'),
  // Position precision tracking
  positionChannel: integer('positionChannel'),
  positionPrecisionBits: integer('positionPrecisionBits'),
  positionGpsAccuracy: real('positionGpsAccuracy'),
  positionHdop: real('positionHdop'),
  positionTimestamp: integer('positionTimestamp'),
  // Position override
  positionOverrideEnabled: integer('positionOverrideEnabled', { mode: 'boolean' }).default(false),
  latitudeOverride: real('latitudeOverride'),
  longitudeOverride: real('longitudeOverride'),
  altitudeOverride: real('altitudeOverride'),
  positionOverrideIsPrivate: integer('positionOverrideIsPrivate', { mode: 'boolean' }).default(false),
  // Remote admin discovery
  hasRemoteAdmin: integer('hasRemoteAdmin', { mode: 'boolean' }).default(false),
  lastRemoteAdminCheck: integer('lastRemoteAdminCheck'),
  remoteAdminMetadata: text('remoteAdminMetadata'),
  // Timestamps
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL schema
export const nodesPostgres = pgTable('nodes', {
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).primaryKey(),
  nodeId: pgText('nodeId').notNull().unique(),
  longName: pgText('longName'),
  shortName: pgText('shortName'),
  hwModel: pgInteger('hwModel'),
  role: pgInteger('role'),
  hopsAway: pgInteger('hopsAway'),
  lastMessageHops: pgInteger('lastMessageHops'),
  viaMqtt: pgBoolean('viaMqtt'),
  macaddr: pgText('macaddr'),
  latitude: pgReal('latitude'),
  longitude: pgReal('longitude'),
  altitude: pgReal('altitude'),
  batteryLevel: pgInteger('batteryLevel'),
  voltage: pgReal('voltage'),
  channelUtilization: pgReal('channelUtilization'),
  airUtilTx: pgReal('airUtilTx'),
  lastHeard: pgBigint('lastHeard', { mode: 'number' }),
  snr: pgReal('snr'),
  rssi: pgInteger('rssi'),
  lastTracerouteRequest: pgBigint('lastTracerouteRequest', { mode: 'number' }),
  firmwareVersion: pgText('firmwareVersion'),
  channel: pgInteger('channel'),
  isFavorite: pgBoolean('isFavorite').default(false),
  isIgnored: pgBoolean('isIgnored').default(false),
  mobile: pgInteger('mobile').default(0),
  rebootCount: pgInteger('rebootCount'),
  publicKey: pgText('publicKey'),
  hasPKC: pgBoolean('hasPKC'),
  lastPKIPacket: pgBigint('lastPKIPacket', { mode: 'number' }),
  keyIsLowEntropy: pgBoolean('keyIsLowEntropy'),
  duplicateKeyDetected: pgBoolean('duplicateKeyDetected'),
  keyMismatchDetected: pgBoolean('keyMismatchDetected'),
  keySecurityIssueDetails: pgText('keySecurityIssueDetails'),
  welcomedAt: pgBigint('welcomedAt', { mode: 'number' }),
  // Position precision tracking
  positionChannel: pgInteger('positionChannel'),
  positionPrecisionBits: pgInteger('positionPrecisionBits'),
  positionGpsAccuracy: pgReal('positionGpsAccuracy'),
  positionHdop: pgReal('positionHdop'),
  positionTimestamp: pgBigint('positionTimestamp', { mode: 'number' }),
  // Position override
  positionOverrideEnabled: pgBoolean('positionOverrideEnabled').default(false),
  latitudeOverride: pgReal('latitudeOverride'),
  longitudeOverride: pgReal('longitudeOverride'),
  altitudeOverride: pgReal('altitudeOverride'),
  positionOverrideIsPrivate: pgBoolean('positionOverrideIsPrivate').default(false),
  // Remote admin discovery
  hasRemoteAdmin: pgBoolean('hasRemoteAdmin').default(false),
  lastRemoteAdminCheck: pgBigint('lastRemoteAdminCheck', { mode: 'number' }),
  remoteAdminMetadata: pgText('remoteAdminMetadata'),
  // Timestamps
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL schema
export const nodesMysql = mysqlTable('nodes', {
  nodeNum: myBigint('nodeNum', { mode: 'number' }).primaryKey(),
  nodeId: myVarchar('nodeId', { length: 32 }).notNull().unique(),
  longName: myVarchar('longName', { length: 255 }),
  shortName: myVarchar('shortName', { length: 32 }),
  hwModel: myInt('hwModel'),
  role: myInt('role'),
  hopsAway: myInt('hopsAway'),
  lastMessageHops: myInt('lastMessageHops'),
  viaMqtt: myBoolean('viaMqtt'),
  macaddr: myVarchar('macaddr', { length: 32 }),
  latitude: myDouble('latitude'),
  longitude: myDouble('longitude'),
  altitude: myDouble('altitude'),
  batteryLevel: myInt('batteryLevel'),
  voltage: myDouble('voltage'),
  channelUtilization: myDouble('channelUtilization'),
  airUtilTx: myDouble('airUtilTx'),
  lastHeard: myBigint('lastHeard', { mode: 'number' }),
  snr: myDouble('snr'),
  rssi: myInt('rssi'),
  lastTracerouteRequest: myBigint('lastTracerouteRequest', { mode: 'number' }),
  firmwareVersion: myVarchar('firmwareVersion', { length: 64 }),
  channel: myInt('channel'),
  isFavorite: myBoolean('isFavorite').default(false),
  isIgnored: myBoolean('isIgnored').default(false),
  mobile: myInt('mobile').default(0),
  rebootCount: myInt('rebootCount'),
  publicKey: myVarchar('publicKey', { length: 128 }),
  hasPKC: myBoolean('hasPKC'),
  lastPKIPacket: myBigint('lastPKIPacket', { mode: 'number' }),
  keyIsLowEntropy: myBoolean('keyIsLowEntropy'),
  duplicateKeyDetected: myBoolean('duplicateKeyDetected'),
  keyMismatchDetected: myBoolean('keyMismatchDetected'),
  keySecurityIssueDetails: myVarchar('keySecurityIssueDetails', { length: 512 }),
  welcomedAt: myBigint('welcomedAt', { mode: 'number' }),
  // Position precision tracking
  positionChannel: myInt('positionChannel'),
  positionPrecisionBits: myInt('positionPrecisionBits'),
  positionGpsAccuracy: myDouble('positionGpsAccuracy'),
  positionHdop: myDouble('positionHdop'),
  positionTimestamp: myBigint('positionTimestamp', { mode: 'number' }),
  // Position override
  positionOverrideEnabled: myBoolean('positionOverrideEnabled').default(false),
  latitudeOverride: myDouble('latitudeOverride'),
  longitudeOverride: myDouble('longitudeOverride'),
  altitudeOverride: myDouble('altitudeOverride'),
  positionOverrideIsPrivate: myBoolean('positionOverrideIsPrivate').default(false),
  // Remote admin discovery
  hasRemoteAdmin: myBoolean('hasRemoteAdmin').default(false),
  lastRemoteAdminCheck: myBigint('lastRemoteAdminCheck', { mode: 'number' }),
  remoteAdminMetadata: myVarchar('remoteAdminMetadata', { length: 4096 }),
  // Timestamps
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type NodeSqlite = typeof nodesSqlite.$inferSelect;
export type NewNodeSqlite = typeof nodesSqlite.$inferInsert;
export type NodePostgres = typeof nodesPostgres.$inferSelect;
export type NewNodePostgres = typeof nodesPostgres.$inferInsert;
export type NodeMysql = typeof nodesMysql.$inferSelect;
export type NewNodeMysql = typeof nodesMysql.$inferInsert;
