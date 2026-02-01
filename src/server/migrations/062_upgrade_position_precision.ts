/**
 * Migration 062: Upgrade position columns from REAL to DOUBLE PRECISION
 *
 * PostgreSQL REAL (4-byte float) only has ~7 significant digits of precision,
 * which causes coordinates like -80.173874 to be rounded, resulting in
 * 1-10 meter position jumps. DOUBLE PRECISION (8-byte) has ~15 digits.
 *
 * This migration upgrades coordinate columns in both nodes and telemetry tables.
 * SQLite and MySQL are not affected (SQLite REAL is 8-byte, MySQL already uses DOUBLE).
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: No changes needed
 * SQLite REAL is already 8-byte IEEE floating point (same as DOUBLE)
 */
export const migration = {
  up: (_db: Database): void => {
    logger.debug('Migration 062: SQLite REAL is already 8-byte double precision, no changes needed');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 062 down: No changes needed for SQLite');
  }
};

/**
 * PostgreSQL migration: Upgrade REAL columns to DOUBLE PRECISION
 */
export async function runMigration062Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 062 (PostgreSQL): Upgrading position columns to DOUBLE PRECISION...');

  // Upgrade nodes table coordinate columns
  const nodesColumnsToUpgrade = [
    'latitude',
    'longitude',
    'altitude',
    'latitudeOverride',
    'longitudeOverride',
    'altitudeOverride',
  ];

  for (const column of nodesColumnsToUpgrade) {
    try {
      // Check if column exists first
      const result = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'nodes' AND column_name = $1
      `, [column]);

      if (result.rows.length > 0) {
        await client.query(`ALTER TABLE nodes ALTER COLUMN "${column}" TYPE DOUBLE PRECISION`);
        logger.debug(`✅ Upgraded nodes.${column} to DOUBLE PRECISION`);
      } else {
        logger.debug(`Column nodes.${column} does not exist, skipping`);
      }
    } catch (error: any) {
      logger.error(`Failed to upgrade nodes.${column}:`, error.message);
      throw error;
    }
  }

  // Upgrade telemetry table columns
  const telemetryColumnsToUpgrade = [
    'value',
    'gpsAccuracy',
  ];

  for (const column of telemetryColumnsToUpgrade) {
    try {
      const result = await client.query(`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'telemetry' AND column_name = $1
      `, [column]);

      if (result.rows.length > 0) {
        await client.query(`ALTER TABLE telemetry ALTER COLUMN "${column}" TYPE DOUBLE PRECISION`);
        logger.debug(`✅ Upgraded telemetry.${column} to DOUBLE PRECISION`);
      } else {
        logger.debug(`Column telemetry.${column} does not exist, skipping`);
      }
    } catch (error: any) {
      logger.error(`Failed to upgrade telemetry.${column}:`, error.message);
      throw error;
    }
  }

  logger.info('✅ Migration 062 complete (PostgreSQL): Position precision upgraded');
}

/**
 * MySQL migration: No changes needed
 * MySQL already uses DOUBLE for coordinate columns
 */
export async function runMigration062Mysql(_pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Migration 062 (MySQL): Already using DOUBLE, no changes needed');
}
