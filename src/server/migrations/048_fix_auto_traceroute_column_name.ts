/**
 * Migration 048: Fix auto_traceroute_nodes column name inconsistency
 *
 * The SQLite migration 015 created the table with 'addedAt' column,
 * but the Drizzle schema and PostgreSQL/MySQL use 'createdAt'.
 * This migration renames the column in SQLite for consistency.
 */

import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database): void => {
    logger.debug('Running migration 048: Fix auto_traceroute_nodes column name...');

    // Check if the table exists
    const tableExists = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name='auto_traceroute_nodes'
    `).get();

    if (!tableExists) {
      logger.debug('auto_traceroute_nodes table does not exist, skipping');
      return;
    }

    // Check if the column is named 'addedAt' (the old name)
    const tableInfo = db.prepare('PRAGMA table_info(auto_traceroute_nodes)').all() as Array<{
      cid: number;
      name: string;
      type: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
    }>;

    const hasAddedAt = tableInfo.some(col => col.name === 'addedAt');
    const hasCreatedAt = tableInfo.some(col => col.name === 'createdAt');

    if (hasCreatedAt && !hasAddedAt) {
      logger.debug('Column is already named createdAt, skipping');
      return;
    }

    if (!hasAddedAt) {
      logger.debug('addedAt column not found, table may have different schema');
      return;
    }

    // SQLite 3.25.0+ supports ALTER TABLE RENAME COLUMN
    // better-sqlite3 should use a recent enough version
    try {
      db.exec('ALTER TABLE auto_traceroute_nodes RENAME COLUMN addedAt TO createdAt');
      logger.debug('✅ Renamed addedAt to createdAt');
    } catch (error) {
      // Fallback for older SQLite versions: recreate the table
      logger.debug('RENAME COLUMN not supported, using table recreation fallback');

      db.exec(`
        -- Create new table with correct column name
        CREATE TABLE auto_traceroute_nodes_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum INTEGER NOT NULL UNIQUE,
          createdAt INTEGER NOT NULL,
          enabled INTEGER DEFAULT 1,
          FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
        );

        -- Copy data from old table
        INSERT INTO auto_traceroute_nodes_new (id, nodeNum, createdAt, enabled)
        SELECT id, nodeNum, addedAt, COALESCE(enabled, 1) FROM auto_traceroute_nodes;

        -- Drop old table
        DROP TABLE auto_traceroute_nodes;

        -- Rename new table
        ALTER TABLE auto_traceroute_nodes_new RENAME TO auto_traceroute_nodes;

        -- Recreate index
        CREATE INDEX IF NOT EXISTS idx_auto_traceroute_nodes
          ON auto_traceroute_nodes(nodeNum);
      `);
      logger.debug('✅ Recreated table with createdAt column');
    }

    logger.debug('✅ Migration 048 completed successfully');
  },

  down: (db: Database.Database): void => {
    logger.debug('Reverting migration 048: Rename createdAt back to addedAt...');

    try {
      db.exec('ALTER TABLE auto_traceroute_nodes RENAME COLUMN createdAt TO addedAt');
    } catch {
      // Fallback
      db.exec(`
        CREATE TABLE auto_traceroute_nodes_old (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          nodeNum INTEGER NOT NULL UNIQUE,
          addedAt INTEGER NOT NULL,
          enabled INTEGER DEFAULT 1,
          FOREIGN KEY (nodeNum) REFERENCES nodes(nodeNum) ON DELETE CASCADE
        );

        INSERT INTO auto_traceroute_nodes_old (id, nodeNum, addedAt, enabled)
        SELECT id, nodeNum, createdAt, enabled FROM auto_traceroute_nodes;

        DROP TABLE auto_traceroute_nodes;

        ALTER TABLE auto_traceroute_nodes_old RENAME TO auto_traceroute_nodes;

        CREATE INDEX IF NOT EXISTS idx_auto_traceroute_nodes
          ON auto_traceroute_nodes(nodeNum);
      `);
    }

    logger.debug('✅ Migration 048 reverted successfully');
  }
};

/**
 * PostgreSQL migration: No-op, column is already named createdAt
 */
export async function runMigration048Postgres(_client: import('pg').PoolClient): Promise<void> {
  logger.debug('Running migration 048 (PostgreSQL): No-op, column already named createdAt');
}

/**
 * MySQL migration: No-op, column is already named createdAt
 */
export async function runMigration048Mysql(_pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug('Running migration 048 (MySQL): No-op, column already named createdAt');
}
