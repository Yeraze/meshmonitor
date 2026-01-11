/**
 * Drizzle schema definition for the neighbor_info table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, real as pgReal, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { mysqlTable, double as myDouble, bigint as myBigint, serial as mySerial } from 'drizzle-orm/mysql-core';
import { nodesSqlite, nodesPostgres, nodesMysql } from './nodes.js';

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
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  neighborNodeNum: pgBigint('neighborNodeNum', { mode: 'number' }).notNull().references(() => nodesPostgres.nodeNum, { onDelete: 'cascade' }),
  snr: pgReal('snr'),
  lastRxTime: pgBigint('lastRxTime', { mode: 'number' }),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// MySQL schema
export const neighborInfoMysql = mysqlTable('neighbor_info', {
  id: mySerial('id').primaryKey(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  neighborNodeNum: myBigint('neighborNodeNum', { mode: 'number' }).notNull().references(() => nodesMysql.nodeNum, { onDelete: 'cascade' }),
  snr: myDouble('snr'),
  lastRxTime: myBigint('lastRxTime', { mode: 'number' }),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// Type inference
export type NeighborInfoSqlite = typeof neighborInfoSqlite.$inferSelect;
export type NewNeighborInfoSqlite = typeof neighborInfoSqlite.$inferInsert;
export type NeighborInfoPostgres = typeof neighborInfoPostgres.$inferSelect;
export type NewNeighborInfoPostgres = typeof neighborInfoPostgres.$inferInsert;
export type NeighborInfoMysql = typeof neighborInfoMysql.$inferSelect;
export type NewNeighborInfoMysql = typeof neighborInfoMysql.$inferInsert;
