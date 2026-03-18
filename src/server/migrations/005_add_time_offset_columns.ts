/**
 * Migration 081: Add time offset detection columns to nodes table
 *
 * Adds columns to track nodes with clocks significantly out of sync:
 * - isTimeOffsetIssue: boolean flag for nodes exceeding time offset threshold
 * - timeOffsetSeconds: the measured clock offset in seconds (positive = node behind, negative = ahead)
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 081: Add time offset detection columns to nodes...');

    const tableInfo = db.prepare('PRAGMA table_info(nodes)').all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const existingColumns = new Set(tableInfo.map(col => col.name));

    if (!existingColumns.has('isTimeOffsetIssue')) {
      db.exec('ALTER TABLE nodes ADD COLUMN isTimeOffsetIssue INTEGER DEFAULT 0');
      logger.debug('✅ Added isTimeOffsetIssue column');
    }

    if (!existingColumns.has('timeOffsetSeconds')) {
      db.exec('ALTER TABLE nodes ADD COLUMN timeOffsetSeconds INTEGER');
      logger.debug('✅ Added timeOffsetSeconds column');
    }

    logger.debug('✅ Migration 081 complete');
  },

  down: (_db: Database): void => {
    logger.debug('Reverting migration 081: Cannot remove columns in SQLite, skipping');
  }
};

export async function runMigration081Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 081 (PostgreSQL): Add time offset detection columns to nodes...');

  const result = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'nodes' AND column_name IN ('isTimeOffsetIssue', 'timeOffsetSeconds')
  `);

  const existingColumns = new Set(result.rows.map((r: { column_name: string }) => r.column_name));

  if (!existingColumns.has('isTimeOffsetIssue')) {
    await client.query('ALTER TABLE nodes ADD COLUMN "isTimeOffsetIssue" BOOLEAN DEFAULT false');
    logger.debug('✅ Added isTimeOffsetIssue column (PostgreSQL)');
  }

  if (!existingColumns.has('timeOffsetSeconds')) {
    await client.query('ALTER TABLE nodes ADD COLUMN "timeOffsetSeconds" INTEGER');
    logger.debug('✅ Added timeOffsetSeconds column (PostgreSQL)');
  }

  logger.debug('✅ Migration 081 complete (PostgreSQL)');
}

export async function runMigration081Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 081 (MySQL): Add time offset detection columns to nodes...');

  const [rows] = await pool.query(`
    SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes'
      AND COLUMN_NAME IN ('isTimeOffsetIssue', 'timeOffsetSeconds')
  `) as any;

  const existingColumns = new Set(rows.map((r: { COLUMN_NAME: string }) => r.COLUMN_NAME));

  if (!existingColumns.has('isTimeOffsetIssue')) {
    await pool.query('ALTER TABLE nodes ADD COLUMN isTimeOffsetIssue BOOLEAN DEFAULT false');
    logger.debug('✅ Added isTimeOffsetIssue column (MySQL)');
  }

  if (!existingColumns.has('timeOffsetSeconds')) {
    await pool.query('ALTER TABLE nodes ADD COLUMN timeOffsetSeconds INT');
    logger.debug('✅ Added timeOffsetSeconds column (MySQL)');
  }

  logger.debug('✅ Migration 081 complete (MySQL)');
}
