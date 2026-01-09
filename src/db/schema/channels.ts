/**
 * Drizzle schema definition for the channels table
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';

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

// Type inference
export type ChannelSqlite = typeof channelsSqlite.$inferSelect;
export type NewChannelSqlite = typeof channelsSqlite.$inferInsert;
export type ChannelPostgres = typeof channelsPostgres.$inferSelect;
export type NewChannelPostgres = typeof channelsPostgres.$inferInsert;
