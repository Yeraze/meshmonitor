/**
 * Migration 134: Delete "Null Island" (0,0) rows from `estimated_positions`.
 *
 * Follow-up to #4432. Migration 107 cleared bogus (0,0) coordinates from `nodes`,
 * `meshcore_nodes`, and `telemetry` — but not from the global `estimated_positions`
 * table, which did not yet exist in that sweep's scope. That left a gap:
 *
 *   1. A node reported a bogus (0,0) fix, so it became a (0,0) *anchor*.
 *   2. The estimator averaged it into a neighbouring node's solve, storing an
 *      estimate at (0,0) with a confident-looking sub-kilometre radius.
 *   3. Migration 107 nulled the original (0,0) fix in `nodes`, so those nodes
 *      then fell through to the estimate — re-substituting the exact coordinates
 *      107 had just removed, now indistinguishable from a real position.
 *
 * The runtime hole is closed separately in positionEstimationService: bogus
 * anchors are dropped before they can constrain anything, and a solve that lands
 * on Null Island returns null instead of being stored. This migration removes the
 * rows already written by the old behaviour.
 *
 * Deleting (rather than nulling) is correct here: unlike `nodes`, a row in
 * `estimated_positions` has no meaning without coordinates — the table is one
 * derived estimate per node, and the scheduled recompute re-creates any row that
 * still has a legitimate solve.
 *
 * Naturally idempotent: once the rows are gone they no longer match, so re-running
 * is a no-op. The radius (NULL_ISLAND_EPSILON) is shared with the runtime filter
 * so the two never drift.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { NULL_ISLAND_EPSILON as EPS } from '../../utils/nullIsland.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 134 (SQLite): Deleting Null Island estimated positions...');
    try {
      db.exec(
        `DELETE FROM estimated_positions ` +
          `WHERE latitude IS NOT NULL AND longitude IS NOT NULL ` +
          `AND ABS(latitude) < ${EPS} AND ABS(longitude) < ${EPS}`,
      );
      logger.debug('Deleted Null Island rows from estimated_positions');
    } catch (e) {
      logger.warn('Could not delete Null Island estimated positions:', e instanceof Error ? e.message : String(e));
    }
    logger.info('Migration 134 complete (SQLite): Null Island estimates cleared');
  },
};

// ============ PostgreSQL ============

export async function runMigration134Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 134 (PostgreSQL): Deleting Null Island estimated positions...');
  try {
    await client.query(
      `DELETE FROM estimated_positions ` +
        `WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL ` +
        `AND ABS("latitude") < $1 AND ABS("longitude") < $1`,
      [EPS],
    );
    logger.debug('Deleted Null Island rows from estimated_positions');
  } catch (e) {
    logger.warn('Could not delete Null Island estimated positions:', e instanceof Error ? e.message : String(e));
  }
  logger.info('Migration 134 complete (PostgreSQL): Null Island estimates cleared');
}

// ============ MySQL ============

export async function runMigration134Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 134 (MySQL): Deleting Null Island estimated positions...');
  try {
    await pool.query(
      `DELETE FROM estimated_positions ` +
        `WHERE latitude IS NOT NULL AND longitude IS NOT NULL ` +
        `AND ABS(latitude) < ? AND ABS(longitude) < ?`,
      [EPS, EPS],
    );
    logger.debug('Deleted Null Island rows from estimated_positions');
  } catch (e) {
    logger.warn('Could not delete Null Island estimated positions:', e instanceof Error ? e.message : String(e));
  }
  logger.info('Migration 134 complete (MySQL): Null Island estimates cleared');
}
