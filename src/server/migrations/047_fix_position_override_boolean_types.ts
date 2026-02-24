/**
 * Migration 047: Fix position override boolean type consistency
 *
 * This migration converts positionOverrideEnabled and positionOverrideIsPrivate
 * columns from INTEGER to proper boolean types for PostgreSQL and MySQL.
 * SQLite continues to use INTEGER with mode: 'boolean' (SQLite has no native boolean).
 *
 * This fixes the type inconsistency where these fields used INTEGER while other
 * boolean fields like isFavorite, isIgnored use native boolean types.
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 047: Fix position override boolean types...');

    // SQLite doesn't have native BOOLEAN - it stores as 0/1 integers
    // The schema uses integer with mode: 'boolean' which handles conversion
    // No actual schema change needed for SQLite since the storage is the same

    // However, we need to ensure existing data is properly normalized
    // Update any NULL values to proper 0 (false)
    db.exec(`
      UPDATE nodes SET positionOverrideEnabled = 0 WHERE positionOverrideEnabled IS NULL
    `);
    db.exec(`
      UPDATE nodes SET positionOverrideIsPrivate = 0 WHERE positionOverrideIsPrivate IS NULL
    `);

    logger.debug('✅ Migration 047: Normalized NULL values to 0');
    logger.debug('✅ Migration 047 completed successfully');
  },

  down: (_db: Database.Database): void => {
    logger.debug('Reverting migration 047: No-op (boolean normalization is not reversible)');
    // No-op: cannot restore NULL values
  }
};

/**
 * PostgreSQL migration: Convert INTEGER columns to BOOLEAN
 */
export async function runMigration047Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 047 (PostgreSQL): Fix position override boolean types');

  try {
    // Check if columns exist and are INTEGER type
    const checkResult = await client.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'nodes'
        AND column_name IN ('positionOverrideEnabled', 'positionOverrideIsPrivate')
    `);

    for (const row of checkResult.rows) {
      const { column_name, data_type } = row;

      // Only convert if currently integer
      if (data_type === 'integer' || data_type === 'bigint') {
        logger.debug(`Converting ${column_name} from ${data_type} to BOOLEAN`);

        // First, drop the default constraint (required before type change in PostgreSQL)
        await client.query(`
          ALTER TABLE nodes
          ALTER COLUMN "${column_name}" DROP DEFAULT
        `);

        // PostgreSQL can cast integer to boolean (0 = false, non-zero = true)
        await client.query(`
          ALTER TABLE nodes
          ALTER COLUMN "${column_name}" TYPE BOOLEAN
          USING CASE WHEN "${column_name}" = 0 OR "${column_name}" IS NULL THEN false ELSE true END
        `);

        // Set default to false
        await client.query(`
          ALTER TABLE nodes
          ALTER COLUMN "${column_name}" SET DEFAULT false
        `);

        logger.debug(`Successfully converted ${column_name} to BOOLEAN`);
      } else if (data_type === 'boolean') {
        logger.debug(`${column_name} is already BOOLEAN, skipping`);
      }
    }

    logger.debug('Migration 047 (PostgreSQL) complete');
  } catch (error) {
    logger.error('Migration 047 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Convert INT columns to BOOLEAN (TINYINT(1))
 */
export async function runMigration047Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 047 (MySQL): Fix position override boolean types');

  try {
    const connection = await pool.getConnection();
    try {
      // Check current column types
      const [columns] = await connection.query(`
        SELECT COLUMN_NAME, DATA_TYPE
        FROM information_schema.columns
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'nodes'
          AND COLUMN_NAME IN ('positionOverrideEnabled', 'positionOverrideIsPrivate')
      `);

      for (const row of columns as Array<{ COLUMN_NAME: string; DATA_TYPE: string }>) {
        const { COLUMN_NAME, DATA_TYPE } = row;

        // Only convert if currently int
        if (DATA_TYPE === 'int' || DATA_TYPE === 'bigint') {
          logger.debug(`Converting ${COLUMN_NAME} from ${DATA_TYPE} to BOOLEAN`);

          // MySQL BOOLEAN is TINYINT(1), converts automatically
          await connection.query(`
            ALTER TABLE nodes
            MODIFY COLUMN ${COLUMN_NAME} BOOLEAN DEFAULT false
          `);

          logger.debug(`Successfully converted ${COLUMN_NAME} to BOOLEAN`);
        } else if (DATA_TYPE === 'tinyint') {
          logger.debug(`${COLUMN_NAME} is already BOOLEAN (TINYINT), skipping`);
        }
      }

      logger.debug('Migration 047 (MySQL) complete');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 047 (MySQL) failed:', error);
    throw error;
  }
}
