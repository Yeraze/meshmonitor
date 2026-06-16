/**
 * Migration 090: Add `position_history_points_only` to `user_map_preferences`.
 *
 * Persists the Map Features "points only" toggle (issue #3492) — when on, the
 * position-history layer renders only the per-fix markers and omits the
 * connecting line. Defaults to false (line + points), so existing rows behave
 * exactly as before.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 090';
const TABLE = 'user_map_preferences';
const COLUMN = 'position_history_points_only';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
      // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER DEFAULT 0`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already present, skipping`);
      } else {
        throw e;
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration090Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" BOOLEAN DEFAULT false`,
  );
}

// ============ MySQL ============

export async function runMigration090Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TINYINT(1) DEFAULT 0`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already present, skipping`);
    }
  } finally {
    conn.release();
  }
}
