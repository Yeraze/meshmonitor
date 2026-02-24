/**
 * Migration 061: Add spam detection columns to nodes table
 *
 * Adds columns to track excessive packet rates that may indicate spam:
 * - isExcessivePackets: boolean flag for nodes exceeding packet rate threshold
 * - packetRatePerHour: the calculated packet rate per hour
 * - packetRateLastChecked: timestamp when rate was last checked
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 061: Add spam detection columns to nodes...');

    // Check which columns already exist
    const tableInfo = db.prepare('PRAGMA table_info(nodes)').all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const existingColumns = new Set(tableInfo.map(col => col.name));

    if (!existingColumns.has('isExcessivePackets')) {
      db.exec('ALTER TABLE nodes ADD COLUMN isExcessivePackets INTEGER DEFAULT 0');
      logger.debug('✅ Added isExcessivePackets column');
    }

    if (!existingColumns.has('packetRatePerHour')) {
      db.exec('ALTER TABLE nodes ADD COLUMN packetRatePerHour INTEGER');
      logger.debug('✅ Added packetRatePerHour column');
    }

    if (!existingColumns.has('packetRateLastChecked')) {
      db.exec('ALTER TABLE nodes ADD COLUMN packetRateLastChecked INTEGER');
      logger.debug('✅ Added packetRateLastChecked column');
    }

    logger.debug('✅ Migration 061 complete');
  },

  down: (_db: Database): void => {
    logger.debug('Reverting migration 061: Cannot remove columns in SQLite, skipping');
  }
};

/**
 * PostgreSQL migration: Add spam detection columns
 */
export async function runMigration061Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 061 (PostgreSQL): Add spam detection columns to nodes...');

  const result = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'nodes' AND column_name IN ('isExcessivePackets', 'packetRatePerHour', 'packetRateLastChecked')
  `);

  const existingColumns = new Set(result.rows.map((r: { column_name: string }) => r.column_name));

  if (!existingColumns.has('isExcessivePackets')) {
    await client.query('ALTER TABLE nodes ADD COLUMN "isExcessivePackets" BOOLEAN DEFAULT false');
    logger.debug('✅ Added isExcessivePackets column (PostgreSQL)');
  }

  if (!existingColumns.has('packetRatePerHour')) {
    await client.query('ALTER TABLE nodes ADD COLUMN "packetRatePerHour" INTEGER');
    logger.debug('✅ Added packetRatePerHour column (PostgreSQL)');
  }

  if (!existingColumns.has('packetRateLastChecked')) {
    await client.query('ALTER TABLE nodes ADD COLUMN "packetRateLastChecked" BIGINT');
    logger.debug('✅ Added packetRateLastChecked column (PostgreSQL)');
  }

  logger.debug('✅ Migration 061 complete (PostgreSQL)');
}

/**
 * MySQL migration: Add spam detection columns
 */
export async function runMigration061Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 061 (MySQL): Add spam detection columns to nodes...');

  const [rows] = await pool.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes'
      AND COLUMN_NAME IN ('isExcessivePackets', 'packetRatePerHour', 'packetRateLastChecked')
  `) as any;

  const existingColumns = new Set(rows.map((r: { COLUMN_NAME: string }) => r.COLUMN_NAME));

  if (!existingColumns.has('isExcessivePackets')) {
    await pool.query('ALTER TABLE nodes ADD COLUMN isExcessivePackets BOOLEAN DEFAULT false');
    logger.debug('✅ Added isExcessivePackets column (MySQL)');
  }

  if (!existingColumns.has('packetRatePerHour')) {
    await pool.query('ALTER TABLE nodes ADD COLUMN packetRatePerHour INT');
    logger.debug('✅ Added packetRatePerHour column (MySQL)');
  }

  if (!existingColumns.has('packetRateLastChecked')) {
    await pool.query('ALTER TABLE nodes ADD COLUMN packetRateLastChecked BIGINT');
    logger.debug('✅ Added packetRateLastChecked column (MySQL)');
  }

  logger.debug('✅ Migration 061 complete (MySQL)');
}
