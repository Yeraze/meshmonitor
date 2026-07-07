/**
 * Migration 087: Add `map_max_age_hours` column to `user_map_preferences`.
 *
 * Persists the Map Features "maximum age" slider value (hours) so the map can
 * hide node markers, traceroutes, and route segments older than the chosen age.
 * NULL means "follow the global maxNodeAgeHours setting" (the slider's default
 * position), so existing rows behave exactly as before. See #3322.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 087';
const TABLE = 'user_map_preferences';
const COLUMN = 'map_max_age_hours';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
       
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER`);
      logger.debug(`${LABEL} (SQLite): added ${TABLE}.${COLUMN}`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already present, skipping`);
      } else {
        logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${COLUMN}:`, e.message);
        throw e;
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration087Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" INTEGER`,
  );
}

// ============ MySQL ============

export async function runMigration087Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INT`);
      logger.debug(`${LABEL} (MySQL): added ${TABLE}.${COLUMN}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already present, skipping`);
    }
  } finally {
    conn.release();
  }
}
