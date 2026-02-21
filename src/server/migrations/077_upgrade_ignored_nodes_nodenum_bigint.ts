/**
 * Migration 077: Upgrade ignored_nodes.nodeNum from INTEGER to BIGINT
 *
 * Meshtastic node numbers are unsigned 32-bit values (up to ~4.3 billion),
 * but PostgreSQL/MySQL INTEGER is signed 32-bit (max 2,147,483,647).
 * This causes query failures for nodeNum values above INT4 max.
 *
 * SQLite is unaffected because its INTEGER type is 64-bit.
 *
 * Fixes: https://github.com/Yeraze/meshmonitor/issues/1973
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: No changes needed
 * SQLite INTEGER is already 64-bit
 */
export const migration = {
  up: (_db: Database): void => {
    logger.debug('Migration 077: SQLite INTEGER is already 64-bit, no changes needed');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 077 down: No changes needed for SQLite');
  }
};

/**
 * PostgreSQL migration: Upgrade ignored_nodes.nodeNum from INTEGER to BIGINT
 */
export async function runMigration077Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 077 (PostgreSQL): Upgrading ignored_nodes.nodeNum to BIGINT...');

  try {
    const result = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_name = 'ignored_nodes' AND column_name = 'nodeNum'
    `);

    if (result.rows.length === 0) {
      logger.debug('Table ignored_nodes or column nodeNum does not exist, skipping');
      return;
    }

    if (result.rows[0].data_type === 'bigint') {
      logger.debug('ignored_nodes.nodeNum is already BIGINT, skipping');
      return;
    }

    await client.query(`ALTER TABLE ignored_nodes ALTER COLUMN "nodeNum" TYPE BIGINT`);
    logger.debug('Upgraded ignored_nodes.nodeNum to BIGINT');
  } catch (error: any) {
    logger.error('Failed to upgrade ignored_nodes.nodeNum:', error.message);
    throw error;
  }

  logger.info('Migration 077 complete (PostgreSQL): ignored_nodes.nodeNum upgraded to BIGINT');
}

/**
 * MySQL migration: Upgrade ignored_nodes.nodeNum from INT to BIGINT
 */
export async function runMigration077Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 077 (MySQL): Upgrading ignored_nodes.nodeNum to BIGINT...');

  try {
    const [rows] = await pool.query(`
      SELECT DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'ignored_nodes' AND COLUMN_NAME = 'nodeNum'
    `);

    if (!Array.isArray(rows) || rows.length === 0) {
      logger.debug('Table ignored_nodes or column nodeNum does not exist, skipping');
      return;
    }

    if ((rows[0] as any).DATA_TYPE === 'bigint') {
      logger.debug('ignored_nodes.nodeNum is already BIGINT, skipping');
      return;
    }

    await pool.query(`ALTER TABLE ignored_nodes MODIFY COLUMN nodeNum BIGINT PRIMARY KEY`);
    logger.debug('Upgraded ignored_nodes.nodeNum to BIGINT');
  } catch (error: any) {
    logger.error('Failed to upgrade ignored_nodes.nodeNum:', error.message);
    throw error;
  }

  logger.info('Migration 077 complete (MySQL): ignored_nodes.nodeNum upgraded to BIGINT');
}
