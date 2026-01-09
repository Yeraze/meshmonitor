/**
 * Drizzle schema definition for the telemetry table
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { nodesSqlite, nodesPostgres } from './nodes.js';

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
  // Position precision tracking metadata
  channel: integer('channel'),
  precisionBits: integer('precisionBits'),
  gpsAccuracy: real('gpsAccuracy'),
});

// PostgreSQL schema
export const telemetryPostgres = pgTable('telemetry', {
  id: pgSerial('id').primaryKey(),
  nodeId: pgText('nodeId').notNull(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum),
  telemetryType: pgText('telemetryType').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  value: pgReal('value').notNull(),
  unit: pgText('unit'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  packetTimestamp: pgBigint('packetTimestamp', { mode: 'number' }),
  // Position precision tracking metadata
  channel: pgInteger('channel'),
  precisionBits: pgInteger('precisionBits'),
  gpsAccuracy: pgReal('gpsAccuracy'),
});

// Type inference
export type TelemetrySqlite = typeof telemetrySqlite.$inferSelect;
export type NewTelemetrySqlite = typeof telemetrySqlite.$inferInsert;
export type TelemetryPostgres = typeof telemetryPostgres.$inferSelect;
export type NewTelemetryPostgres = typeof telemetryPostgres.$inferInsert;
