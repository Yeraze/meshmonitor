/**
 * Migration 072: Add composite index for DM unread count batch queries
 *
 * Creates an index on messages(toNodeId, channel, portnum, fromNodeId) to optimize
 * the batch DM unread counts query that groups by fromNodeId.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 072: Add messages DM unread index');
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_dm_unread
        ON messages(toNodeId, channel, portnum, fromNodeId)
      `);
      logger.debug('Migration 072 completed: DM unread index added');
    } catch (error) {
      logger.error('Migration 072 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 072 down: Remove messages DM unread index');
    try {
      db.exec('DROP INDEX IF EXISTS idx_messages_dm_unread');
      logger.debug('Migration 072 rollback completed');
    } catch (error) {
      logger.error('Migration 072 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add composite index for DM unread count batch queries
 */
export async function runMigration072Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 072 (PostgreSQL): Add messages DM unread index');
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_messages_dm_unread
    ON messages("toNodeId", channel, portnum, "fromNodeId")
  `);
}

/**
 * MySQL migration: Add composite index for DM unread count batch queries
 */
export async function runMigration072Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 072 (MySQL): Add messages DM unread index');
  // MySQL doesn't support IF NOT EXISTS for indexes, use a try-catch
  try {
    await pool.query(`
      CREATE INDEX idx_messages_dm_unread
      ON messages(toNodeId, channel, portnum, fromNodeId)
    `);
  } catch (error: any) {
    // Ignore "Duplicate key name" error (index already exists)
    if (error.code !== 'ER_DUP_KEYNAME') {
      throw error;
    }
  }
}
