/**
 * Migration 067: Add `show_udp_nodes` and `show_rf_nodes` columns to
 * `user_map_preferences`. Companion to migration 066 — those columns
 * persist the user's per-transport map visibility toggles in the same
 * way `show_mqtt_nodes` already does. Defaults: RF on, UDP off
 * (matches the in-memory MapContext defaults so a fresh row read is
 * consistent with what the UI shows for an unconfigured user).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 067';
const TABLE = 'user_map_preferences';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE} transport-filter columns...`);
    for (const [col, dflt] of [['show_udp_nodes', 0], ['show_rf_nodes', 1]] as const) {
      try {
         
        db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col} INTEGER DEFAULT ${dflt}`);
        logger.debug(`${LABEL} (SQLite): added ${TABLE}.${col}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`${LABEL} (SQLite): ${TABLE}.${col} already present, skipping`);
        } else {
          logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${col}:`, e.message);
          throw e;
        }
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration067Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE} transport-filter columns...`);
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "show_udp_nodes" BOOLEAN DEFAULT FALSE`,
  );
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "show_rf_nodes" BOOLEAN DEFAULT TRUE`,
  );
}

// ============ MySQL ============

export async function runMigration067Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE} transport-filter columns...`);
  const conn = await pool.getConnection();
  try {
    for (const [col, dflt] of [
      ['show_udp_nodes', 'FALSE'],
      ['show_rf_nodes', 'TRUE'],
    ] as const) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, col],
      );
      if (Array.isArray(rows) && rows.length === 0) {
        await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${col} BOOLEAN DEFAULT ${dflt}`);
        logger.debug(`${LABEL} (MySQL): added ${TABLE}.${col}`);
      } else {
        logger.debug(`${LABEL} (MySQL): ${TABLE}.${col} already present, skipping`);
      }
    }
  } finally {
    conn.release();
  }
}
