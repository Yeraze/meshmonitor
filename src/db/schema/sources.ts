/**
 * Drizzle schema definition for the sources table
 * Stores configured data sources (Meshtastic TCP nodes, MQTT brokers, MeshCore devices)
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite schema
export const sourcesSqlite = sqliteTable('sources', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  config: text('config').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  createdBy: integer('createdBy'),
});

// PostgreSQL schema
export const sourcesPostgres = pgTable('sources', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  type: pgText('type').notNull(),
  config: pgText('config').notNull(),
  enabled: pgBoolean('enabled').notNull().default(true),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  createdBy: pgInteger('createdBy'),
});

// MySQL schema
export const sourcesMysql = mysqlTable('sources', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  name: myVarchar('name', { length: 255 }).notNull(),
  type: myVarchar('type', { length: 32 }).notNull(),
  config: myVarchar('config', { length: 4096 }).notNull(),
  enabled: myBoolean('enabled').notNull().default(true),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  createdBy: myInt('createdBy'),
});

export type SourceSqlite = typeof sourcesSqlite.$inferSelect;
export type NewSourceSqlite = typeof sourcesSqlite.$inferInsert;
export type SourcePostgres = typeof sourcesPostgres.$inferSelect;
export type NewSourcePostgres = typeof sourcesPostgres.$inferInsert;
export type SourceMysql = typeof sourcesMysql.$inferSelect;
export type NewSourceMysql = typeof sourcesMysql.$inferInsert;
