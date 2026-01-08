/**
 * Drizzle schema definition for the neighbor_info table
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, integer as pgInteger, real as pgReal, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { nodesSqlite, nodesPostgres } from './nodes.js';

// SQLite schema
export const neighborInfoSqlite = sqliteTable('neighbor_info', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeNum: integer('nodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  neighborNodeNum: integer('neighborNodeNum').notNull().references(() => nodesSqlite.nodeNum, { onDelete: 'cascade' }),
  snr: real('snr'),
  lastRxTime: integer('lastRxTime'),
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

// PostgreSQL schema
export const neighborInfoPostgres = pgTable('neighbor_info', {
  id: pgSerial('id').primaryKey(),
  nodeNum: pgInteger('nodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  neighborNodeNum: pgInteger('neighborNodeNum').notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  snr: pgReal('snr'),
  lastRxTime: pgBigint('lastRxTime', { mode: 'number' }),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// Type inference
export type NeighborInfoSqlite = typeof neighborInfoSqlite.$inferSelect;
export type NewNeighborInfoSqlite = typeof neighborInfoSqlite.$inferInsert;
export type NeighborInfoPostgres = typeof neighborInfoPostgres.$inferSelect;
export type NewNeighborInfoPostgres = typeof neighborInfoPostgres.$inferInsert;
