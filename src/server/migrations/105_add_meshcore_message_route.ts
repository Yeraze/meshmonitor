/**
 * Migration 105: Add hopCount + routePath to meshcore_messages (#3742).
 *
 * Surfaces the hop count and relay-hash route path for received MeshCore
 * channel/DM messages (already decoded for auto-ack {ROUTE}/{HOPS} templates,
 * now persisted + shown in the UI). Both nullable; existing rows keep NULL
 * (direct/unknown). Room messages carry no path, so they stay NULL.
 *
 * The meshcore_messages table uses camelCase columns on every backend.
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 105 (SQLite): Adding hopCount + routePath to meshcore_messages...');
    for (const col of ['hopCount INTEGER', 'routePath TEXT']) {
      try {
        db.exec(`ALTER TABLE meshcore_messages ADD COLUMN ${col}`);
        logger.debug(`Added meshcore_messages.${col.split(' ')[0]}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`meshcore_messages.${col.split(' ')[0]} already exists, skipping`);
        } else {
          logger.warn(`Could not add meshcore_messages.${col.split(' ')[0]}:`, e.message);
        }
      }
    }
    logger.info('Migration 105 complete (SQLite): meshcore_messages route columns added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 105 down: Not implemented (destructive column drop)');
  },
};

// ============ PostgreSQL ============

export async function runMigration105Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 105 (PostgreSQL): Adding hopCount + routePath to meshcore_messages...');
  try {
    await client.query('ALTER TABLE meshcore_messages ADD COLUMN IF NOT EXISTS "hopCount" INTEGER');
    await client.query('ALTER TABLE meshcore_messages ADD COLUMN IF NOT EXISTS "routePath" TEXT');
    logger.debug('Ensured meshcore_messages.hopCount + routePath exist');
  } catch (error: any) {
    logger.error('Migration 105 (PostgreSQL) failed:', error.message);
    throw error;
  }
  logger.info('Migration 105 complete (PostgreSQL): meshcore_messages route columns added');
}

// ============ MySQL ============

export async function runMigration105Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 105 (MySQL): Adding hopCount + routePath to meshcore_messages...');
  try {
    for (const [name, ddl] of [['hopCount', 'hopCount INT NULL'], ['routePath', 'routePath TEXT NULL']] as const) {
      const [rows] = await pool.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_messages' AND COLUMN_NAME = ?
      `, [name]);
      if (!Array.isArray(rows) || rows.length === 0) {
        await pool.query(`ALTER TABLE meshcore_messages ADD COLUMN ${ddl}`);
        logger.debug(`Added meshcore_messages.${name}`);
      } else {
        logger.debug(`meshcore_messages.${name} already exists, skipping`);
      }
    }
  } catch (error: any) {
    logger.error('Migration 105 (MySQL) failed:', error.message);
    throw error;
  }
  logger.info('Migration 105 complete (MySQL): meshcore_messages route columns added');
}
