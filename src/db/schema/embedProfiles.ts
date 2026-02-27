/**
 * Drizzle schema definition for the embed_profiles table
 * Supports SQLite, PostgreSQL, and MySQL
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, real as pgReal, boolean as pgBoolean, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, text as myText, int as myInt, double as myDouble, boolean as myBoolean, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite schema
export const embedProfilesSqlite = sqliteTable('embed_profiles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  channels: text('channels').notNull().default('[]'),
  tileset: text('tileset').notNull().default('osm'),
  defaultLat: real('defaultLat').notNull().default(0),
  defaultLng: real('defaultLng').notNull().default(0),
  defaultZoom: integer('defaultZoom').notNull().default(10),
  showTooltips: integer('showTooltips', { mode: 'boolean' }).notNull().default(true),
  showPopups: integer('showPopups', { mode: 'boolean' }).notNull().default(true),
  showLegend: integer('showLegend', { mode: 'boolean' }).notNull().default(true),
  showPaths: integer('showPaths', { mode: 'boolean' }).notNull().default(false),
  showNeighborInfo: integer('showNeighborInfo', { mode: 'boolean' }).notNull().default(false),
  showMqttNodes: integer('showMqttNodes', { mode: 'boolean' }).notNull().default(true),
  pollIntervalSeconds: integer('pollIntervalSeconds').notNull().default(30),
  allowedOrigins: text('allowedOrigins').notNull().default('[]'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL schema
export const embedProfilesPostgres = pgTable('embed_profiles', {
  id: pgText('id').primaryKey(),
  name: pgText('name').notNull(),
  enabled: pgBoolean('enabled').notNull().default(true),
  channels: pgText('channels').notNull().default('[]'),
  tileset: pgText('tileset').notNull().default('osm'),
  defaultLat: pgReal('defaultLat').notNull().default(0),
  defaultLng: pgReal('defaultLng').notNull().default(0),
  defaultZoom: pgInteger('defaultZoom').notNull().default(10),
  showTooltips: pgBoolean('showTooltips').notNull().default(true),
  showPopups: pgBoolean('showPopups').notNull().default(true),
  showLegend: pgBoolean('showLegend').notNull().default(true),
  showPaths: pgBoolean('showPaths').notNull().default(false),
  showNeighborInfo: pgBoolean('showNeighborInfo').notNull().default(false),
  showMqttNodes: pgBoolean('showMqttNodes').notNull().default(true),
  pollIntervalSeconds: pgInteger('pollIntervalSeconds').notNull().default(30),
  allowedOrigins: pgText('allowedOrigins').notNull().default('[]'),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL schema
export const embedProfilesMysql = mysqlTable('embed_profiles', {
  id: myVarchar('id', { length: 36 }).primaryKey(),
  name: myVarchar('name', { length: 255 }).notNull(),
  enabled: myBoolean('enabled').notNull().default(true),
  channels: myText('channels').notNull(),
  tileset: myVarchar('tileset', { length: 255 }).notNull().default('osm'),
  defaultLat: myDouble('defaultLat').notNull().default(0),
  defaultLng: myDouble('defaultLng').notNull().default(0),
  defaultZoom: myInt('defaultZoom').notNull().default(10),
  showTooltips: myBoolean('showTooltips').notNull().default(true),
  showPopups: myBoolean('showPopups').notNull().default(true),
  showLegend: myBoolean('showLegend').notNull().default(true),
  showPaths: myBoolean('showPaths').notNull().default(false),
  showNeighborInfo: myBoolean('showNeighborInfo').notNull().default(false),
  showMqttNodes: myBoolean('showMqttNodes').notNull().default(true),
  pollIntervalSeconds: myInt('pollIntervalSeconds').notNull().default(30),
  allowedOrigins: myText('allowedOrigins').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type EmbedProfileSqlite = typeof embedProfilesSqlite.$inferSelect;
export type NewEmbedProfileSqlite = typeof embedProfilesSqlite.$inferInsert;
export type EmbedProfilePostgres = typeof embedProfilesPostgres.$inferSelect;
export type NewEmbedProfilePostgres = typeof embedProfilesPostgres.$inferInsert;
export type EmbedProfileMysql = typeof embedProfilesMysql.$inferSelect;
export type NewEmbedProfileMysql = typeof embedProfilesMysql.$inferInsert;
