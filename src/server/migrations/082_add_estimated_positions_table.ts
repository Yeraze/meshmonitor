/**
 * Migration 082: Add the global estimated_positions table.
 *
 * Position estimation moves from per-source telemetry rows to a single GLOBAL
 * table (one row per physical nodeNum), pooled across all Meshtastic sources by
 * the scheduled positionEstimationService. See schema/estimatedPositions.ts and
 * the CLAUDE.md global-by-design note.
 *
 * This migration:
 *   1. Creates the estimated_positions table (idempotent).
 *   2. Purges the now-obsolete per-source estimate telemetry rows
 *      ('estimated_latitude' / 'estimated_longitude'). The scheduler rebuilds
 *      global estimates from stored traceroutes + neighbor_info on first run.
 *
 * Implements: https://github.com/Yeraze/meshmonitor/issues/3271
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 082 (SQLite): Adding estimated_positions table...');

    db.exec(`
      CREATE TABLE IF NOT EXISTS estimated_positions (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        uncertaintyKm REAL,
        observationCount INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL
      )
    `);

    try {
      const result = db.prepare(
        `DELETE FROM telemetry WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')`
      ).run();
      if (result.changes > 0) {
        logger.info(`Migration 082 (SQLite): purged ${result.changes} obsolete estimate telemetry rows`);
      }
    } catch (e: any) {
      logger.warn('Migration 082 (SQLite): could not purge estimate telemetry rows:', e.message);
    }

    logger.info('Migration 082 complete (SQLite): estimated_positions ready');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 082 down: Not implemented (destructive)');
  }
};

// ============ PostgreSQL ============

export async function runMigration082EstimatedPositionsPostgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 082 (PostgreSQL): Adding estimated_positions table...');

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS estimated_positions (
        "nodeNum" BIGINT PRIMARY KEY,
        "nodeId" TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        "uncertaintyKm" REAL,
        "observationCount" BIGINT NOT NULL DEFAULT 0,
        "updatedAt" BIGINT NOT NULL
      )
    `);

    const result = await client.query(
      `DELETE FROM telemetry WHERE "telemetryType" IN ('estimated_latitude', 'estimated_longitude')`
    );
    if (result.rowCount && result.rowCount > 0) {
      logger.info(`Migration 082 (PostgreSQL): purged ${result.rowCount} obsolete estimate telemetry rows`);
    }
  } catch (error: any) {
    logger.error('Migration 082 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 082 complete (PostgreSQL): estimated_positions ready');
}

// ============ MySQL ============

export async function runMigration082EstimatedPositionsMysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 082 (MySQL): Adding estimated_positions table...');

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS estimated_positions (
        nodeNum BIGINT PRIMARY KEY,
        nodeId VARCHAR(16) NOT NULL,
        latitude DOUBLE NOT NULL,
        longitude DOUBLE NOT NULL,
        uncertaintyKm DOUBLE,
        observationCount INT NOT NULL DEFAULT 0,
        updatedAt BIGINT NOT NULL
      )
    `);

    const [result] = await pool.query(
      `DELETE FROM telemetry WHERE telemetryType IN ('estimated_latitude', 'estimated_longitude')`
    );
    const affected = (result as any)?.affectedRows ?? 0;
    if (affected > 0) {
      logger.info(`Migration 082 (MySQL): purged ${affected} obsolete estimate telemetry rows`);
    }
  } catch (error: any) {
    logger.error('Migration 082 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 082 complete (MySQL): estimated_positions ready');
}
