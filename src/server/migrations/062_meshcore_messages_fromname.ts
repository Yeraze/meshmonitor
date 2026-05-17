/**
 * Migration 062: Add `fromName` column to `meshcore_messages`.
 *
 * MeshCore channel packets carry no per-sender identity on the wire — the
 * sender prefixes their display name onto the text body ("Alice: hello").
 * MeshCoreManager parses this prefix out and stores it as `fromName` on the
 * in-memory MeshCoreMessage so the UI can render sender and body separately.
 * Before this migration that field was never persisted, so channel messages
 * loaded from the database on restart would show without sender attribution.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 062';
const TABLE = 'meshcore_messages';
const COLUMN = 'fromName';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
      logger.debug(`${LABEL} (SQLite): added ${TABLE}.${COLUMN}`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already exists, skipping`);
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

export async function runMigration062Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" TEXT`);
  logger.debug(`${LABEL} (PostgreSQL): ensured ${TABLE}.${COLUMN}`);
}

// ============ MySQL ============

export async function runMigration062Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(64)`);
      logger.debug(`${LABEL} (MySQL): added ${TABLE}.${COLUMN}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already exists, skipping`);
    }
  } finally {
    conn.release();
  }
}
