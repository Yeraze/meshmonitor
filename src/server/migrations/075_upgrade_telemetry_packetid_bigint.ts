/**
 * Migration 075: Upgrade telemetry packetId from INTEGER to BIGINT
 *
 * Meshtastic packet IDs are unsigned 32-bit values (up to ~4.3 billion),
 * but PostgreSQL/MySQL INTEGER is signed 32-bit (max 2,147,483,647).
 * This causes insert failures for packetId values above INT4 max.
 *
 * SQLite is unaffected because its INTEGER type is 64-bit.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: No changes needed
 * SQLite INTEGER is already 64-bit
 */
export const migration = {
  up: (_db: Database): void => {
    logger.debug('Migration 075: SQLite INTEGER is already 64-bit, no changes needed');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 075 down: No changes needed for SQLite');
  }
};

/**
 * PostgreSQL migration: Upgrade packetId from INTEGER to BIGINT
 */
export async function runMigration075Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 075 (PostgreSQL): Upgrading telemetry.packetId to BIGINT...');

  try {
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'telemetry' AND column_name = 'packetId'
    `);

    if (result.rows.length > 0) {
      await client.query(`ALTER TABLE telemetry ALTER COLUMN "packetId" TYPE BIGINT`);
      logger.debug('Upgraded telemetry.packetId to BIGINT');
    } else {
      logger.debug('Column telemetry.packetId does not exist, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to upgrade telemetry.packetId:', error.message);
    throw error;
  }

  logger.info('Migration 075 complete (PostgreSQL): telemetry.packetId upgraded to BIGINT');
}

/**
 * MySQL migration: Upgrade packetId from INT to BIGINT
 */
export async function runMigration075Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 075 (MySQL): Upgrading telemetry.packetId to BIGINT...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_NAME = 'telemetry' AND COLUMN_NAME = 'packetId'
    `);

    if (Array.isArray(rows) && rows.length > 0) {
      await pool.query(`ALTER TABLE telemetry MODIFY COLUMN packetId BIGINT`);
      logger.debug('Upgraded telemetry.packetId to BIGINT');
    } else {
      logger.debug('Column telemetry.packetId does not exist, skipping');
    }
  } catch (error: any) {
    logger.error('Failed to upgrade telemetry.packetId:', error.message);
    throw error;
  }

  logger.info('Migration 075 complete (MySQL): telemetry.packetId upgraded to BIGINT');
}
