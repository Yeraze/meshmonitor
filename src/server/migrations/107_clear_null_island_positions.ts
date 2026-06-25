/**
 * Migration 107: Clear "Null Island" (0,0) node positions (#3763).
 *
 * GPS modules emit (0,0) before acquiring a fix, and a stale (0,0) fix can be
 * transmitted and stored. As of #3763 new positions at or near (0,0) are
 * filtered at ingestion, but rows captured before that fix still carry a bogus
 * (0,0) and would render a marker in the South Atlantic. This one-shot data
 * migration nulls the latitude/longitude of any such row in both the Meshtastic
 * `nodes` table and the MeshCore `meshcore_nodes` table.
 *
 * Only the GPS-reported `latitude`/`longitude` columns are touched — a manual
 * `latitudeOverride`/`longitudeOverride` is intentionally left alone.
 *
 * Naturally idempotent: once a row is nulled it no longer matches the WHERE
 * clause, so re-running is a no-op. The radius (NULL_ISLAND_EPSILON) is shared
 * with the runtime filter so the two never drift.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { NULL_ISLAND_EPSILON as EPS } from '../../utils/nullIsland.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 107 (SQLite): Clearing Null Island (0,0) node positions...');
    for (const table of ['nodes', 'meshcore_nodes']) {
      try {
        db.exec(
          `UPDATE ${table} SET latitude = NULL, longitude = NULL ` +
            `WHERE latitude IS NOT NULL AND longitude IS NOT NULL ` +
            `AND ABS(latitude) < ${EPS} AND ABS(longitude) < ${EPS}`,
        );
        logger.debug(`Cleared Null Island positions in ${table}`);
      } catch (e: any) {
        logger.warn(`Could not clear Null Island positions in ${table}:`, e.message);
      }
    }
    logger.info('Migration 107 complete (SQLite): Null Island positions cleared');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 107 down: Not implemented (cleared positions are not recoverable)');
  },
};

// ============ PostgreSQL ============

export async function runMigration107Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 107 (PostgreSQL): Clearing Null Island (0,0) node positions...');
  try {
    for (const table of ['nodes', 'meshcore_nodes']) {
      await client.query(
        `UPDATE ${table} SET "latitude" = NULL, "longitude" = NULL ` +
          `WHERE "latitude" IS NOT NULL AND "longitude" IS NOT NULL ` +
          `AND ABS("latitude") < ${EPS} AND ABS("longitude") < ${EPS}`,
      );
      logger.debug(`Cleared Null Island positions in ${table}`);
    }
  } catch (error: any) {
    logger.error('Migration 107 (PostgreSQL) failed:', error.message);
    throw error;
  }
  logger.info('Migration 107 complete (PostgreSQL): Null Island positions cleared');
}

// ============ MySQL ============

export async function runMigration107Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 107 (MySQL): Clearing Null Island (0,0) node positions...');
  try {
    for (const table of ['nodes', 'meshcore_nodes']) {
      await pool.query(
        `UPDATE ${table} SET latitude = NULL, longitude = NULL ` +
          `WHERE latitude IS NOT NULL AND longitude IS NOT NULL ` +
          `AND ABS(latitude) < ${EPS} AND ABS(longitude) < ${EPS}`,
      );
      logger.debug(`Cleared Null Island positions in ${table}`);
    }
  } catch (error: any) {
    logger.error('Migration 107 (MySQL) failed:', error.message);
    throw error;
  }
  logger.info('Migration 107 complete (MySQL): Null Island positions cleared');
}
