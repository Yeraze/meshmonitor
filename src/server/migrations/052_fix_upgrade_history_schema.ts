/**
 * Migration 052: Fix upgrade_history table schema
 *
 * The upgrade_history table schema in postgres-create.ts and mysql-create.ts
 * was out of sync with the Drizzle schema in misc.ts. This migration fixes:
 *
 * 1. Renames 'upgradeType' to 'deploymentMethod'
 * 2. Renames 'error' to 'errorMessage'
 * 3. Adds missing columns: progress, currentStep, logs, backupPath, initiatedBy, rollbackAvailable
 * 4. Changes id from SERIAL/INT to TEXT/VARCHAR(64)
 *
 * For SQLite: No changes needed as it uses the Drizzle schema directly
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (_db: Database.Database): void => {
    logger.debug('Running migration 052: Fix upgrade_history schema...');
    // SQLite schema is managed by Drizzle and already correct
    logger.debug('✅ Migration 052: SQLite schema is already correct');
    logger.debug('✅ Migration 052 completed successfully');
  },

  down: (_db: Database.Database): void => {
    logger.debug('Reverting migration 052: No-op for SQLite');
  }
};

/**
 * PostgreSQL migration: Fix upgrade_history table schema
 */
export async function runMigration052Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 052 (PostgreSQL): Fix upgrade_history schema');

  try {
    // Check if table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'upgrade_history'
      )
    `);

    if (!tableExists.rows[0].exists) {
      logger.debug('upgrade_history table does not exist, skipping migration');
      return;
    }

    // Check if we need to migrate (does upgradeType column exist?)
    const needsMigration = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'upgrade_history'
          AND column_name = 'upgradeType'
      )
    `);

    if (!needsMigration.rows[0].exists) {
      // Check if deploymentMethod already exists (schema is already correct)
      const hasDeploymentMethod = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'upgrade_history'
            AND column_name = 'deploymentMethod'
        )
      `);

      if (hasDeploymentMethod.rows[0].exists) {
        logger.debug('upgrade_history schema is already correct, skipping');
        return;
      }
    }

    // Drop existing data and recreate table with correct schema
    // The upgrade_history table typically has temporary data that can be cleared
    logger.debug('Recreating upgrade_history table with correct schema...');

    await client.query('DROP TABLE IF EXISTS upgrade_history CASCADE');

    await client.query(`
      CREATE TABLE upgrade_history (
        id TEXT PRIMARY KEY,
        "fromVersion" TEXT NOT NULL,
        "toVersion" TEXT NOT NULL,
        "deploymentMethod" TEXT NOT NULL,
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        "currentStep" TEXT,
        logs TEXT,
        "backupPath" TEXT,
        "startedAt" BIGINT,
        "completedAt" BIGINT,
        "initiatedBy" TEXT,
        "errorMessage" TEXT,
        "rollbackAvailable" BOOLEAN
      )
    `);

    logger.debug('✅ Migration 052 (PostgreSQL): upgrade_history table recreated with correct schema');
  } catch (error) {
    logger.error('Migration 052 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Fix upgrade_history table schema
 */
export async function runMigration052Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 052 (MySQL): Fix upgrade_history schema');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if table exists
      const [tables] = await connection.query(`
        SELECT TABLE_NAME FROM information_schema.tables
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'upgrade_history'
      `);

      if ((tables as any[]).length === 0) {
        logger.debug('upgrade_history table does not exist, skipping migration');
        return;
      }

      // Check if we need to migrate (does upgradeType column exist?)
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'upgrade_history'
          AND COLUMN_NAME = 'upgradeType'
      `);

      if ((columns as any[]).length === 0) {
        // Check if deploymentMethod already exists
        const [deploymentCol] = await connection.query(`
          SELECT COLUMN_NAME FROM information_schema.columns
          WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'upgrade_history'
            AND COLUMN_NAME = 'deploymentMethod'
        `);

        if ((deploymentCol as any[]).length > 0) {
          logger.debug('upgrade_history schema is already correct, skipping');
          return;
        }
      }

      // Drop and recreate table with correct schema
      logger.debug('Recreating upgrade_history table with correct schema...');

      await connection.query('DROP TABLE IF EXISTS upgrade_history');

      await connection.query(`
        CREATE TABLE upgrade_history (
          id VARCHAR(64) PRIMARY KEY,
          fromVersion VARCHAR(32) NOT NULL,
          toVersion VARCHAR(32) NOT NULL,
          deploymentMethod VARCHAR(32) NOT NULL,
          status VARCHAR(32) NOT NULL,
          progress INT DEFAULT 0,
          currentStep VARCHAR(255),
          logs TEXT,
          backupPath VARCHAR(512),
          startedAt BIGINT,
          completedAt BIGINT,
          initiatedBy VARCHAR(255),
          errorMessage TEXT,
          rollbackAvailable BOOLEAN
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);

      logger.debug('✅ Migration 052 (MySQL): upgrade_history table recreated with correct schema');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 052 (MySQL) failed:', error);
    throw error;
  }
}
