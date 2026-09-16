/**
 * Drizzle schema for the `solar_node_overrides` table (issue #3195).
 *
 * Solar detection infers a panel from charge/discharge patterns in battery and
 * voltage telemetry. A node with a panel and battery bank far larger than its
 * load never shows that pattern — it sits near full all day — so the detector
 * misses it, and there is no way to tell MeshMonitor what the operator already
 * knows. This table records that knowledge: one row per node the operator has
 * explicitly classified.
 *
 * GLOBAL by design — there is intentionally NO `sourceId` column. Whether a
 * node has a solar panel is a fact about the physical hardware, not about which
 * source heard it, and the Solar Monitoring report already pools telemetry
 * across every source the viewer may read. A per-source flag would let the
 * same physical node be "solar" on one source and "not solar" on another.
 * Mirrors the `estimated_positions` global-by-design carve-out (CLAUDE.md).
 *
 * Absence of a row means "auto-detect". `isSolar = true` forces the node into
 * the report; `isSolar = false` keeps it out even when the detector matches.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  boolean as pgBoolean,
  bigint as pgBigint,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  boolean as myBoolean,
  bigint as myBigint,
} from 'drizzle-orm/mysql-core';

// SQLite
export const solarNodeOverridesSqlite = sqliteTable('solar_node_overrides', {
  nodeNum: integer('nodeNum').primaryKey(),
  isSolar: integer('isSolar', { mode: 'boolean' }).notNull(),
  updatedBy: text('updatedBy'),
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL — nodeNum is an unsigned 32-bit value, so BIGINT (signed INTEGER overflows).
export const solarNodeOverridesPostgres = pgTable('solar_node_overrides', {
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).primaryKey(),
  isSolar: pgBoolean('isSolar').notNull(),
  updatedBy: pgText('updatedBy'),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const solarNodeOverridesMysql = mysqlTable('solar_node_overrides', {
  nodeNum: myBigint('nodeNum', { mode: 'number' }).primaryKey(),
  isSolar: myBoolean('isSolar').notNull(),
  updatedBy: myVarchar('updatedBy', { length: 191 }),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export type SolarNodeOverrideSqlite = typeof solarNodeOverridesSqlite.$inferSelect;
export type SolarNodeOverridePostgres = typeof solarNodeOverridesPostgres.$inferSelect;
export type SolarNodeOverrideMysql = typeof solarNodeOverridesMysql.$inferSelect;
