/**
 * Drizzle schema definition for the traceroutes and route_segments tables
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, real as pgReal, doublePrecision as pgDouble, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, double as myDouble, boolean as myBoolean, bigint as myBigint, serial as mySerial } from 'drizzle-orm/mysql-core';
import { nodesSqlite, nodesPostgres, nodesMysql } from './nodes.js';

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
  routePositions: text('routePositions'), // JSON: { nodeNum: { lat, lng, alt? } } position snapshot at traceroute time
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
  fromLatitude: real('fromLatitude'), // latitude of fromNode at recording time
  fromLongitude: real('fromLongitude'), // longitude of fromNode at recording time
  toLatitude: real('toLatitude'), // latitude of toNode at recording time
  toLongitude: real('toLongitude'), // longitude of toNode at recording time
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// PostgreSQL schemas
export const traceroutesPostgres = pgTable('traceroutes', {
  id: pgSerial('id').primaryKey(),
  fromNodeNum: pgBigint('fromNodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: pgBigint('toNodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: pgText('fromNodeId').notNull(),
  toNodeId: pgText('toNodeId').notNull(),
  route: pgText('route'), // JSON string of intermediate nodes
  routeBack: pgText('routeBack'), // JSON string of return path
  snrTowards: pgText('snrTowards'), // JSON string of SNR values
  snrBack: pgText('snrBack'), // JSON string of return SNR values
  routePositions: pgText('routePositions'), // JSON: { nodeNum: { lat, lng, alt? } } position snapshot at traceroute time
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

export const routeSegmentsPostgres = pgTable('route_segments', {
  id: pgSerial('id').primaryKey(),
  fromNodeNum: pgBigint('fromNodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: pgBigint('toNodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: pgText('fromNodeId').notNull(),
  toNodeId: pgText('toNodeId').notNull(),
  distanceKm: pgReal('distanceKm').notNull(),
  isRecordHolder: pgBoolean('isRecordHolder').default(false),
  fromLatitude: pgDouble('fromLatitude'), // latitude of fromNode at recording time
  fromLongitude: pgDouble('fromLongitude'), // longitude of fromNode at recording time
  toLatitude: pgDouble('toLatitude'), // latitude of toNode at recording time
  toLongitude: pgDouble('toLongitude'), // longitude of toNode at recording time
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// MySQL schemas
export const traceroutesMysql = mysqlTable('traceroutes', {
  id: mySerial('id').primaryKey(),
  fromNodeNum: myBigint('fromNodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: myBigint('toNodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: myVarchar('fromNodeId', { length: 32 }).notNull(),
  toNodeId: myVarchar('toNodeId', { length: 32 }).notNull(),
  route: myText('route'), // JSON string of intermediate nodes
  routeBack: myText('routeBack'), // JSON string of return path
  snrTowards: myText('snrTowards'), // JSON string of SNR values
  snrBack: myText('snrBack'), // JSON string of return SNR values
  routePositions: myText('routePositions'), // JSON: { nodeNum: { lat, lng, alt? } } position snapshot at traceroute time
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

export const routeSegmentsMysql = mysqlTable('route_segments', {
  id: mySerial('id').primaryKey(),
  fromNodeNum: myBigint('fromNodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  toNodeNum: myBigint('toNodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  fromNodeId: myVarchar('fromNodeId', { length: 32 }).notNull(),
  toNodeId: myVarchar('toNodeId', { length: 32 }).notNull(),
  distanceKm: myDouble('distanceKm').notNull(),
  isRecordHolder: myBoolean('isRecordHolder').default(false),
  fromLatitude: myDouble('fromLatitude'), // latitude of fromNode at recording time
  fromLongitude: myDouble('fromLongitude'), // longitude of fromNode at recording time
  toLatitude: myDouble('toLatitude'), // latitude of toNode at recording time
  toLongitude: myDouble('toLongitude'), // longitude of toNode at recording time
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// Type inference
export type TracerouteSqlite = typeof traceroutesSqlite.$inferSelect;
export type NewTracerouteSqlite = typeof traceroutesSqlite.$inferInsert;
export type TraceroutePostgres = typeof traceroutesPostgres.$inferSelect;
export type NewTraceroutePostgres = typeof traceroutesPostgres.$inferInsert;
export type TracerouteMysql = typeof traceroutesMysql.$inferSelect;
export type NewTracerouteMysql = typeof traceroutesMysql.$inferInsert;

export type RouteSegmentSqlite = typeof routeSegmentsSqlite.$inferSelect;
export type NewRouteSegmentSqlite = typeof routeSegmentsSqlite.$inferInsert;
export type RouteSegmentPostgres = typeof routeSegmentsPostgres.$inferSelect;
export type NewRouteSegmentPostgres = typeof routeSegmentsPostgres.$inferInsert;
export type RouteSegmentMysql = typeof routeSegmentsMysql.$inferSelect;
export type NewRouteSegmentMysql = typeof routeSegmentsMysql.$inferInsert;
