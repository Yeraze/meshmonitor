/**
 * Drizzle schema definition for miscellaneous tables
 * Includes: backup_history, system_backup_history, custom_themes, user_map_preferences, upgrade_history
 * Supports both SQLite and PostgreSQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint, serial as pgSerial } from 'drizzle-orm/pg-core';
import { usersSqlite, usersPostgres } from './auth.js';

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

export const solarEstimatesSqlite = sqliteTable('solar_estimates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  nodeNum: integer('nodeNum').notNull(),
  estimatedWatts: real('estimatedWatts').notNull(),
  calculatedAt: integer('calculatedAt').notNull(),
  batteryVoltage: real('batteryVoltage'),
  batteryLevel: integer('batteryLevel'),
  channelUtilization: real('channelUtilization'),
  airUtilTx: real('airUtilTx'),
  createdAt: integer('createdAt').notNull(),
});

export const solarEstimatesPostgres = pgTable('solar_estimates', {
  id: pgSerial('id').primaryKey(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  estimatedWatts: pgReal('estimatedWatts').notNull(),
  calculatedAt: pgBigint('calculatedAt', { mode: 'number' }).notNull(),
  batteryVoltage: pgReal('batteryVoltage'),
  batteryLevel: pgInteger('batteryLevel'),
  channelUtilization: pgReal('channelUtilization'),
  airUtilTx: pgReal('airUtilTx'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
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
