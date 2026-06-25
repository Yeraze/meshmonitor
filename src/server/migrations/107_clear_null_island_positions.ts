/**
 * Migration 107: Clear "Null Island" (0,0) node positions (#3763).
 *
 * GPS modules emit (0,0) before acquiring a fix, and a stale (0,0) fix can be
 * transmitted and stored. As of #3763 new positions at or near (0,0) are
 * filtered at ingestion, but rows captured before that fix still carry a bogus
 * (0,0) and would render in the South Atlantic. This one-shot data migration:
 *
 *   1. Nulls the latitude/longitude of any such row in the Meshtastic `nodes`
 *      table and the MeshCore `meshcore_nodes` table (node markers).
 *   2. Deletes the paired (0,0) latitude/longitude rows from the Meshtastic
 *      `telemetry` table (position trails + coverage heatmap), keyed on
 *      (nodeNum, timestamp) so a row is removed only when BOTH the latitude and
 *      longitude of the same fix are near zero. Altitude/speed rows of the fix
 *      are left as harmless orphans (the render layer needs lat AND lon to plot).
 *
 * Only the GPS-reported `latitude`/`longitude` columns are touched — a manual
 * `latitudeOverride`/`longitudeOverride` is intentionally left alone.
 *
 * Naturally idempotent: once a node row is nulled (or a telemetry pair deleted)
 * it no longer matches, so re-running is a no-op. The radius
 * (NULL_ISLAND_EPSILON) is shared with the runtime filter so the two never drift.
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
    // Delete paired (0,0) lat/lon position-history rows from telemetry.
    try {
      db.exec(
        `DELETE FROM telemetry ` +
          `WHERE telemetryType IN ('latitude','longitude') AND ABS(value) < ${EPS} ` +
          `AND (nodeNum, timestamp) IN (` +
          `SELECT lat.nodeNum, lat.timestamp FROM telemetry lat ` +
          `JOIN telemetry lon ON lon.nodeNum = lat.nodeNum AND lon.timestamp = lat.timestamp ` +
          `WHERE lat.telemetryType = 'latitude' AND ABS(lat.value) < ${EPS} ` +
          `AND lon.telemetryType = 'longitude' AND ABS(lon.value) < ${EPS})`,
      );
      logger.debug('Deleted Null Island position rows from telemetry');
    } catch (e: any) {
      logger.warn('Could not delete Null Island telemetry rows:', e.message);
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
    // Delete paired (0,0) lat/lon position-history rows from telemetry.
    await client.query(
      `DELETE FROM telemetry ` +
        `WHERE "telemetryType" IN ('latitude','longitude') AND ABS("value") < ${EPS} ` +
        `AND ("nodeNum", "timestamp") IN (` +
        `SELECT lat."nodeNum", lat."timestamp" FROM telemetry lat ` +
        `JOIN telemetry lon ON lon."nodeNum" = lat."nodeNum" AND lon."timestamp" = lat."timestamp" ` +
        `WHERE lat."telemetryType" = 'latitude' AND ABS(lat."value") < ${EPS} ` +
        `AND lon."telemetryType" = 'longitude' AND ABS(lon."value") < ${EPS})`,
    );
    logger.debug('Deleted Null Island position rows from telemetry');
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
    // Delete paired (0,0) lat/lon position-history rows from telemetry. MySQL
    // forbids a DELETE whose subquery targets the same table (error 1093), so
    // use a multi-table self-join delete that removes both rows of the pair.
    await pool.query(
      `DELETE lat, lon FROM telemetry lat ` +
        `JOIN telemetry lon ON lon.nodeNum = lat.nodeNum AND lon.timestamp = lat.timestamp ` +
        `WHERE lat.telemetryType = 'latitude' AND ABS(lat.value) < ${EPS} ` +
        `AND lon.telemetryType = 'longitude' AND ABS(lon.value) < ${EPS}`,
    );
    logger.debug('Deleted Null Island position rows from telemetry');
  } catch (error: any) {
    logger.error('Migration 107 (MySQL) failed:', error.message);
    throw error;
  }
  logger.info('Migration 107 complete (MySQL): Null Island positions cleared');
}
