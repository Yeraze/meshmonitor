/**
 * Migration 106: Add scopeCode + scopeName to meshcore_messages (#3742 Phase 2).
 *
 * Surfaces the scope/region a received MeshCore message was sent with. scopeCode
 * is the packet's transport_code_1 (0 = sent unscoped, NULL = no scope info);
 * scopeName is the region name resolved against known scopes at receive time
 * (NULL = unscoped/unknown). Both nullable; existing + room/legacy rows keep NULL.
 *
 * The meshcore_messages table uses camelCase columns on every backend.
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 106 (SQLite): Adding scopeCode + scopeName to meshcore_messages...');
    for (const col of ['scopeCode INTEGER', 'scopeName TEXT']) {
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
    logger.info('Migration 106 complete (SQLite): meshcore_messages scope columns added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 106 down: Not implemented (destructive column drop)');
  },
};

// ============ PostgreSQL ============

export async function runMigration106Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 106 (PostgreSQL): Adding scopeCode + scopeName to meshcore_messages...');
  try {
    await client.query('ALTER TABLE meshcore_messages ADD COLUMN IF NOT EXISTS "scopeCode" INTEGER');
    await client.query('ALTER TABLE meshcore_messages ADD COLUMN IF NOT EXISTS "scopeName" TEXT');
    logger.debug('Ensured meshcore_messages.scopeCode + scopeName exist');
  } catch (error: any) {
    logger.error('Migration 106 (PostgreSQL) failed:', error.message);
    throw error;
  }
  logger.info('Migration 106 complete (PostgreSQL): meshcore_messages scope columns added');
}

// ============ MySQL ============

export async function runMigration106Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 106 (MySQL): Adding scopeCode + scopeName to meshcore_messages...');
  try {
    for (const [name, ddl] of [['scopeCode', 'scopeCode INT NULL'], ['scopeName', 'scopeName TEXT NULL']] as const) {
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
    logger.error('Migration 106 (MySQL) failed:', error.message);
    throw error;
  }
  logger.info('Migration 106 complete (MySQL): meshcore_messages scope columns added');
}
