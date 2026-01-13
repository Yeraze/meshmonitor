/**
 * Drizzle schema definition for miscellaneous tables
 * Includes: backup_history, system_backup_history, custom_themes, user_map_preferences, upgrade_history
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial, doublePrecision as pgDoublePrecision } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint, serial as mySerial } from 'drizzle-orm/mysql-core';
import { usersSqlite, usersPostgres, usersMysql } from './auth.js';

// ============ BACKUP HISTORY ============

export const backupHistorySqlite = sqliteTable('backup_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeId: text('nodeId'),
  nodeNum: integer('nodeNum'),
  filename: text('filename').notNull(),
  filePath: text('filePath').notNull(),
  fileSize: integer('fileSize'),
  backupType: text('backupType').notNull(), // 'auto' or 'manual'
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

export const backupHistoryPostgres = pgTable('backup_history', {
  id: pgSerial('id').primaryKey(),
  nodeId: pgText('nodeId'),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }),
  filename: pgText('filename').notNull(),
  filePath: pgText('filePath').notNull(),
  fileSize: pgInteger('fileSize'),
  backupType: pgText('backupType').notNull(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ SYSTEM BACKUP HISTORY ============

export const systemBackupHistorySqlite = sqliteTable('system_backup_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  backupPath: text('backupPath').notNull(),
  backupType: text('backupType').notNull(), // 'auto' or 'manual'
  schemaVersion: integer('schemaVersion'),
  appVersion: text('appVersion'),
  totalSize: integer('totalSize'),
  tableCount: integer('tableCount'),
  rowCount: integer('rowCount'),
  timestamp: integer('timestamp').notNull(),
  createdAt: integer('createdAt').notNull(),
});

export const systemBackupHistoryPostgres = pgTable('system_backup_history', {
  id: pgSerial('id').primaryKey(),
  backupPath: pgText('backupPath').notNull(),
  backupType: pgText('backupType').notNull(),
  schemaVersion: pgInteger('schemaVersion'),
  appVersion: pgText('appVersion'),
  totalSize: pgInteger('totalSize'),
  tableCount: pgInteger('tableCount'),
  rowCount: pgInteger('rowCount'),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ CUSTOM THEMES ============

export const customThemesSqlite = sqliteTable('custom_themes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  definition: text('definition').notNull(), // JSON string
  is_builtin: integer('is_builtin', { mode: 'boolean' }).default(false),
  created_by: integer('created_by').references(() => usersSqlite.id, { onDelete: 'set null' }),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
});

export const customThemesPostgres = pgTable('custom_themes', {
  id: pgSerial('id').primaryKey(),
  name: pgText('name').notNull(),
  slug: pgText('slug').notNull().unique(),
  definition: pgText('definition').notNull(), // JSON string
  is_builtin: pgBoolean('is_builtin').default(false),
  created_by: pgInteger('created_by').references(() => usersPostgres.id, { onDelete: 'set null' }),
  created_at: pgBigint('created_at', { mode: 'number' }).notNull(),
  updated_at: pgBigint('updated_at', { mode: 'number' }).notNull(),
});

// ============ USER MAP PREFERENCES ============

export const userMapPreferencesSqlite = sqliteTable('user_map_preferences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('userId').notNull().references(() => usersSqlite.id, { onDelete: 'cascade' }),
  centerLat: real('centerLat'),
  centerLng: real('centerLng'),
  zoom: real('zoom'),
  selectedLayer: text('selectedLayer'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

export const userMapPreferencesPostgres = pgTable('user_map_preferences', {
  id: pgSerial('id').primaryKey(),
  userId: pgInteger('userId').notNull().references(() => usersPostgres.id, { onDelete: 'cascade' }),
  centerLat: pgReal('centerLat'),
  centerLng: pgReal('centerLng'),
  zoom: pgReal('zoom'),
  selectedLayer: pgText('selectedLayer'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ UPGRADE HISTORY ============

export const upgradeHistorySqlite = sqliteTable('upgrade_history', {
  id: text('id').primaryKey(),
  fromVersion: text('fromVersion').notNull(),
  toVersion: text('toVersion').notNull(),
  deploymentMethod: text('deploymentMethod').notNull(),
  status: text('status').notNull(),
  progress: integer('progress').default(0),
  currentStep: text('currentStep'),
  logs: text('logs'),
  backupPath: text('backupPath'),
  startedAt: integer('startedAt'),
  completedAt: integer('completedAt'),
  initiatedBy: text('initiatedBy'),
  errorMessage: text('errorMessage'),
  rollbackAvailable: integer('rollbackAvailable', { mode: 'boolean' }),
});

export const upgradeHistoryPostgres = pgTable('upgrade_history', {
  id: pgText('id').primaryKey(),
  fromVersion: pgText('fromVersion').notNull(),
  toVersion: pgText('toVersion').notNull(),
  deploymentMethod: pgText('deploymentMethod').notNull(),
  status: pgText('status').notNull(),
  progress: pgInteger('progress').default(0),
  currentStep: pgText('currentStep'),
  logs: pgText('logs'),
  backupPath: pgText('backupPath'),
  startedAt: pgBigint('startedAt', { mode: 'number' }),
  completedAt: pgBigint('completedAt', { mode: 'number' }),
  initiatedBy: pgText('initiatedBy'),
  errorMessage: pgText('errorMessage'),
  rollbackAvailable: pgBoolean('rollbackAvailable'),
});

// ============ SOLAR ESTIMATES ============
// Stores forecast data from forecast.solar API

export const solarEstimatesSqlite = sqliteTable('solar_estimates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  timestamp: integer('timestamp').notNull().unique(),
  watt_hours: real('watt_hours').notNull(),
  fetched_at: integer('fetched_at').notNull(),
  created_at: integer('created_at'),
});

export const solarEstimatesPostgres = pgTable('solar_estimates', {
  id: pgSerial('id').primaryKey(),
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull().unique(),
  watt_hours: pgDoublePrecision('watt_hours').notNull(),
  fetched_at: pgBigint('fetched_at', { mode: 'number' }).notNull(),
  created_at: pgBigint('created_at', { mode: 'number' }),
});

// ============ AUTO TRACEROUTE NODES ============

export const autoTracerouteNodesSqlite = sqliteTable('auto_traceroute_nodes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeNum: integer('nodeNum').notNull().unique(),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  createdAt: integer('createdAt').notNull(),
});

export const autoTracerouteNodesPostgres = pgTable('auto_traceroute_nodes', {
  id: pgSerial('id').primaryKey(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull().unique(),
  enabled: pgBoolean('enabled').default(true),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MYSQL SCHEMAS ============

export const backupHistoryMysql = mysqlTable('backup_history', {
  id: mySerial('id').primaryKey(),
  nodeId: myVarchar('nodeId', { length: 32 }),
  nodeNum: myBigint('nodeNum', { mode: 'number' }),
  filename: myVarchar('filename', { length: 255 }).notNull(),
  filePath: myVarchar('filePath', { length: 512 }).notNull(),
  fileSize: myInt('fileSize'),
  backupType: myVarchar('backupType', { length: 32 }).notNull(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

export const systemBackupHistoryMysql = mysqlTable('system_backup_history', {
  id: mySerial('id').primaryKey(),
  backupPath: myVarchar('backupPath', { length: 512 }).notNull(),
  backupType: myVarchar('backupType', { length: 32 }).notNull(),
  schemaVersion: myInt('schemaVersion'),
  appVersion: myVarchar('appVersion', { length: 32 }),
  totalSize: myInt('totalSize'),
  tableCount: myInt('tableCount'),
  rowCount: myInt('rowCount'),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

export const customThemesMysql = mysqlTable('custom_themes', {
  id: mySerial('id').primaryKey(),
  name: myVarchar('name', { length: 128 }).notNull(),
  slug: myVarchar('slug', { length: 128 }).notNull().unique(),
  definition: myText('definition').notNull(), // JSON string
  is_builtin: myBoolean('is_builtin').default(false),
  created_by: myInt('created_by').references(() => usersMysql.id, { onDelete: 'set null' }),
  created_at: myBigint('created_at', { mode: 'number' }).notNull(),
  updated_at: myBigint('updated_at', { mode: 'number' }).notNull(),
});

export const userMapPreferencesMysql = mysqlTable('user_map_preferences', {
  id: mySerial('id').primaryKey(),
  userId: myInt('userId').notNull().references(() => usersMysql.id, { onDelete: 'cascade' }),
  centerLat: myDouble('centerLat'),
  centerLng: myDouble('centerLng'),
  zoom: myDouble('zoom'),
  selectedLayer: myVarchar('selectedLayer', { length: 64 }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export const upgradeHistoryMysql = mysqlTable('upgrade_history', {
  id: myVarchar('id', { length: 64 }).primaryKey(),
  fromVersion: myVarchar('fromVersion', { length: 32 }).notNull(),
  toVersion: myVarchar('toVersion', { length: 32 }).notNull(),
  deploymentMethod: myVarchar('deploymentMethod', { length: 32 }).notNull(),
  status: myVarchar('status', { length: 32 }).notNull(),
  progress: myInt('progress').default(0),
  currentStep: myVarchar('currentStep', { length: 255 }),
  logs: myText('logs'),
  backupPath: myVarchar('backupPath', { length: 512 }),
  startedAt: myBigint('startedAt', { mode: 'number' }),
  completedAt: myBigint('completedAt', { mode: 'number' }),
  initiatedBy: myVarchar('initiatedBy', { length: 255 }),
  errorMessage: myText('errorMessage'),
  rollbackAvailable: myBoolean('rollbackAvailable'),
});

export const solarEstimatesMysql = mysqlTable('solar_estimates', {
  id: mySerial('id').primaryKey(),
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull().unique(),
  watt_hours: myDouble('watt_hours').notNull(),
  fetched_at: myBigint('fetched_at', { mode: 'number' }).notNull(),
  created_at: myBigint('created_at', { mode: 'number' }),
});

export const autoTracerouteNodesMysql = mysqlTable('auto_traceroute_nodes', {
  id: mySerial('id').primaryKey(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull().unique(),
  enabled: myBoolean('enabled').default(true),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// Type inference exports
export type BackupHistorySqlite = typeof backupHistorySqlite.$inferSelect;
export type NewBackupHistorySqlite = typeof backupHistorySqlite.$inferInsert;
export type BackupHistoryPostgres = typeof backupHistoryPostgres.$inferSelect;
export type NewBackupHistoryPostgres = typeof backupHistoryPostgres.$inferInsert;

export type SystemBackupHistorySqlite = typeof systemBackupHistorySqlite.$inferSelect;
export type NewSystemBackupHistorySqlite = typeof systemBackupHistorySqlite.$inferInsert;
export type SystemBackupHistoryPostgres = typeof systemBackupHistoryPostgres.$inferSelect;
export type NewSystemBackupHistoryPostgres = typeof systemBackupHistoryPostgres.$inferInsert;

export type CustomThemeSqlite = typeof customThemesSqlite.$inferSelect;
export type NewCustomThemeSqlite = typeof customThemesSqlite.$inferInsert;
export type CustomThemePostgres = typeof customThemesPostgres.$inferSelect;
export type NewCustomThemePostgres = typeof customThemesPostgres.$inferInsert;

export type UserMapPreferenceSqlite = typeof userMapPreferencesSqlite.$inferSelect;
export type NewUserMapPreferenceSqlite = typeof userMapPreferencesSqlite.$inferInsert;
export type UserMapPreferencePostgres = typeof userMapPreferencesPostgres.$inferSelect;
export type NewUserMapPreferencePostgres = typeof userMapPreferencesPostgres.$inferInsert;

export type UpgradeHistorySqlite = typeof upgradeHistorySqlite.$inferSelect;
export type NewUpgradeHistorySqlite = typeof upgradeHistorySqlite.$inferInsert;
export type UpgradeHistoryPostgres = typeof upgradeHistoryPostgres.$inferSelect;
export type NewUpgradeHistoryPostgres = typeof upgradeHistoryPostgres.$inferInsert;

export type SolarEstimateSqlite = typeof solarEstimatesSqlite.$inferSelect;
export type NewSolarEstimateSqlite = typeof solarEstimatesSqlite.$inferInsert;
export type SolarEstimatePostgres = typeof solarEstimatesPostgres.$inferSelect;
export type NewSolarEstimatePostgres = typeof solarEstimatesPostgres.$inferInsert;

export type AutoTracerouteNodeSqlite = typeof autoTracerouteNodesSqlite.$inferSelect;
export type NewAutoTracerouteNodeSqlite = typeof autoTracerouteNodesSqlite.$inferInsert;
export type AutoTracerouteNodePostgres = typeof autoTracerouteNodesPostgres.$inferSelect;
export type NewAutoTracerouteNodePostgres = typeof autoTracerouteNodesPostgres.$inferInsert;
export type AutoTracerouteNodeMysql = typeof autoTracerouteNodesMysql.$inferSelect;
export type NewAutoTracerouteNodeMysql = typeof autoTracerouteNodesMysql.$inferInsert;

export type BackupHistoryMysql = typeof backupHistoryMysql.$inferSelect;
export type NewBackupHistoryMysql = typeof backupHistoryMysql.$inferInsert;
export type SystemBackupHistoryMysql = typeof systemBackupHistoryMysql.$inferSelect;
export type NewSystemBackupHistoryMysql = typeof systemBackupHistoryMysql.$inferInsert;
export type CustomThemeMysql = typeof customThemesMysql.$inferSelect;
export type NewCustomThemeMysql = typeof customThemesMysql.$inferInsert;
export type UserMapPreferenceMysql = typeof userMapPreferencesMysql.$inferSelect;
export type NewUserMapPreferenceMysql = typeof userMapPreferencesMysql.$inferInsert;
export type UpgradeHistoryMysql = typeof upgradeHistoryMysql.$inferSelect;
export type NewUpgradeHistoryMysql = typeof upgradeHistoryMysql.$inferInsert;
export type SolarEstimateMysql = typeof solarEstimatesMysql.$inferSelect;
export type NewSolarEstimateMysql = typeof solarEstimatesMysql.$inferInsert;
