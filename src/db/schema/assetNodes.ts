/**
 * Drizzle schema for the `asset_nodes` table (issue #5354, Asset Tracking).
 *
 * An operator marks a node as a tracked **asset** (for example a GPS node on a
 * vehicle). For an asset, MeshMonitor keeps all of its telemetry for
 * `retentionDays` instead of the regular 7-day window, always draws its trail,
 * and automated cleanups skip it.
 *
 * GLOBAL by design — there is intentionally NO `sourceId` column. The flag
 * belongs to the physical node (nodeNum), and the retention it grants applies to
 * that node's rows on every source that heard it. Mirrors the
 * `solar_node_overrides` carve-out (#3195). Visibility still follows each
 * viewer's source permissions: routes only surface rows for nodes present on a
 * permitted source.
 *
 * Absence of a row means "not an asset".
 */
import { sqliteTable, integer } from 'drizzle-orm/sqlite-core';
import { pgTable, integer as pgInteger, bigint as pgBigint } from 'drizzle-orm/pg-core';
import { mysqlTable, int as myInt, bigint as myBigint } from 'drizzle-orm/mysql-core';

// SQLite
export const assetNodesSqlite = sqliteTable('asset_nodes', {
  nodeNum: integer('nodeNum').primaryKey(),
  retentionDays: integer('retentionDays').notNull(),
  /** users.id of the last editor; null when unknown. */
  updatedBy: integer('updatedBy'),
  /** Epoch ms. */
  updatedAt: integer('updatedAt').notNull(),
});

// PostgreSQL — nodeNum is an unsigned 32-bit value, so BIGINT (signed INTEGER overflows).
export const assetNodesPostgres = pgTable('asset_nodes', {
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).primaryKey(),
  retentionDays: pgInteger('retentionDays').notNull(),
  updatedBy: pgInteger('updatedBy'),
  updatedAt: pgBigint('updatedAt', { mode: 'number' }).notNull(),
});

// MySQL
export const assetNodesMysql = mysqlTable('asset_nodes', {
  nodeNum: myBigint('nodeNum', { mode: 'number' }).primaryKey(),
  retentionDays: myInt('retentionDays').notNull(),
  updatedBy: myInt('updatedBy'),
  updatedAt: myBigint('updatedAt', { mode: 'number' }).notNull(),
});

export type AssetNodeSqlite = typeof assetNodesSqlite.$inferSelect;
export type AssetNodePostgres = typeof assetNodesPostgres.$inferSelect;
export type AssetNodeMysql = typeof assetNodesMysql.$inferSelect;
