/**
 * Migration 100: Add scope column to channels table (#3667)
 *
 * MeshCore "regions"/"scopes" are named flood-forwarding tags. A channel may
 * carry an optional scope so messages on that channel are forwarded only by
 * repeaters configured for that region (German meshes run `region denyf *`,
 * which drops un-scoped traffic). The scope is the plain region name (without
 * the leading '#'); NULL means "inherit the source's default scope / unscoped".
 *
 * Important: MeshCore's companion protocol has no per-channel scope field, so
 * this value is owned entirely by MeshMonitor and is never reported back by the
 * device. `syncChannelsFromDevice()` must preserve it across re-syncs.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 100 (SQLite): Adding scope column to channels...');

    try {
      db.exec('ALTER TABLE channels ADD COLUMN scope TEXT');
      logger.debug('Added scope column to channels');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('channels.scope already exists, skipping');
      } else {
        logger.warn('Could not add scope to channels:', e.message);
      }
    }

    logger.info('Migration 100 complete (SQLite): channels.scope added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 100 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration100Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 100 (PostgreSQL): Adding scope to channels...');

  try {
    await client.query('ALTER TABLE channels ADD COLUMN IF NOT EXISTS "scope" TEXT');
    logger.debug('Ensured channels.scope exists');
  } catch (error: any) {
    logger.error('Migration 100 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 100 complete (PostgreSQL): channels.scope added');
}

// ============ MySQL ============

export async function runMigration100Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 100 (MySQL): Adding scope to channels...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channels' AND COLUMN_NAME = 'scope'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query("ALTER TABLE channels ADD COLUMN scope VARCHAR(64)");
      logger.debug('Added scope to channels');
    } else {
      logger.debug('channels.scope already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 100 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 100 complete (MySQL): channels.scope added');
}
