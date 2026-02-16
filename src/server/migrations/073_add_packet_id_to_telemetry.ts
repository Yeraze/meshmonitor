/**
 * Migration 073: Add packetId column to telemetry table
 *
 * Adds a nullable packetId integer column to store the Meshtastic meshPacket.id
 * for each telemetry record. This allows API consumers to de-duplicate telemetry
 * data and identify the same packet received via multiple mesh paths.
 *
 * Computed/derived telemetry (estimated positions, config sync, link quality)
 * will store null since they don't originate from a specific mesh packet.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 073: Add packetId to telemetry');
    try {
      const columns = db.pragma("table_info('telemetry')") as Array<{ name: string }>;
      const existingColumns = new Set(columns.map((col) => col.name));

      if (!existingColumns.has('packetId')) {
        db.exec('ALTER TABLE telemetry ADD COLUMN packetId INTEGER;');
        logger.debug('Added packetId column to telemetry table');
      } else {
        logger.debug('packetId column already exists in telemetry table, skipping');
      }

      logger.debug('Migration 073 completed: packetId added to telemetry');
    } catch (error) {
      logger.error('Migration 073 failed:', error);
      throw error;
    }
  },

  down: (_db: Database): void => {
    logger.debug('Running migration 073 down: Remove packetId from telemetry');
    try {
      logger.debug('Note: SQLite DROP COLUMN requires version 3.35.0+');
      logger.debug('packetId column will remain but will not be used');
      logger.debug('Migration 073 rollback completed');
    } catch (error) {
      logger.error('Migration 073 rollback failed:', error);
      throw error;
    }
  }
};

/**
 * PostgreSQL migration: Add packetId column to telemetry table
 */
export async function runMigration073Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 073 (PostgreSQL): Add packetId to telemetry');
  // Check if column already exists
  const result = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'telemetry' AND column_name = 'packetId'
  `);
  if (result.rows.length === 0) {
    await client.query('ALTER TABLE telemetry ADD COLUMN "packetId" INTEGER;');
  }
}

/**
 * MySQL migration: Add packetId column to telemetry table
 */
export async function runMigration073Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 073 (MySQL): Add packetId to telemetry');
  // Check if column already exists
  const [rows] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'telemetry' AND COLUMN_NAME = 'packetId'
  `);
  if ((rows as any[]).length === 0) {
    await pool.query('ALTER TABLE telemetry ADD COLUMN packetId INT;');
  }
}
