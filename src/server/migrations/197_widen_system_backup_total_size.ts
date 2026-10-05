/**
 * Migration 197: widen `system_backup_history.totalSize` to 64 bits on
 * PostgreSQL and MySQL.
 *
 * The column records a backup's size in bytes. It was a 32-bit INTEGER, which
 * tops out at 2,147,483,647 — just under 2 GiB. A system backup now holds
 * every table and is written as a stream, so a backup of that size can be
 * made; recording it then failed with "integer out of range" and the backup
 * was lost after all the work of writing it.
 *
 * GLOBAL table (one row per backup; no sourceId).
 *
 *   SQLite      nothing to do: INTEGER is already 64-bit.
 *   PostgreSQL  ALTER COLUMN "totalSize" TYPE BIGINT
 *   MySQL       MODIFY totalSize BIGINT NULL
 *
 * Idempotent: each backend checks the column's current type first and does
 * nothing when it is already BIGINT. Widening keeps every existing value.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 197';
const TABLE = 'system_backup_history';
const COLUMN = 'totalSize';

// ============ SQLite ============

export const migration = {
  up: (_db: Database): void => {
    logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} is already 64-bit, nothing to do`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented`);
  },
};

// ============ PostgreSQL ============

export async function runMigration197Postgres(client: import('pg').PoolClient): Promise<void> {
  const current = await client.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [TABLE, COLUMN],
  );
  const type = current.rows[0]?.data_type as string | undefined;
  if (type === undefined) {
    logger.debug(`${LABEL} (PostgreSQL): ${TABLE}.${COLUMN} not present, nothing to do`);
    return;
  }
  if (type === 'bigint') {
    logger.debug(`${LABEL} (PostgreSQL): ${TABLE}.${COLUMN} is already BIGINT`);
    return;
  }
  logger.info(`${LABEL} (PostgreSQL): widening ${TABLE}.${COLUMN} to BIGINT...`);
  await client.query(`ALTER TABLE ${TABLE} ALTER COLUMN "${COLUMN}" TYPE BIGINT`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration197Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  const [rows] = await pool.query(
    `SELECT DATA_TYPE AS dataType FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [TABLE, COLUMN],
  );
  const type = (rows as Array<{ dataType: string }>)[0]?.dataType;
  if (type === undefined) {
    logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} not present, nothing to do`);
    return;
  }
  if (type.toLowerCase() === 'bigint') {
    logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} is already BIGINT`);
    return;
  }
  logger.info(`${LABEL} (MySQL): widening ${TABLE}.${COLUMN} to BIGINT...`);
  await pool.query(`ALTER TABLE ${TABLE} MODIFY ${COLUMN} BIGINT NULL`);
  logger.info(`${LABEL} complete (MySQL)`);
}
