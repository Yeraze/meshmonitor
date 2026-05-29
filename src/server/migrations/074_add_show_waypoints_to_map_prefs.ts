/**
 * Migration 074: Add `show_waypoints` column to `user_map_preferences`.
 *
 * Persists the user's waypoint marker visibility toggle in the same way the
 * other Map Features toggles (`show_route`, `show_mqtt_nodes`, etc.) already
 * are. Default TRUE so existing installs keep showing waypoints — the toggle
 * is opt-out, matching the in-memory MapContext default so a fresh row read
 * is consistent with what the UI shows for an unconfigured user (#3253).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 074';
const TABLE = 'user_map_preferences';
const COLUMN = 'show_waypoints';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
      // eslint-disable-next-line no-restricted-syntax -- migrations require raw DDL
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER DEFAULT 1`);
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

export async function runMigration074Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" BOOLEAN DEFAULT TRUE`,
  );
}

// ============ MySQL ============

export async function runMigration074Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} BOOLEAN DEFAULT TRUE`);
      logger.debug(`${LABEL} (MySQL): added ${TABLE}.${COLUMN}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already present, skipping`);
    }
  } finally {
    conn.release();
  }
}
