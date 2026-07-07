/**
 * Migration 068: Persist MeshCore per-contact route ("out_path") on
 * `meshcore_nodes`.
 *
 * MeshCore stores a forwarding hop chain alongside each contact: when the
 * sender has a known `out_path` the firmware uses ROUTE_TYPE_DIRECT, otherwise
 * it falls back to ROUTE_TYPE_FLOOD and lets the destination return a path on
 * the next round-trip. Capturing the bytes lets MeshMonitor render hop counts
 * and offer a "Reset Path" action without re-querying the device on every
 * page load.
 *
 * Adds two columns:
 *   - `out_path`  TEXT  — comma-separated hex of the active route bytes,
 *                         e.g. "a3,7f,02". NULL when unknown (firmware's
 *                         OUT_PATH_UNKNOWN = 0xFF).
 *   - `path_len`  INTEGER — hop count (0..63). NULL when unknown.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 068';
const TABLE = 'meshcore_nodes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE} out_path/path_len columns...`);
    for (const [col, ddl] of [
      ['out_path', 'TEXT'],
      ['path_len', 'INTEGER'],
    ] as const) {
      try {
         
        db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col} ${ddl}`);
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

export async function runMigration068Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE} out_path/path_len columns...`);
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "out_path" TEXT`,
  );
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "path_len" INTEGER`,
  );
}

// ============ MySQL ============

export async function runMigration068Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE} out_path/path_len columns...`);
  const conn = await pool.getConnection();
  try {
    for (const [col, ddl] of [
      ['out_path', 'VARCHAR(255)'],
      ['path_len', 'INT'],
    ] as const) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, col],
      );
      if (Array.isArray(rows) && rows.length === 0) {
        await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${col} ${ddl}`);
        logger.debug(`${LABEL} (MySQL): added ${TABLE}.${col}`);
      } else {
        logger.debug(`${LABEL} (MySQL): ${TABLE}.${col} already present, skipping`);
      }
    }
  } finally {
    conn.release();
  }
}
