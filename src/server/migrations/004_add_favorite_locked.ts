/**
 * Migration 080: Add favoriteLocked column to nodes table
 *
 * Adds a favoriteLocked boolean column so that manual favorite actions lock
 * the node from auto-favorite automation. Existing favorites are treated as
 * manual (locked), then auto-managed nodes (from the autoFavoriteNodes setting)
 * are unlocked so automation can continue managing them.
 */

import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/**
 * SQLite migration: Add favoriteLocked column
 */
export const migration = {
  up: (db: Database): void => {
    logger.debug('Migration 080: Adding favoriteLocked column to nodes (SQLite)...');

    // Check if column already exists (idempotent)
    const columns = db.pragma('table_info(nodes)') as Array<{ name: string }>;
    if (columns.some(c => c.name === 'favoriteLocked')) {
      logger.debug('Migration 080: favoriteLocked column already exists (SQLite), skipping');
      return;
    }

    db.exec(`ALTER TABLE nodes ADD COLUMN favoriteLocked INTEGER DEFAULT 0`);

    // Treat existing favorites as manual (locked)
    db.exec(`UPDATE nodes SET favoriteLocked = 1 WHERE isFavorite = 1`);

    // Unlock auto-managed nodes so automation can continue managing them
    try {
      const row = db.prepare(`SELECT value FROM settings WHERE key = 'autoFavoriteNodes'`).get() as { value: string } | undefined;
      if (row) {
        const autoNodes: number[] = JSON.parse(row.value);
        if (autoNodes.length > 0) {
          const placeholders = autoNodes.map(() => '?').join(',');
          db.prepare(`UPDATE nodes SET favoriteLocked = 0 WHERE nodeNum IN (${placeholders})`).run(...autoNodes);
        }
      }
    } catch (error) {
      logger.warn('Migration 080: Could not read autoFavoriteNodes setting, all favorites will be locked:', error);
    }

    logger.debug('Migration 080: favoriteLocked column added (SQLite)');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 080 down: Cannot drop column in SQLite, skipping');
  }
};

/**
 * PostgreSQL migration: Add favoriteLocked column
 */
export async function runMigration080Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 080 (PostgreSQL): Adding favoriteLocked column...');

  try {
    // Check if column already exists (idempotent)
    const result = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'nodes' AND column_name = 'favoriteLocked'
    `);

    if (result.rows.length > 0) {
      logger.debug('favoriteLocked column already exists in PostgreSQL, skipping');
      return;
    }

    await client.query(`ALTER TABLE nodes ADD COLUMN "favoriteLocked" BOOLEAN DEFAULT false`);

    // Treat existing favorites as manual (locked)
    await client.query(`UPDATE nodes SET "favoriteLocked" = true WHERE "isFavorite" = true`);

    // Unlock auto-managed nodes
    try {
      const settingResult = await client.query(`SELECT value FROM settings WHERE key = 'autoFavoriteNodes'`);
      if (settingResult.rows.length > 0) {
        const autoNodes: number[] = JSON.parse(settingResult.rows[0].value);
        if (autoNodes.length > 0) {
          const placeholders = autoNodes.map((_, i) => `$${i + 1}`).join(',');
          await client.query(`UPDATE nodes SET "favoriteLocked" = false WHERE "nodeNum" IN (${placeholders})`, autoNodes);
        }
      }
    } catch (error) {
      logger.warn('Migration 080: Could not read autoFavoriteNodes setting (PostgreSQL):', error);
    }

    logger.info('Migration 080 complete (PostgreSQL): favoriteLocked column added');
  } catch (error: any) {
    logger.error('Failed to add favoriteLocked column (PostgreSQL):', error.message);
    throw error;
  }
}

/**
 * MySQL migration: Add favoriteLocked column
 */
export async function runMigration080Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 080 (MySQL): Adding favoriteLocked column...');

  try {
    // Check if column already exists (idempotent)
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nodes' AND COLUMN_NAME = 'favoriteLocked'
    `);

    if (Array.isArray(rows) && rows.length > 0) {
      logger.debug('favoriteLocked column already exists in MySQL, skipping');
      return;
    }

    await pool.query(`ALTER TABLE nodes ADD COLUMN favoriteLocked TINYINT(1) DEFAULT 0`);

    // Treat existing favorites as manual (locked)
    await pool.query(`UPDATE nodes SET favoriteLocked = 1 WHERE isFavorite = 1`);

    // Unlock auto-managed nodes
    try {
      const [settingRows] = await pool.query(`SELECT value FROM settings WHERE \`key\` = 'autoFavoriteNodes'`);
      if (Array.isArray(settingRows) && settingRows.length > 0) {
        const autoNodes: number[] = JSON.parse((settingRows as any)[0].value);
        if (autoNodes.length > 0) {
          const placeholders = autoNodes.map(() => '?').join(',');
          await pool.query(`UPDATE nodes SET favoriteLocked = 0 WHERE nodeNum IN (${placeholders})`, autoNodes);
        }
      }
    } catch (error) {
      logger.warn('Migration 080: Could not read autoFavoriteNodes setting (MySQL):', error);
    }

    logger.info('Migration 080 complete (MySQL): favoriteLocked column added');
  } catch (error: any) {
    logger.error('Failed to add favoriteLocked column (MySQL):', error.message);
    throw error;
  }
}
