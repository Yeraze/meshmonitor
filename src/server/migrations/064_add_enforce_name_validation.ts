/**
 * Migration 064: Add enforce_name_validation column to channel_database
 *
 * Adds a boolean column to control whether channel name hash validation is enforced
 * during decryption. When enabled, the server only attempts decryption if the
 * packet's channel hash matches the expected hash (computed from stored name + PSK).
 * This allows multiple virtual channels with the same key but different names to
 * sort messages correctly.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 064: Add enforce_name_validation to channel_database');

    try {
      // Check if column already exists
      const tableInfo = db.pragma('table_info(channel_database)') as { name: string }[];
      const columnExists = tableInfo.some(col => col.name === 'enforce_name_validation');

      if (columnExists) {
        logger.debug('enforce_name_validation column already exists, skipping migration');
        return;
      }

      // Add the column with default value of false (0)
      db.exec(`
        ALTER TABLE channel_database ADD COLUMN enforce_name_validation INTEGER NOT NULL DEFAULT 0
      `);

      logger.debug('Migration 064 completed: enforce_name_validation column added to channel_database');
    } catch (error) {
      logger.error('Migration 064 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 064 down: Remove enforce_name_validation column');

    try {
      // SQLite doesn't support DROP COLUMN directly, need to recreate table
      db.exec(`
        CREATE TABLE channel_database_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          psk TEXT NOT NULL,
          psk_length INTEGER NOT NULL,
          description TEXT,
          is_enabled INTEGER NOT NULL DEFAULT 1,
          decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
          last_decrypted_at INTEGER,
          created_by INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        )
      `);

      db.exec(`
        INSERT INTO channel_database_new (id, name, psk, psk_length, description, is_enabled, decrypted_packet_count, last_decrypted_at, created_by, created_at, updated_at)
        SELECT id, name, psk, psk_length, description, is_enabled, decrypted_packet_count, last_decrypted_at, created_by, created_at, updated_at
        FROM channel_database
      `);

      db.exec(`DROP TABLE channel_database`);
      db.exec(`ALTER TABLE channel_database_new RENAME TO channel_database`);

      logger.debug('Migration 064 rollback completed');
    } catch (error) {
      logger.error('Migration 064 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add enforceNameValidation column to channel_database
 */
export async function runMigration064Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 064 (PostgreSQL): Add enforceNameValidation column to channel_database');

  try {
    // Check if column already exists
    const columnExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'channel_database'
          AND column_name = 'enforceNameValidation'
      )
    `);

    if (columnExists.rows[0].exists) {
      logger.debug('enforceNameValidation column already exists, skipping migration');
      return;
    }

    // Add the column
    await client.query(`
      ALTER TABLE channel_database ADD COLUMN "enforceNameValidation" BOOLEAN NOT NULL DEFAULT false
    `);

    logger.debug('Migration 064 (PostgreSQL): enforceNameValidation column added to channel_database');
  } catch (error) {
    logger.error('Migration 064 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add enforceNameValidation column to channel_database
 */
export async function runMigration064Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 064 (MySQL): Add enforceNameValidation column to channel_database');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if column already exists
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'channel_database'
          AND COLUMN_NAME = 'enforceNameValidation'
      `);

      if ((columns as any[]).length > 0) {
        logger.debug('enforceNameValidation column already exists, skipping migration');
        return;
      }

      // Add the column
      await connection.query(`
        ALTER TABLE channel_database ADD COLUMN enforceNameValidation BOOLEAN NOT NULL DEFAULT false
      `);

      logger.debug('Migration 064 (MySQL): enforceNameValidation column added to channel_database');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 064 (MySQL) failed:', error);
    throw error;
  }
}
