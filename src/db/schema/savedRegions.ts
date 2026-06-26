/**
 * Drizzle schema for the MeshCore saved-regions catalog (#3770).
 * Supports SQLite, PostgreSQL, and MySQL.
 *
 * `meshcore_saved_regions` is GLOBAL by design (no sourceId). A MeshCore
 * "scope" is a transport code derived purely from a region NAME
 * (sha256("#region")[:16]); it is not bound to a source/node, so the saved
 * catalog of region names applies across every MeshCore source. This mirrors
 * the global-by-design tables `channel_database` and `automations`.
 *
 * `name` is stored normalized (lowercase, no leading '#', letters/digits/hyphen
 * only) and is unique — the catalog is a de-duplicated list of region names.
 */
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, bigint as pgBigint, serial as pgSerial, uniqueIndex as pgUniqueIndex } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, int as myInt, bigint as myBigint, uniqueIndex as myUniqueIndex } from 'drizzle-orm/mysql-core';

// SQLite
export const meshcoreSavedRegionsSqlite = sqliteTable('meshcore_saved_regions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  note: text('note'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => ({
  nameUniq: uniqueIndex('meshcore_saved_regions_name_idx').on(t.name),
}));

// PostgreSQL
export const meshcoreSavedRegionsPostgres = pgTable('meshcore_saved_regions', {
  id: pgSerial('id').primaryKey(),
  name: pgText('name').notNull(),
  note: pgText('note'),
  createdAt: pgBigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: pgBigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  nameUniq: pgUniqueIndex('meshcore_saved_regions_name_idx').on(t.name),
}));

// MySQL
export const meshcoreSavedRegionsMysql = mysqlTable('meshcore_saved_regions', {
  id: myInt('id').primaryKey().autoincrement(),
  name: myVarchar('name', { length: 64 }).notNull(),
  note: myVarchar('note', { length: 255 }),
  createdAt: myBigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: myBigint('updated_at', { mode: 'number' }).notNull(),
}, (t) => ({
  nameUniq: myUniqueIndex('meshcore_saved_regions_name_idx').on(t.name),
}));

// Inferred types
export type MeshcoreSavedRegionSqlite = typeof meshcoreSavedRegionsSqlite.$inferSelect;
export type NewMeshcoreSavedRegionSqlite = typeof meshcoreSavedRegionsSqlite.$inferInsert;
export type MeshcoreSavedRegionPostgres = typeof meshcoreSavedRegionsPostgres.$inferSelect;
export type MeshcoreSavedRegionMysql = typeof meshcoreSavedRegionsMysql.$inferSelect;
