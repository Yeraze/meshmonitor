/**
 * Migration 057: Add via_mqtt column to packet_log table
 *
 * Adds transport mechanism tracking:
 * - true: Packet was received via MQTT bridge
 * - false: Packet was received via direct LoRa connection
 *
 * This allows filtering and distinguishing packet sources in the Packet Monitor.
 * Fixes issue #1619.
 */
import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 057: Add via_mqtt column to packet_log table');

    try {
      // Check if column already exists
      const tableInfo = db.prepare('PRAGMA table_info(packet_log)').all() as { name: string }[];
      const columnNames = tableInfo.map((col) => col.name);

      if (!columnNames.includes('via_mqtt')) {
        db.exec(`ALTER TABLE packet_log ADD COLUMN via_mqtt INTEGER DEFAULT 0`);
        logger.debug('✅ Added via_mqtt column to packet_log table');
      } else {
        logger.debug('ℹ️  via_mqtt column already exists in packet_log table');
      }

      logger.debug('✅ Migration 057 completed successfully');
    } catch (error: any) {
      logger.error('❌ Migration 057 failed:', error);
      throw error;
    }
  },

  down: (_db: Database.Database): void => {
    logger.debug('Reverting migration 057: Remove via_mqtt column from packet_log table');

    try {
      // Note: SQLite doesn't support DROP COLUMN easily in older versions
      // For safety, we leave the column in place on rollback
      // It won't affect functionality and can be cleaned up manually if needed
      logger.debug('ℹ️  Migration 057 rollback: via_mqtt column left in place (SQLite limitation)');
    } catch (error) {
      logger.error('❌ Migration 057 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add via_mqtt column to packet_log table
 */
export async function runMigration057Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 057 (PostgreSQL): Add via_mqtt column to packet_log table');

  try {
    // Check if column exists
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'packet_log'
        AND column_name = 'via_mqtt'
    `);

    if (result.rows.length === 0) {
      await client.query(`ALTER TABLE packet_log ADD COLUMN via_mqtt BOOLEAN DEFAULT false`);
      logger.debug('  Added via_mqtt column to packet_log table');
    } else {
      logger.debug('  via_mqtt column already exists in packet_log table');
    }

    logger.debug('Migration 057 (PostgreSQL) complete');
  } catch (error) {
    logger.error('Migration 057 (PostgreSQL) failed:', error);
    throw error;
  }
}

/**
 * MySQL migration: Add via_mqtt column to packet_log table
 */
export async function runMigration057Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 057 (MySQL): Add via_mqtt column to packet_log table');

  try {
    const connection = await pool.getConnection();
    try {
      // Check if column exists
      const [rows] = await connection.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'packet_log'
        AND COLUMN_NAME = 'via_mqtt'
      `) as [any[], any];

      if (rows.length === 0) {
        await connection.query(`ALTER TABLE packet_log ADD COLUMN via_mqtt BOOLEAN DEFAULT false`);
        logger.debug('  Added via_mqtt column to packet_log table');
      } else {
        logger.debug('  via_mqtt column already exists in packet_log table');
      }

      logger.debug('Migration 057 (MySQL) complete');
    } finally {
      connection.release();
    }
  } catch (error) {
    logger.error('Migration 057 (MySQL) failed:', error);
    throw error;
  }
}
