/**
 * Drizzle schema definition for the telemetry table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, doublePrecision as pgDoublePrecision, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, double as myDouble, bigint as myBigint, serial as mySerial } from 'drizzle-orm/mysql-core';
import { nodesSqlite, nodesPostgres, nodesMysql } from './nodes.js';

// SQLite schema
export const telemetrySqlite = sqliteTable('telemetry', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('nodeId').notNull(),
  nodeNum: integer('nodeNum').notNull().references(() => nodesSqlite.nodeNum),
  telemetryType: text('telemetryType').notNull(),
  timestamp: integer('timestamp').notNull(),
  value: real('value').notNull(),
  unit: text('unit'),
  createdAt: integer('createdAt').notNull(),
  packetTimestamp: integer('packetTimestamp'),
  packetId: integer('packetId'),
  // Position precision tracking metadata
  channel: integer('channel'),
  precisionBits: integer('precisionBits'),
  gpsAccuracy: real('gpsAccuracy'),
});

// PostgreSQL schema
// Note: Using doublePrecision for value to maintain coordinate precision (REAL only has ~7 significant digits)
export const telemetryPostgres = pgTable('telemetry', {
  id: pgSerial('id').primaryKey(),
  nodeId: pgText('nodeId').notNull(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum),
  telemetryType: pgText('telemetryType').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  value: pgDoublePrecision('value').notNull(),
  unit: pgText('unit'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  packetTimestamp: pgBigint('packetTimestamp', { mode: 'number' }),
  packetId: pgInteger('packetId'),
  // Position precision tracking metadata
  channel: pgInteger('channel'),
  precisionBits: pgInteger('precisionBits'),
  gpsAccuracy: pgDoublePrecision('gpsAccuracy'),
});

// MySQL schema
export const telemetryMysql = mysqlTable('telemetry', {
  id: mySerial('id').primaryKey(),
  nodeId: myVarchar('nodeId', { length: 32 }).notNull(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum),
  telemetryType: myVarchar('telemetryType', { length: 64 }).notNull(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  value: myDouble('value').notNull(),
  unit: myVarchar('unit', { length: 32 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  packetTimestamp: myBigint('packetTimestamp', { mode: 'number' }),
  packetId: myInt('packetId'),
  // Position precision tracking metadata
  channel: myInt('channel'),
  precisionBits: myInt('precisionBits'),
  gpsAccuracy: myDouble('gpsAccuracy'),
});

// Type inference
export type TelemetrySqlite = typeof telemetrySqlite.$inferSelect;
export type NewTelemetrySqlite = typeof telemetrySqlite.$inferInsert;
export type TelemetryPostgres = typeof telemetryPostgres.$inferSelect;
export type NewTelemetryPostgres = typeof telemetryPostgres.$inferInsert;
export type TelemetryMysql = typeof telemetryMysql.$inferSelect;
export type NewTelemetryMysql = typeof telemetryMysql.$inferInsert;
