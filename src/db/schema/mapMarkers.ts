/**
 * Drizzle schema for `map_markers` (issue #5686, local map markers).
 *
 * A local marker is a planning note on the map — a candidate repeater site, a
 * survey point, a landmark. It lives only in MeshMonitor's database and is
 * NEVER transmitted: no code path from these rows reaches a radio manager.
 * That is the whole difference from a waypoint, which is broadcast.
 *
 * PER-SOURCE — every row carries a `sourceId`. Anyone who can read that
 * source's waypoints sees its markers; editing needs waypoint write on it.
 * Rows go when their source is deleted.
 *
 * `icon` and `color` are keys from small fixed sets (`src/types/mapMarker.ts`),
 * never free-form CSS: the map renders them through theme tokens.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, doublePrecision as pgDouble } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, double as myDouble, text as myText } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const mapMarkersSqlite = sqliteTable('map_markers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceId: text('sourceId').notNull(),
  label: text('label').notNull(),
  description: text('description'),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  altitude: real('altitude'),
  icon: text('icon').notNull(),
  color: text('color').notNull(),
  createdByUserId: integer('createdByUserId'),
  createdAt: integer('createdAt').notNull(),
  updatedAt: integer('updatedAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const mapMarkersPostgres = pgTable('map_markers', {
  id: pgSerial('id').primaryKey(),
  sourceId: pgText('sourceId').notNull(),
  label: pgText('label').notNull(),
  description: pgText('description'),
  latitude: pgDouble('latitude').notNull(),
  longitude: pgDouble('longitude').notNull(),
  altitude: pgDouble('altitude'),
  icon: pgText('icon').notNull(),
  color: pgText('color').notNull(),
  createdByUserId: pgBigint('createdByUserId', { mode: 'number' }),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const mapMarkersMysql = mysqlTable('map_markers', {
  id: myInt('id').autoincrement().primaryKey(),
  sourceId: myVarchar('sourceId', { length: 64 }).notNull(),
  label: myVarchar('label', { length: 64 }).notNull(),
  description: myText('description'),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  altitude: myDouble('altitude'),
  icon: myVarchar('icon', { length: 16 }).notNull(),
  color: myVarchar('color', { length: 16 }).notNull(),
  createdByUserId: myBigint('createdByUserId', { mode: 'number' }),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MapMarkerSqlite = typeof mapMarkersSqlite.$inferSelect;
export type MapMarkerPostgres = typeof mapMarkersPostgres.$inferSelect;
export type MapMarkerMysql = typeof mapMarkersMysql.$inferSelect;
