/**
 * Migration 097: Add packetId column to traceroutes table (#3623)
 *
 * Traceroute rows previously stored no reference to the originating Meshtastic
 * packet. Recording the packet id lets callers:
 *   - correlate the same physical traceroute received via multiple sources
 *     (e.g. a local TCP mesh and an MQTT feed both hearing the same response), and
 *   - group/display individual traces (all flood-routing branches of one packet)
 *     rather than only the collapsed resulting path.
 *
 * NULL indicates the packet id was not captured (pre-migration rows).
 *
 * Meshtastic packet ids are unsigned 32-bit values, which overflow a signed
 * 32-bit INTEGER, so PostgreSQL/MySQL use BIGINT. SQLite INTEGER is 64-bit.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 097 (SQLite): Adding packetId column to traceroutes...');

    try {
      db.exec('ALTER TABLE traceroutes ADD COLUMN packetId INTEGER');
      logger.debug('Added packetId column to traceroutes');
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug('traceroutes.packetId already exists, skipping');
      } else {
        logger.warn('Could not add packetId to traceroutes:', e.message);
      }
    }

    logger.info('Migration 097 complete (SQLite): traceroutes.packetId added');
  },

  down: (_db: Database): void => {
    logger.debug('Migration 097 down: Not implemented (destructive column drops)');
  }
};

// ============ PostgreSQL ============

export async function runMigration097Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 097 (PostgreSQL): Adding packetId to traceroutes...');

  try {
    await client.query('ALTER TABLE traceroutes ADD COLUMN IF NOT EXISTS "packetId" BIGINT');
    logger.debug('Ensured traceroutes.packetId exists');
  } catch (error: any) {
    logger.error('Migration 097 (PostgreSQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 097 complete (PostgreSQL): traceroutes.packetId added');
}

// ============ MySQL ============

export async function runMigration097Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 097 (MySQL): Adding packetId to traceroutes...');

  try {
    const [rows] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'traceroutes' AND COLUMN_NAME = 'packetId'
    `);
    if (!Array.isArray(rows) || rows.length === 0) {
      await pool.query('ALTER TABLE traceroutes ADD COLUMN packetId BIGINT');
      logger.debug('Added packetId to traceroutes');
    } else {
      logger.debug('traceroutes.packetId already exists, skipping');
    }
  } catch (error: any) {
    logger.error('Migration 097 (MySQL) failed:', error.message);
    throw error;
  }

  logger.info('Migration 097 complete (MySQL): traceroutes.packetId added');
}
