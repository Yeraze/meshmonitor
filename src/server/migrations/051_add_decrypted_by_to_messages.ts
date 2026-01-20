/**
 * Migration 051: Add decrypted_by column to messages table
 *
 * Adds tracking for how a message was decrypted:
 * - 'node': Decrypted by the connected Meshtastic device
 * - 'server': Decrypted server-side using Channel Database keys (read-only)
 * - null: Unknown/not tracked
 *
 * Messages with decrypted_by='server' cannot be replied to since the device
 * doesn't have the encryption key.
 */
import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 051: Add decrypted_by column to messages table');

    try {
      // Check if column already exists
      const tableInfo = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
      const columnNames = tableInfo.map((col) => col.name);

      if (!columnNames.includes('decrypted_by')) {
        db.exec(`ALTER TABLE messages ADD COLUMN decrypted_by TEXT`);
        logger.debug('✅ Added decrypted_by column to messages table');
      } else {
        logger.debug('ℹ️  decrypted_by column already exists in messages table');
      }

      logger.debug('✅ Migration 051 completed successfully');
    } catch (error: any) {
      logger.error('❌ Migration 051 failed:', error);
      throw error;
    }
  },

  down: (_db: Database.Database): void => {
    logger.debug('Reverting migration 051: Remove decrypted_by column from messages table');

    try {
      // Note: SQLite doesn't support DROP COLUMN easily in older versions
      // For safety, we leave the column in place on rollback
      // It won't affect functionality and can be cleaned up manually if needed
      logger.debug('ℹ️  Migration 051 rollback: decrypted_by column left in place (SQLite limitation)');
    } catch (error) {
      logger.error('❌ Migration 051 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add decrypted_by column to messages table
 */
export async function runMigration051Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 051 (PostgreSQL): Add decrypted_by column to messages table');

  try {
    // Check if column exists
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'messages'
        AND column_name = 'decrypted_by'
    `);

    if (result.rows.length === 0) {
      await client.query(`ALTER TABLE messages ADD COLUMN decrypted_by TEXT`);
      logger.debug('  Added decrypted_by column to messages table');
    } else {
      logger.debug('  decrypted_by column already exists in messages table');
    }

    logger.debug('Migration 051 (PostgreSQL) complete');
  } catch (error) {
    logger.error('Migration 051 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add decrypted_by column to messages table
 */
export async function runMigration051Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 051 (MySQL): Add decrypted_by column to messages table');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if column exists
      const [rows] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'messages'
        AND COLUMN_NAME = 'decrypted_by'
      `) as [any[], any];

      if (rows.length === 0) {
        await connection.query(`ALTER TABLE messages ADD COLUMN decrypted_by VARCHAR(16)`);
        logger.debug('  Added decrypted_by column to messages table');
      } else {
        logger.debug('  decrypted_by column already exists in messages table');
      }

      logger.debug('Migration 051 (MySQL) complete');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 051 (MySQL) failed:', error);
    throw error;
  }
}
