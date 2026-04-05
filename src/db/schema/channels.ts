/**
 * Drizzle schema definition for the channels table
 * Supports SQLite, PostgreSQL, and MySQL
 *
 * Each source has its own independent channel slots (0-7).
 * The composite unique key (sourceId, id) ensures per-source isolation.
 * A surrogate `pk` column is the actual primary key so Drizzle can do
 * ON CONFLICT upserts on the composite key.
 */
import {
  sqliteTable, text, integer, uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  pgTable, text as pgText, integer as pgInteger,
  boolean as pgBoolean, bigint as pgBigint, serial as pgSerial,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable, varchar as myVarchar, int as myInt,
  boolean as myBoolean, bigint as myBigint,
} from 'drizzle-orm/mysql-core';

// SQLite schema
export const channelsSqlite = sqliteTable('channels', {
  pk: integer('pk').primaryKey({ autoIncrement: true }),
  id: integer('id').notNull(),
  name: text('name').notNull(),
  psk: text('psk'),
  role: integer('role'),
  uplinkEnabled: integer('uplinkEnabled', { mode: 'boolean' }).notNull().default(true),
  downlinkEnabled: integer('downlinkEnabled', { mode: 'boolean' }).notNull().default(true),
  positionPrecision: integer('positionPrecision'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
  sourceId: text('sourceId'),
}, (t) => ({
  sourceChannelUniq: uniqueIndex('channels_source_id_idx').on(t.sourceId, t.id),
}));

// PostgreSQL schema
export const channelsPostgres = pgTable('channels', {
  pk: pgSerial('pk').primaryKey(),
  id: pgInteger('id').notNull(),
  name: pgText('name').notNull(),
  psk: pgText('psk'),
  role: pgInteger('role'),
  uplinkEnabled: pgBoolean('uplinkEnabled').notNull().default(true),
  downlinkEnabled: pgBoolean('downlinkEnabled').notNull().default(true),
  positionPrecision: pgInteger('positionPrecision'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
  sourceId: pgText('sourceId'),
});

// MySQL schema
export const channelsMysql = mysqlTable('channels', {
  pk: myInt('pk').autoincrement().primaryKey(),
  id: myInt('id').notNull(),
  name: myVarchar('name', { length: 64 }).notNull(),
  psk: myVarchar('psk', { length: 64 }),
  role: myInt('role'),
  uplinkEnabled: myBoolean('uplinkEnabled').notNull().default(true),
  downlinkEnabled: myBoolean('downlinkEnabled').notNull().default(true),
  positionPrecision: myInt('positionPrecision'),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
  sourceId: myVarchar('sourceId', { length: 36 }),
});

// Type inference
export type ChannelSqlite = typeof channelsSqlite.$inferSelect;
export type NewChannelSqlite = typeof channelsSqlite.$inferInsert;
export type ChannelPostgres = typeof channelsPostgres.$inferSelect;
export type NewChannelPostgres = typeof channelsPostgres.$inferInsert;
export type ChannelMysql = typeof channelsMysql.$inferSelect;
export type NewChannelMysql = typeof channelsMysql.$inferInsert;
