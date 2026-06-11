/**
 * Migration 085: Track the routing ACK result of each remote favorite command
 * (issue #2608 follow-up). Adds lastAckStatus + lastAckAt to
 * auto_favorite_assignments so the UI can show whether a favorite was confirmed
 * by the remote node, rejected, or timed out.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 085';
const TABLE = 'auto_favorite_assignments';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ack columns to ${TABLE}...`);
    const addColumn = (ddl: string) => {
      try {
        db.exec(ddl);
      } catch (error) {
        // Ignore "duplicate column name" so the migration is idempotent.
        if (!String(error).includes('duplicate column')) throw error;
      }
    };
    addColumn(`ALTER TABLE ${TABLE} ADD COLUMN lastAckStatus TEXT`);
    addColumn(`ALTER TABLE ${TABLE} ADD COLUMN lastAckAt INTEGER`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ack columns from ${TABLE}`);
    try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN lastAckStatus`); } catch { /* older SQLite lacks DROP COLUMN */ }
    try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN lastAckAt`); } catch { /* older SQLite lacks DROP COLUMN */ }
  },
};

// ============ PostgreSQL ============

export async function runMigration085Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ack columns to ${TABLE}...`);
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "lastAckStatus" TEXT`);
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "lastAckAt" BIGINT`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration085Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ack columns to ${TABLE}...`);
  const conn = await pool.getConnection();
  try {
    const columnExists = async (column: string): Promise<boolean> => {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, column],
      );
      return (rows as any[]).length > 0;
    };
    if (!(await columnExists('lastAckStatus'))) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN lastAckStatus VARCHAR(32)`);
    }
    if (!(await columnExists('lastAckAt'))) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN lastAckAt BIGINT`);
    }
  } finally {
    conn.release();
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
