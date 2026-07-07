/**
 * Migration 112: Add `notes` to `nodes`.
 *
 * Free-text per-node "notes" annotation (issue #3921) — a MeshMonitor-local
 * label editable from the node detail view, mirroring the official Meshtastic
 * mobile clients' local notes field. Purely server-side state: there is no
 * protobuf/admin message involved, so it is never synced to or from the mesh.
 *
 * Nullable with no default, so existing rows keep NULL (no note) and behave
 * exactly as before. Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 112';
const TABLE = 'nodes';
const COLUMN = 'notes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
       
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
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

export async function runMigration112Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(
    `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" TEXT`,
  );
}

// ============ MySQL ============

export async function runMigration112Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(2000)`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already present, skipping`);
    }
  } finally {
    conn.release();
  }
}
