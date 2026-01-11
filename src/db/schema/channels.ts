/**
 * Drizzle schema definition for the channels table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite schema
export const channelsSqlite = sqliteTable('channels', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  psk: text('psk'),
  role: integer('role'), // 0=Disabled, 1=Primary, 2=Secondary
  uplinkEnabled: integer('uplinkEnabled', { mode: 'boolean' }).notNull().default(true),
  downlinkEnabled: integer('downlinkEnabled', { mode: 'boolean' }).notNull().default(true),
  positionPrecision: integer('positionPrecision'), // Location precision bits (0-32)
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL schema
export const channelsPostgres = pgTable('channels', {
  id: pgInteger('id').primaryKey(),
  name: pgText('name').notNull(),
  psk: pgText('psk'),
  role: pgInteger('role'), // 0=Disabled, 1=Primary, 2=Secondary
  uplinkEnabled: pgBoolean('uplinkEnabled').notNull().default(true),
  downlinkEnabled: pgBoolean('downlinkEnabled').notNull().default(true),
  positionPrecision: pgInteger('positionPrecision'), // Location precision bits (0-32)
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL schema
export const channelsMysql = mysqlTable('channels', {
  id: myInt('id').primaryKey(),
  name: myVarchar('name', { length: 64 }).notNull(),
  psk: myVarchar('psk', { length: 64 }),
  role: myInt('role'), // 0=Disabled, 1=Primary, 2=Secondary
  uplinkEnabled: myBoolean('uplinkEnabled').notNull().default(true),
  downlinkEnabled: myBoolean('downlinkEnabled').notNull().default(true),
  positionPrecision: myInt('positionPrecision'), // Location precision bits (0-32)
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type ChannelSqlite = typeof channelsSqlite.$inferSelect;
export type NewChannelSqlite = typeof channelsSqlite.$inferInsert;
export type ChannelPostgres = typeof channelsPostgres.$inferSelect;
export type NewChannelPostgres = typeof channelsPostgres.$inferInsert;
export type ChannelMysql = typeof channelsMysql.$inferSelect;
export type NewChannelMysql = typeof channelsMysql.$inferInsert;
