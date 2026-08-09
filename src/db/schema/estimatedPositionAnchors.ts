/**
 * Drizzle schema for the `estimated_position_anchors` table (issue #4609).
 *
 * WHY THIS TABLE EXISTS
 * ---------------------
 * `positionEstimationService` builds a per-node set of geometric observations
 * ("anchors") in memory, solves a weighted centroid, writes the solved point to
 * `estimated_positions`, and then throws the anchors away. That made it
 * impossible to answer the only question users actually ask about an estimated
 * pin — *why is it there?*
 *
 * The anchors cannot be reconstructed after the fact. The raw traceroute and
 * neighbor rows survive, but re-deriving observations would run the weight model
 * against a different `now`, producing different time-decay weights and possibly
 * a different anchor set than the one that produced the stored estimate. That
 * would be a plausible story, not the actual rationale. So the anchors that fed
 * each estimate are recorded at solve time.
 *
 * GLOBAL by design — there is intentionally NO `sourceId` column, matching the
 * parent `estimated_positions` table (issue #3271) and the CLAUDE.md
 * global-by-design carve-out. Observations are pooled from ALL Meshtastic
 * sources (incl. MQTT) into one estimate per physical `nodeNum`; the same
 * physical traceroute can be observed by several sources, so no single
 * `sourceId` would be correct for an anchor. Attaching one would re-fragment
 * exactly what #3271 unified. Estimation is Meshtastic-only (MeshCore excluded).
 *
 * VOLUME: rows are capped per node by the writer (see
 * MAX_STORED_ANCHORS_PER_NODE in positionEstimationService) — the top-weighted
 * anchors are kept, since those are the ones that actually moved the centroid.
 * The true total stays on `estimated_positions.observationCount`, so a consumer
 * can always say "showing N of M". Rows are replaced wholesale on each
 * estimator run and deleted alongside their parent estimate.
 */
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import {
  pgTable,
  text as pgText,
  doublePrecision as pgDoublePrecision,
  bigint as pgBigint,
  serial as pgSerial,
} from 'drizzle-orm/pg-core';
import {
  mysqlTable,
  varchar as myVarchar,
  double as myDouble,
  bigint as myBigint,
  int as myInt,
} from 'drizzle-orm/mysql-core';

// ============ SQLite Schema ============

export const estimatedPositionAnchorsSqlite = sqliteTable('estimated_position_anchors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  /** The node whose position was estimated from this anchor. */
  nodeNum: integer('nodeNum').notNull(),
  /** The positioned node that acted as the anchor. */
  anchorNodeNum: integer('anchorNodeNum').notNull(),
  anchorNodeId: text('anchorNodeId').notNull(),
  /** The anchor's position at solve time (it may move or vanish later). */
  anchorLat: real('anchorLat').notNull(),
  anchorLon: real('anchorLon').notNull(),
  /** 'traceroute' (hop segment) or 'neighbor' (NeighborInfo RF-range pair). */
  kind: text('kind').notNull(),
  /** Link SNR in dB, when the observation carried one. */
  snrDb: real('snrDb'),
  /** When the underlying observation was recorded (Unix ms). */
  observedAt: integer('observedAt').notNull(),
  /** Weight this anchor received in the solve (time-decay x SNR linear power). */
  weight: real('weight').notNull(),
  /** The estimator run's clock (Unix ms) — lets a consumer show estimate age. */
  createdAt: integer('createdAt').notNull(),
});

// ============ PostgreSQL Schema ============

export const estimatedPositionAnchorsPostgres = pgTable('estimated_position_anchors', {
  id: pgSerial('id').primaryKey(),
  nodeNum: pgBigint('nodeNum', { mode: 'number' }).notNull(),
  anchorNodeNum: pgBigint('anchorNodeNum', { mode: 'number' }).notNull(),
  anchorNodeId: pgText('anchorNodeId').notNull(),
  // doublePrecision, not REAL — REAL's ~7 significant digits round positions.
  anchorLat: pgDoublePrecision('anchorLat').notNull(),
  anchorLon: pgDoublePrecision('anchorLon').notNull(),
  kind: pgText('kind').notNull(),
  snrDb: pgDoublePrecision('snrDb'),
  observedAt: pgBigint('observedAt', { mode: 'number' }).notNull(),
  weight: pgDoublePrecision('weight').notNull(),
  createdAt: pgBigint('createdAt', { mode: 'number' }).notNull(),
});

// ============ MySQL Schema ============

export const estimatedPositionAnchorsMysql = mysqlTable('estimated_position_anchors', {
  id: myInt('id').autoincrement().primaryKey(),
  nodeNum: myBigint('nodeNum', { mode: 'number' }).notNull(),
  anchorNodeNum: myBigint('anchorNodeNum', { mode: 'number' }).notNull(),
  anchorNodeId: myVarchar('anchorNodeId', { length: 16 }).notNull(),
  anchorLat: myDouble('anchorLat').notNull(),
  anchorLon: myDouble('anchorLon').notNull(),
  kind: myVarchar('kind', { length: 16 }).notNull(),
  snrDb: myDouble('snrDb'),
  observedAt: myBigint('observedAt', { mode: 'number' }).notNull(),
  weight: myDouble('weight').notNull(),
  createdAt: myBigint('createdAt', { mode: 'number' }).notNull(),
});

// Type inference
export type EstimatedPositionAnchorSqlite = typeof estimatedPositionAnchorsSqlite.$inferSelect;
export type NewEstimatedPositionAnchorSqlite = typeof estimatedPositionAnchorsSqlite.$inferInsert;
export type EstimatedPositionAnchorPostgres = typeof estimatedPositionAnchorsPostgres.$inferSelect;
export type NewEstimatedPositionAnchorPostgres = typeof estimatedPositionAnchorsPostgres.$inferInsert;
export type EstimatedPositionAnchorMysql = typeof estimatedPositionAnchorsMysql.$inferSelect;
export type NewEstimatedPositionAnchorMysql = typeof estimatedPositionAnchorsMysql.$inferInsert;
