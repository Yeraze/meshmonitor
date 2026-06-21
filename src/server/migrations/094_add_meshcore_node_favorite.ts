/**
 * Migration 094: Server-side favorite flag on `meshcore_nodes`.
 *
 * Adds a single nullable boolean column:
 *
 *   isFavorite  BOOLEAN  (false by default)
 *
 * MeshCore firmware has no native favorite concept, so this flag is stored
 * server-side only and never pushed to the device (unlike Meshtastic, whose
 * favorite toggle round-trips a `SetFavoriteNode` admin message). Favorited
 * nodes are pinned to the top of the MeshCore node list (issue #3588).
 *
 * Backfill is unnecessary — existing rows default to non-favorite.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 094';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding isFavorite column to meshcore_nodes...`);
    try {
      db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN isFavorite INTEGER DEFAULT 0`);
      logger.debug(`${LABEL} (SQLite): added meshcore_nodes.isFavorite`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): meshcore_nodes.isFavorite already exists, skipping`);
      } else {
        logger.error(`${LABEL} (SQLite): could not add meshcore_nodes.isFavorite:`, e.message);
        throw e;
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration094Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding isFavorite column to meshcore_nodes...`);
  await client.query(
    `ALTER TABLE meshcore_nodes ADD COLUMN IF NOT EXISTS "isFavorite" BOOLEAN DEFAULT FALSE`,
  );
  logger.debug(`${LABEL} (PostgreSQL): ensured meshcore_nodes.isFavorite`);
}

// ============ MySQL ============

export async function runMigration094Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding isFavorite column to meshcore_nodes...`);

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes' AND COLUMN_NAME = 'isFavorite'`,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.query(`ALTER TABLE meshcore_nodes ADD COLUMN isFavorite TINYINT(1) DEFAULT 0`);
      logger.debug(`${LABEL} (MySQL): added meshcore_nodes.isFavorite`);
    } else {
      logger.debug(`${LABEL} (MySQL): meshcore_nodes.isFavorite already exists, skipping`);
    }
  } finally {
    conn.release();
  }
}
