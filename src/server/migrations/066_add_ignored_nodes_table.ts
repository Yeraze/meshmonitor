/**
 * Migration 066: Add ignored_nodes table
 *
 * Creates a persistent ignored_nodes table that survives node deletion.
 * When cleanupInactiveNodes() prunes a node, its ignored status is preserved
 * in this table. When the node reappears, the ignored status is restored.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 066: Add ignored_nodes table');

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS ignored_nodes (
          nodeNum INTEGER PRIMARY KEY,
          nodeId TEXT NOT NULL,
          longName TEXT,
          shortName TEXT,
          ignoredAt INTEGER NOT NULL,
          ignoredBy TEXT
        )
      `);

      logger.debug('Migration 066 completed: ignored_nodes table created');
    } catch (error) {
      logger.error('Migration 066 failed:', error);
      throw error;
    }
  },

  down: (db: Database): void => {
    logger.debug('Running migration 066 down: Remove ignored_nodes table');

    try {
      db.exec(`DROP TABLE IF EXISTS ignored_nodes`);

      logger.debug('Migration 066 rollback completed');
    } catch (error) {
      logger.error('Migration 066 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add ignored_nodes table
 */
export async function runMigration066Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 066 (PostgreSQL): Add ignored_nodes table');

  try {
    // Check if table already exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'ignored_nodes'
      )
    `);

    if (tableExists.rows[0].exists) {
      logger.debug('ignored_nodes table already exists, skipping migration');
      return;
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS ignored_nodes (
        "nodeNum" INTEGER PRIMARY KEY,
        "nodeId" TEXT NOT NULL,
        "longName" TEXT,
        "shortName" TEXT,
        "ignoredAt" BIGINT NOT NULL,
        "ignoredBy" TEXT
      )
    `);

    logger.debug('Migration 066 (PostgreSQL): ignored_nodes table created');
  } catch (error) {
    logger.error('Migration 066 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add ignored_nodes table
 */
export async function runMigration066Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 066 (MySQL): Add ignored_nodes table');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if table already exists
      const [tables] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'ignored_nodes'
      `);

      if ((tables as any[]).length > 0) {
        logger.debug('ignored_nodes table already exists, skipping migration');
        return;
      }

      await connection.query(`
        CREATE TABLE IF NOT EXISTS ignored_nodes (
          nodeNum INT PRIMARY KEY,
          nodeId VARCHAR(255) NOT NULL,
          longName VARCHAR(255),
          shortName VARCHAR(255),
          ignoredAt BIGINT NOT NULL,
          ignoredBy VARCHAR(255)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      logger.debug('Migration 066 (MySQL): ignored_nodes table created');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 066 (MySQL) failed:', error);
    throw error;
  }
}
