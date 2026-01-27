/**
 * Migration 060: Add enabled column to auto_traceroute_nodes
 *
 * Migration 048 renamed addedAt -> createdAt but only added the `enabled`
 * column in its fallback path (table recreation). Users whose SQLite
 * supported ALTER TABLE RENAME COLUMN (most users) never got the `enabled`
 * column. This migration adds it if missing.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database): void => {
    logger.debug('Running migration 060: Add enabled column to auto_traceroute_nodes...');

    // Check if the table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='auto_traceroute_nodes'
    `).get();

    if (!tableExists) {
      logger.debug('auto_traceroute_nodes table does not exist, skipping');
      return;
    }

    // Check if enabled column already exists
    const tableInfo = db.prepare('PRAGMA table_info(auto_traceroute_nodes)').all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const hasEnabled = tableInfo.some(col => col.name === 'enabled');

    if (hasEnabled) {
      logger.debug('enabled column already exists, skipping');
      return;
    }

    db.exec('ALTER TABLE auto_traceroute_nodes ADD COLUMN enabled INTEGER DEFAULT 1');
    logger.debug('✅ Added enabled column to auto_traceroute_nodes');
  },

  down: (db: Database): void => {
    logger.debug('Reverting migration 060: Cannot remove column in SQLite, skipping');
    // SQLite doesn't support DROP COLUMN before 3.35.0, and the column is harmless
  }
};

/**
 * PostgreSQL migration: Add enabled column if missing
 */
export async function runMigration060Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 060 (PostgreSQL): Add enabled column to auto_traceroute_nodes...');

  const result = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'auto_traceroute_nodes' AND column_name = 'enabled'
  `);

  if (result.rows.length > 0) {
    logger.debug('enabled column already exists, skipping');
    return;
  }

  await client.query('ALTER TABLE auto_traceroute_nodes ADD COLUMN enabled BOOLEAN DEFAULT true');
  logger.debug('✅ Added enabled column to auto_traceroute_nodes (PostgreSQL)');
}

/**
 * MySQL migration: Add enabled column if missing
 */
export async function runMigration060Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 060 (MySQL): Add enabled column to auto_traceroute_nodes...');

  const [rows] = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'auto_traceroute_nodes' AND column_name = 'enabled'
  `) as any;

  if (rows.length > 0) {
    logger.debug('enabled column already exists, skipping');
    return;
  }

  await pool.query('ALTER TABLE auto_traceroute_nodes ADD COLUMN enabled BOOLEAN DEFAULT true');
  logger.debug('✅ Added enabled column to auto_traceroute_nodes (MySQL)');
}
