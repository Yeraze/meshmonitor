/**
 * Drizzle schema definition for the estimated_positions table.
 *
 * GLOBAL by design — there is intentionally NO `sourceId` column. Position
 * estimation pools traceroute + neighbor observations from ALL Meshtastic
 * sources (incl. MQTT) into a single best estimate per physical `nodeNum`, so
 * every source displays the same estimated location. This mirrors the existing
 * global-by-design `channel_database` carve-out documented in CLAUDE.md.
 *
 * One row per physical node (`nodeNum` is the primary key). Rows are written in
 * bulk by the scheduled positionEstimationService; no foreign key to `nodes`
 * because `nodes` is keyed by the composite (nodeNum, sourceId) and `nodeNum`
 * alone is not unique there.
 *
 * Supports SQLite, PostgreSQL, and MySQL.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { pgTable, text as pgText, real as pgReal, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, varchar as myVarchar, double as myDouble, bigint as myBigint, int as myInt } from 'drizzle-orm/mysql-core';

// SQLite schema
export const estimatedPositionsSqlite = sqliteTable('estimated_positions', {
  nodeNum: integer('nodeNum').primaryKey(),
  nodeId: text('nodeId').notNull(),
  latitude: real('latitude').notNull(),
  longitude: real('longitude').notNull(),
  // Confidence radius in kilometers derived from the spread of contributing observations.
  uncertaintyKm: real('uncertaintyKm'),
  // Number of observations that fed this estimate.
  observationCount: integer('observationCount').notNull().default(0),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL schema
export const estimatedPositionsPostgres = pgTable('estimated_positions', {
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).primaryKey(),
  nodeId: pgText('nodeId').notNull(),
  latitude: pgReal('latitude').notNull(),
  longitude: pgReal('longitude').notNull(),
  uncertaintyKm: pgReal('uncertaintyKm'),
  observationCount: pgBigint('observationCount', { mode: 'number' }).notNull().default(0),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL schema
export const estimatedPositionsMysql = mysqlTable('estimated_positions', {
  nodeNum: myBigint('nodeNum', { mode: 'number' }).primaryKey(),
  nodeId: myVarchar('nodeId', { length: 16 }).notNull(),
  latitude: myDouble('latitude').notNull(),
  longitude: myDouble('longitude').notNull(),
  uncertaintyKm: myDouble('uncertaintyKm'),
  observationCount: myInt('observationCount').notNull().default(0),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

// Type inference
export type EstimatedPositionSqlite = typeof estimatedPositionsSqlite.$inferSelect;
export type NewEstimatedPositionSqlite = typeof estimatedPositionsSqlite.$inferInsert;
export type EstimatedPositionPostgres = typeof estimatedPositionsPostgres.$inferSelect;
export type NewEstimatedPositionPostgres = typeof estimatedPositionsPostgres.$inferInsert;
export type EstimatedPositionMysql = typeof estimatedPositionsMysql.$inferSelect;
export type NewEstimatedPositionMysql = typeof estimatedPositionsMysql.$inferInsert;
