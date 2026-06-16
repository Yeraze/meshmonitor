/**
 * Migration 089: Add rxSnr / hopStart / hopLimit to the telemetry table so
 * position fixes can record the receive SNR and hop metadata of the packet they
 * arrived in (issue #3492). These are used by the position-history hover tooltip
 * to show hop count and — only when the fix was heard directly (hopStart ===
 * hopLimit, i.e. 0 hops) — the SNR. Nullable: only position rows populate them,
 * and only for fixes received after this migration (capture-forward).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 089';
const TABLE = 'telemetry';
const COLUMNS: Array<{ name: string; sqlite: string; pg: string; mysql: string }> = [
  { name: 'rxSnr', sqlite: 'REAL', pg: 'double precision', mysql: 'DOUBLE' },
  { name: 'hopStart', sqlite: 'INTEGER', pg: 'INTEGER', mysql: 'INT' },
  { name: 'hopLimit', sqlite: 'INTEGER', pg: 'INTEGER', mysql: 'INT' },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding rxSnr/hopStart/hopLimit to ${TABLE}...`);
    for (const col of COLUMNS) {
      try {
        db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col.name} ${col.sqlite}`);
      } catch (error) {
        if (!String(error).includes('duplicate column')) throw error;
      }
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping position SNR/hop columns from ${TABLE}`);
    for (const col of COLUMNS) {
      try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${col.name}`); } catch { /* older SQLite lacks DROP COLUMN */ }
    }
  },
};

// ============ PostgreSQL ============

export async function runMigration089Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding rxSnr/hopStart/hopLimit to ${TABLE}...`);
  for (const col of COLUMNS) {
    await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${col.name}" ${col.pg}`);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration089Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding rxSnr/hopStart/hopLimit to ${TABLE}...`);
  const conn = await pool.getConnection();
  try {
    for (const col of COLUMNS) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, col.name],
      );
      if ((rows as any[]).length === 0) {
        await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${col.name} ${col.mysql}`);
      }
    }
  } finally {
    conn.release();
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
