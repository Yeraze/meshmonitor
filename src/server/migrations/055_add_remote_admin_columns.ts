/**
 * Migration 055: Add remote admin discovery columns to nodes table
 *
 * Adds columns to track remote admin capability for each node:
 * - hasRemoteAdmin: boolean indicating if node has remote admin access
 * - lastRemoteAdminCheck: timestamp of last admin discovery check
 * - remoteAdminMetadata: JSON string of device metadata from admin response
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 055: Add remote admin discovery columns to nodes table');

    try {
      // Check which columns already exist
      const columns = db.pragma("table_info('nodes')") as Array<{ name: string }>;
      const columnNames = new Set(columns.map((col) => col.name));

      // Add hasRemoteAdmin column
      if (!columnNames.has('hasRemoteAdmin')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN hasRemoteAdmin INTEGER DEFAULT 0;
        `);
        logger.debug('Added hasRemoteAdmin column to nodes table');
      } else {
        logger.debug('hasRemoteAdmin column already exists, skipping');
      }

      // Add lastRemoteAdminCheck column
      if (!columnNames.has('lastRemoteAdminCheck')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN lastRemoteAdminCheck INTEGER;
        `);
        logger.debug('Added lastRemoteAdminCheck column to nodes table');
      } else {
        logger.debug('lastRemoteAdminCheck column already exists, skipping');
      }

      // Add remoteAdminMetadata column
      if (!columnNames.has('remoteAdminMetadata')) {
        db.exec(`
          ALTER TABLE nodes ADD COLUMN remoteAdminMetadata TEXT;
        `);
        logger.debug('Added remoteAdminMetadata column to nodes table');
      } else {
        logger.debug('remoteAdminMetadata column already exists, skipping');
      }

      // Create index for efficient filtering of nodes with remote admin
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_nodes_has_remote_admin ON nodes(hasRemoteAdmin);
      `);
      logger.debug('Created index on hasRemoteAdmin column');

      logger.debug('Migration 055 completed: remote admin discovery columns added to nodes table');
    } catch (error) {
      logger.error('Migration 055 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 055 down: Remove remote admin discovery columns from nodes table');

    try {
      // SQLite doesn't support DROP COLUMN directly until version 3.35.0
      // For older versions, we'd need to recreate the table without the columns
      // But for this case, we'll just note that the columns can remain
      logger.debug('Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('The remote admin discovery columns will remain but will not be used');

      logger.debug('Migration 055 rollback completed');
    } catch (error) {
      logger.error('Migration 055 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add remote admin discovery columns to nodes table
 */
export async function runMigration055Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 055 (PostgreSQL): Add remote admin discovery columns to nodes table');

  try {
    // Check if hasRemoteAdmin column exists
    const hasRemoteAdminExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'nodes'
          AND column_name = 'hasRemoteAdmin'
      )
    `);

    if (!hasRemoteAdminExists.rows[0].exists) {
      await client.query(`
        ALTER TABLE nodes ADD COLUMN "hasRemoteAdmin" BOOLEAN DEFAULT false
      `);
      logger.debug('Added hasRemoteAdmin column to nodes table');
    } else {
      logger.debug('hasRemoteAdmin column already exists, skipping');
    }

    // Check if lastRemoteAdminCheck column exists
    const lastRemoteAdminCheckExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'nodes'
          AND column_name = 'lastRemoteAdminCheck'
      )
    `);

    if (!lastRemoteAdminCheckExists.rows[0].exists) {
      await client.query(`
        ALTER TABLE nodes ADD COLUMN "lastRemoteAdminCheck" BIGINT
      `);
      logger.debug('Added lastRemoteAdminCheck column to nodes table');
    } else {
      logger.debug('lastRemoteAdminCheck column already exists, skipping');
    }

    // Check if remoteAdminMetadata column exists
    const remoteAdminMetadataExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'nodes'
          AND column_name = 'remoteAdminMetadata'
      )
    `);

    if (!remoteAdminMetadataExists.rows[0].exists) {
      await client.query(`
        ALTER TABLE nodes ADD COLUMN "remoteAdminMetadata" TEXT
      `);
      logger.debug('Added remoteAdminMetadata column to nodes table');
    } else {
      logger.debug('remoteAdminMetadata column already exists, skipping');
    }

    // Create index for efficient filtering
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_nodes_has_remote_admin ON nodes("hasRemoteAdmin")
    `);
    logger.debug('Created index on hasRemoteAdmin column');

    logger.debug('Migration 055 (PostgreSQL): remote admin discovery columns added');
  } catch (error) {
    logger.error('Migration 055 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add remote admin discovery columns to nodes table
 */
export async function runMigration055Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 055 (MySQL): Add remote admin discovery columns to nodes table');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if hasRemoteAdmin column exists
      const [hasRemoteAdminCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'nodes'
          AND COLUMN_NAME = 'hasRemoteAdmin'
      `);

      if ((hasRemoteAdminCols as any[]).length === 0) {
        await connection.query(`
          ALTER TABLE nodes ADD COLUMN hasRemoteAdmin TINYINT(1) DEFAULT 0
        `);
        logger.debug('Added hasRemoteAdmin column to nodes table');
      } else {
        logger.debug('hasRemoteAdmin column already exists, skipping');
      }

      // Check if lastRemoteAdminCheck column exists
      const [lastRemoteAdminCheckCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'nodes'
          AND COLUMN_NAME = 'lastRemoteAdminCheck'
      `);

      if ((lastRemoteAdminCheckCols as any[]).length === 0) {
        await connection.query(`
          ALTER TABLE nodes ADD COLUMN lastRemoteAdminCheck BIGINT
        `);
        logger.debug('Added lastRemoteAdminCheck column to nodes table');
      } else {
        logger.debug('lastRemoteAdminCheck column already exists, skipping');
      }

      // Check if remoteAdminMetadata column exists
      const [remoteAdminMetadataCols] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'nodes'
          AND COLUMN_NAME = 'remoteAdminMetadata'
      `);

      if ((remoteAdminMetadataCols as any[]).length === 0) {
        await connection.query(`
          ALTER TABLE nodes ADD COLUMN remoteAdminMetadata VARCHAR(4096)
        `);
        logger.debug('Added remoteAdminMetadata column to nodes table');
      } else {
        logger.debug('remoteAdminMetadata column already exists, skipping');
      }

      // Create index for efficient filtering (MySQL syntax)
      // Check if index exists first
      const [indexExists] = await connection.query(`
        SELECT INDEX_NAME FROM information_schema.statistics
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'nodes'
          AND INDEX_NAME = 'idx_nodes_has_remote_admin'
      `);

      if ((indexExists as any[]).length === 0) {
        await connection.query(`
          CREATE INDEX idx_nodes_has_remote_admin ON nodes(hasRemoteAdmin)
        `);
        logger.debug('Created index on hasRemoteAdmin column');
      }

      logger.debug('Migration 055 (MySQL): remote admin discovery columns added');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 055 (MySQL) failed:', error);
    throw error;
  }
}
