/**
 * Migration 087: Fix relayNode and ackFromNode to BIGINT
 *
 * These columns hold nodeNum values (unsigned 32-bit, max 4,294,967,295)
 * which exceeds signed 32-bit INTEGER max of 2,147,483,647.
 * SQLite INTEGER is already 64-bit, so no change needed there.
 *
 * Reference: Same pattern as migrations 075 and 077.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: No changes needed
 * SQLite INTEGER is already 64-bit
 */
export const migration = {
  up: (_db: Database): void => {
    logger.debug('Migration 087: SQLite INTEGER is already 64-bit, no changes needed');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 087 down: No changes needed for SQLite');
  }
};

/**
 * PostgreSQL migration: Upgrade messages.relayNode and messages.ackFromNode from INTEGER to BIGINT
 */
export async function runMigration087Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 087 (PostgreSQL): Upgrading messages relayNode/ackFromNode to BIGINT...');

  try {
    // Upgrade relayNode
    const relayCheck = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'relayNode'
    `);

    if (relayCheck.rows.length === 0) {
      logger.debug('Table messages or column relayNode does not exist, skipping');
    } else if (relayCheck.rows[0].data_type === 'bigint') {
      logger.debug('messages.relayNode is already BIGINT, skipping');
    } else {
      await client.query('ALTER TABLE messages ALTER COLUMN "relayNode" TYPE BIGINT');
      logger.debug('Upgraded messages.relayNode to BIGINT');
    }

    // Upgrade ackFromNode
    const ackCheck = await client.query(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'messages' AND column_name = 'ackFromNode'
    `);

    if (ackCheck.rows.length === 0) {
      logger.debug('Table messages or column ackFromNode does not exist, skipping');
    } else if (ackCheck.rows[0].data_type === 'bigint') {
      logger.debug('messages.ackFromNode is already BIGINT, skipping');
    } else {
      await client.query('ALTER TABLE messages ALTER COLUMN "ackFromNode" TYPE BIGINT');
      logger.debug('Upgraded messages.ackFromNode to BIGINT');
    }
  } catch (error: any) {
    logger.error('Failed to upgrade messages relayNode/ackFromNode:', error.message);
    throw error;
  }

  logger.info('Migration 087 complete (PostgreSQL): messages relayNode/ackFromNode upgraded to BIGINT');
}

/**
 * MySQL migration: Upgrade messages.relayNode and messages.ackFromNode from INT to BIGINT
 */
export async function runMigration087Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 087 (MySQL): Upgrading messages relayNode/ackFromNode to BIGINT...');

  try {
    // Upgrade relayNode
    const [relayRows] = await pool.query(`
      SELECT DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'relayNode'
    `);

    if (!Array.isArray(relayRows) || relayRows.length === 0) {
      logger.debug('Table messages or column relayNode does not exist, skipping');
    } else if ((relayRows[0] as any).DATA_TYPE === 'bigint') {
      logger.debug('messages.relayNode is already BIGINT, skipping');
    } else {
      await pool.query('ALTER TABLE messages MODIFY COLUMN relayNode BIGINT');
      logger.debug('Upgraded messages.relayNode to BIGINT');
    }

    // Upgrade ackFromNode
    const [ackRows] = await pool.query(`
      SELECT DATA_TYPE FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages' AND COLUMN_NAME = 'ackFromNode'
    `);

    if (!Array.isArray(ackRows) || ackRows.length === 0) {
      logger.debug('Table messages or column ackFromNode does not exist, skipping');
    } else if ((ackRows[0] as any).DATA_TYPE === 'bigint') {
      logger.debug('messages.ackFromNode is already BIGINT, skipping');
    } else {
      await pool.query('ALTER TABLE messages MODIFY COLUMN ackFromNode BIGINT');
      logger.debug('Upgraded messages.ackFromNode to BIGINT');
    }
  } catch (error: any) {
    logger.error('Failed to upgrade messages relayNode/ackFromNode:', error.message);
    throw error;
  }

  logger.info('Migration 087 complete (MySQL): messages relayNode/ackFromNode upgraded to BIGINT');
}
