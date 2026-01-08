/**
 * Drizzle schema definition for the traceroutes and route_segments tables
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { nodesSqlite, nodesPostgres } from './nodes.js';

// SQLite schemas
export const traceroutesSqlite = sqliteTable('traceroutes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromNodeNum: integer('fromNodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: integer('toNodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: text('fromNodeId').notNull(),
  toNodeId: text('toNodeId').notNull(),
  route: text('route'), // JSON string of intermediate nodes
  routeBack: text('routeBack'), // JSON string of return path
  snrTowards: text('snrTowards'), // JSON string of SNR values
  snrBack: text('snrBack'), // JSON string of return SNR values
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

export const routeSegmentsSqlite = sqliteTable('route_segments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromNodeNum: integer('fromNodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: integer('toNodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: text('fromNodeId').notNull(),
  toNodeId: text('toNodeId').notNull(),
  distanceKm: real('distanceKm').notNull(),
  isRecordHolder: integer('isRecordHolder', { mode: 'boolean' }).default(false),
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// PostgreSQL schemas
export const traceroutesPostgres = pgTable('traceroutes', {
  id: pgSerial('id').primaryKey(),
  fromNodeNum: pgInteger('fromNodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: pgInteger('toNodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: pgText('fromNodeId').notNull(),
  toNodeId: pgText('toNodeId').notNull(),
  route: pgText('route'), // JSON string of intermediate nodes
  routeBack: pgText('routeBack'), // JSON string of return path
  snrTowards: pgText('snrTowards'), // JSON string of SNR values
  snrBack: pgText('snrBack'), // JSON string of return SNR values
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

export const routeSegmentsPostgres = pgTable('route_segments', {
  id: pgSerial('id').primaryKey(),
  fromNodeNum: pgInteger('fromNodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: pgInteger('toNodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: pgText('fromNodeId').notNull(),
  toNodeId: pgText('toNodeId').notNull(),
  distanceKm: pgReal('distanceKm').notNull(),
  isRecordHolder: pgBoolean('isRecordHolder').default(false),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// Type inference
export type TracerouteSqlite = typeof traceroutesSqlite.$inferSelect;
export type NewTracerouteSqlite = typeof traceroutesSqlite.$inferInsert;
export type TraceroutePostgres = typeof traceroutesPostgres.$inferSelect;
export type NewTraceroutePostgres = typeof traceroutesPostgres.$inferInsert;

export type RouteSegmentSqlite = typeof routeSegmentsSqlite.$inferSelect;
export type NewRouteSegmentSqlite = typeof routeSegmentsSqlite.$inferInsert;
export type RouteSegmentPostgres = typeof routeSegmentsPostgres.$inferSelect;
export type NewRouteSegmentPostgres = typeof routeSegmentsPostgres.$inferInsert;
