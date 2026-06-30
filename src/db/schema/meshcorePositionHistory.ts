/**
 * Drizzle schema definition for the MeshCore position-history table.
 * Supports SQLite, PostgreSQL, and MySQL.
 *
 * One row per *distinct* GPS fix observed for a MeshCore node, recorded
 * whenever a node's position changes (via contact adverts or the Cayenne-LPP
 * telemetry poll — see `MeshCoreRepository.upsertNode`). This is the MeshCore
 * analogue of the Meshtastic position-history trail (issue #3852), letting the
 * MeshCore map draw a movement polyline per node.
 *
 * Retention is a rolling window swept by `meshcorePositionHistoryService`
 * (default 7 days, configurable via `meshcore_position_history_retention_days`).
 *
 * MeshCore identifies nodes by 64-char hex public key, so rows are keyed by
 * `(sourceId, publicKey)` + `timestamp` rather than a numeric nodeNum.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, integer as pgInteger, doublePrecision as pgDoublePrecision, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, double as myDouble, serial as mySerial, bigint as myBigint } from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const meshcorePositionHistorySqlite = sqliteTable('meshcore_position_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** Owning source — every row is source-scoped (mandatory per CLAUDE.md). */
  sourceId: text('sourceId').notNull(),
  /** 64-char hex public key of the node this fix belongs to. */
  publicKey: text('publicKey').notNull(),
  /** Fix latitude in decimal degrees. */
  latitude: real('latitude').notNull(),
  /** Fix longitude in decimal degrees. */
  longitude: real('longitude').notNull(),
  /** Fix altitude in metres, when reported. */
  altitude: real('altitude'),
  /** Fix time (ms epoch) — the node's lastHeard at capture, used for ordering + retention. */
  timestamp: integer('timestamp').notNull(),
  /** Server insert time (ms epoch). */
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const meshcorePositionHistoryPostgres = pgTable('meshcore_position_history', {
  id: pgInteger('id').primaryKey().generatedAlwaysAsIdentity(),
  sourceId: pgText('sourceId').notNull(),
  publicKey: pgText('publicKey').notNull(),
  latitude: pgDoublePrecision('latitude').notNull(),
  longitude: pgDoublePrecision('longitude').notNull(),
  altitude: pgDoublePrecision('altitude'),
  // ms-epoch timestamps overflow 32-bit INTEGER (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: pgBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const meshcorePositionHistoryMysql = mysqlTable('meshcore_position_history', {
  id: mySerial('id').primaryKey(),
  sourceId: myVarchar('sourceId', { length: 255 }).notNull(),
  publicKey: myVarchar('publicKey', { length: 64 }).notNull(),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  altitude: myDouble('altitude'),
  // ms-epoch timestamps overflow 32-bit INT (~2.1e9); JS Date.now() is ~1.8e12.
  timestamp: myBigint('timestamp', { mode: 'number' }).notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ Type Inference ============

export type MeshCorePositionHistorySqlite = typeof meshcorePositionHistorySqlite.$inferSelect;
export type NewMeshCorePositionHistorySqlite = typeof meshcorePositionHistorySqlite.$inferInsert;
export type MeshCorePositionHistoryPostgres = typeof meshcorePositionHistoryPostgres.$inferSelect;
export type NewMeshCorePositionHistoryPostgres = typeof meshcorePositionHistoryPostgres.$inferInsert;
export type MeshCorePositionHistoryMysql = typeof meshcorePositionHistoryMysql.$inferSelect;
export type NewMeshCorePositionHistoryMysql = typeof meshcorePositionHistoryMysql.$inferInsert;
