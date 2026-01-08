/**
 * Drizzle schema definition for the settings table
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint } from 'drizzle-orm/pg-core';

// SQLite schema
export const settingsSqlite = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL schema
export const settingsPostgres = pgTable('settings', {
  key: pgText('key').primaryKey(),
  value: pgText('value').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type SettingSqlite = typeof settingsSqlite.$inferSelect;
export type NewSettingSqlite = typeof settingsSqlite.$inferInsert;
export type SettingPostgres = typeof settingsPostgres.$inferSelect;
export type NewSettingPostgres = typeof settingsPostgres.$inferInsert;
