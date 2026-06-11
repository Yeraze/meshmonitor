/**
 * Migration 086: Add maxNeighborAgeHours to auto_favorite_targets (issue #2608
 * follow-up). When NeighborInfo discovery runs, the service reuses an on-file
 * NeighborInfo record if it is newer than this many hours instead of requesting
 * a fresh one. Default 24.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 086';
const TABLE = 'auto_favorite_targets';
const COLUMN = 'maxNeighborAgeHours';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    try {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER NOT NULL DEFAULT 24`);
    } catch (error) {
      if (!String(error).includes('duplicate column')) throw error;
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${COLUMN} from ${TABLE}`);
    try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${COLUMN}`); } catch { /* older SQLite lacks DROP COLUMN */ }
  },
};

// ============ PostgreSQL ============

export async function runMigration086Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" INTEGER NOT NULL DEFAULT 24`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration086Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if ((rows as any[]).length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INT NOT NULL DEFAULT 24`);
    }
  } finally {
    conn.release();
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
