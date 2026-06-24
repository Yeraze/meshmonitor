/**
 * Migration 102: Add channel_hash column to channel_database.
 *
 * MQTT channels are identified by NAME only, which collapses two same-name but
 * differently-keyed channels into one row when neither can be decrypted
 * server-side. The Meshtastic 1-byte channel hash (`packet.channel` on MQTT,
 * = xorHash(name) ^ xorHash(psk)) gives us a second identity dimension.
 *
 * Column semantics:
 *   - ENABLED rows (real PSK): channel_hash stays NULL — their hash is
 *     computable from name + psk on demand.
 *   - PASSIVE rows (psk=''): channel_hash stores the observed packet hash so
 *     two same-name/different-key undecryptable channels stay distinct.
 *
 * Nullable integer (0-255), defaults to NULL. Existing rows keep NULL, which
 * preserves the prior name-only matching behaviour.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 102 (SQLite): Adding channel_hash to channel_database...');

    try {
      db.exec('ALTER TABLE channel_database ADD COLUMN channel_hash INTEGER');
      logger.debug('Added channel_database.channel_hash');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('channel_database.channel_hash already exists, skipping');
      } else {
        logger.warn('Could not add channel_database.channel_hash:', e.message);
      }
    }

    logger.info('Migration 102 complete (SQLite): channel_database.channel_hash added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 102 down: Not implemented (destructive column drop)');
  },
};

// ============ PostgreSQL ============

export async function runMigration102Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 102 (PostgreSQL): Adding channel_hash to channel_database...');

  try {
    await client.query('ALTER TABLE channel_database ADD COLUMN IF NOT EXISTS "channelHash" INTEGER');
    logger.debug('Ensured channel_database.channelHash exists');
  } catch (error: any) {
    logger.error('Migration 102 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 102 complete (PostgreSQL): channel_database.channelHash added');
}

// ============ MySQL ============

export async function runMigration102Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 102 (MySQL): Adding channel_hash to channel_database...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'channel_database' AND COLUMN_NAME = 'channelHash'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query('ALTER TABLE channel_database ADD COLUMN channelHash INT NULL');
      logger.debug('Added channel_database.channelHash');
    } else {
      logger.debug('channel_database.channelHash already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 102 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 102 complete (MySQL): channel_database.channelHash added');
}
