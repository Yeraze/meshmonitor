/**
 * Migration 065: Add sort_order column to channel_database
 *
 * Adds a sortOrder column to control the order in which channels are tried
 * during decryption. Lower values are tried first. This allows users to
 * prioritize which channels should be attempted first when multiple channels
 * could potentially decrypt a packet.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 065: Add sort_order to channel_database');

    try {
      // Check if column already exists
      const tableInfo = db.pragma('table_info(channel_database)') as { name: string }[];
      const columnExists = tableInfo.some(col => col.name === 'sort_order');

      if (columnExists) {
        logger.debug('sort_order column already exists, skipping migration');
        return;
      }

      // Add the column with default value of 0
      db.exec(`
        ALTER TABLE channel_database ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0
      `);

      // Initialize existing rows with sortOrder = id to preserve creation order
      db.exec(`
        UPDATE channel_database SET sort_order = id
      `);

      logger.debug('Migration 065 completed: sort_order column added to channel_database');
    } catch (error) {
      logger.error('Migration 065 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 065 down: Remove sort_order column');

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
          enforce_name_validation INTEGER NOT NULL DEFAULT 0,
          decrypted_packet_count INTEGER NOT NULL DEFAULT 0,
          last_decrypted_at INTEGER,
          created_by INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
        )
      `);

      db.exec(`
        INSERT INTO channel_database_new (id, name, psk, psk_length, description, is_enabled, enforce_name_validation, decrypted_packet_count, last_decrypted_at, created_by, created_at, updated_at)
        SELECT id, name, psk, psk_length, description, is_enabled, enforce_name_validation, decrypted_packet_count, last_decrypted_at, created_by, created_at, updated_at
        FROM channel_database
      `);

      db.exec(`DROP TABLE channel_database`);
      db.exec(`ALTER TABLE channel_database_new RENAME TO channel_database`);

      logger.debug('Migration 065 rollback completed');
    } catch (error) {
      logger.error('Migration 065 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add sortOrder column to channel_database
 */
export async function runMigration065Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 065 (PostgreSQL): Add sortOrder column to channel_database');

  try {
    // Check if column already exists
    const columnExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'channel_database'
          AND column_name = 'sortOrder'
      )
    `);

    if (columnExists.rows[0].exists) {
      logger.debug('sortOrder column already exists, skipping migration');
      return;
    }

    // Add the column
    await client.query(`
      ALTER TABLE channel_database ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0
    `);

    // Initialize existing rows with sortOrder = id to preserve creation order
    await client.query(`
      UPDATE channel_database SET "sortOrder" = id
    `);

    logger.debug('Migration 065 (PostgreSQL): sortOrder column added to channel_database');
  } catch (error) {
    logger.error('Migration 065 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add sortOrder column to channel_database
 */
export async function runMigration065Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 065 (MySQL): Add sortOrder column to channel_database');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if column already exists
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'channel_database'
          AND COLUMN_NAME = 'sortOrder'
      `);

      if ((columns as any[]).length > 0) {
        logger.debug('sortOrder column already exists, skipping migration');
        return;
      }

      // Add the column
      await connection.query(`
        ALTER TABLE channel_database ADD COLUMN sortOrder INT NOT NULL DEFAULT 0
      `);

      // Initialize existing rows with sortOrder = id to preserve creation order
      await connection.query(`
        UPDATE channel_database SET sortOrder = id
      `);

      logger.debug('Migration 065 (MySQL): sortOrder column added to channel_database');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 065 (MySQL) failed:', error);
    throw error;
  }
}
