/**
 * Drizzle schema definition for the nodes table
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';

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
  positionOverrideEnabled: integer('positionOverrideEnabled').default(0),
  latitudeOverride: real('latitudeOverride'),
  longitudeOverride: real('longitudeOverride'),
  altitudeOverride: real('altitudeOverride'),
  positionOverrideIsPrivate: integer('positionOverrideIsPrivate').default(0),
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
  positionOverrideEnabled: pgInteger('positionOverrideEnabled').default(0),
  latitudeOverride: pgReal('latitudeOverride'),
  longitudeOverride: pgReal('longitudeOverride'),
  altitudeOverride: pgReal('altitudeOverride'),
  positionOverrideIsPrivate: pgInteger('positionOverrideIsPrivate').default(0),
  // Timestamps
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type NodeSqlite = typeof nodesSqlite.$inferSelect;
export type NewNodeSqlite = typeof nodesSqlite.$inferInsert;
export type NodePostgres = typeof nodesPostgres.$inferSelect;
export type NewNodePostgres = typeof nodesPostgres.$inferInsert;
