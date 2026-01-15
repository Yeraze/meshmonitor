/**
 * Drizzle schema definition for the settings table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, bigint as myBigint } from 'drizzle-orm/mysql-core';

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

// MySQL schema
export const settingsMysql = mysqlTable('settings', {
  key: myVarchar('key', { length: 255 }).primaryKey(),
  value: myText('value').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type SettingSqlite = typeof settingsSqlite.$inferSelect;
export type NewSettingSqlite = typeof settingsSqlite.$inferInsert;
export type SettingPostgres = typeof settingsPostgres.$inferSelect;
export type NewSettingPostgres = typeof settingsPostgres.$inferInsert;
export type SettingMysql = typeof settingsMysql.$inferSelect;
export type NewSettingMysql = typeof settingsMysql.$inferInsert;
