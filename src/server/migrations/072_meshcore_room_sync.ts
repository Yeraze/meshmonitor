/**
 * Migration 072: Room server sync and credential columns on `meshcore_nodes`.
 *
 * Adds five columns to support room server participation features:
 *   - `roomSyncEnabled`          — whether periodic room sync is active
 *   - `roomSyncIntervalMinutes`  — polling interval (minimum 60 min)
 *   - `lastRoomSyncAt`           — timestamp of last successful sync
 *   - `lastRoomPostAt`           — timestamp of newest received room post
 *   - `roomCredential`           — encrypted room password (same envelope as adminCredential)
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 072';
const TABLE = 'meshcore_nodes';
const COLUMNS = [
  { name: 'roomSyncEnabled', sqliteDef: 'INTEGER DEFAULT 0', pgDef: 'BOOLEAN DEFAULT FALSE', mysqlDef: 'TINYINT(1) DEFAULT 0' },
  { name: 'roomSyncIntervalMinutes', sqliteDef: 'INTEGER DEFAULT 60', pgDef: 'INTEGER DEFAULT 60', mysqlDef: 'INT DEFAULT 60' },
  { name: 'lastRoomSyncAt', sqliteDef: 'INTEGER', pgDef: 'BIGINT', mysqlDef: 'BIGINT' },
  { name: 'lastRoomPostAt', sqliteDef: 'INTEGER', pgDef: 'BIGINT', mysqlDef: 'BIGINT' },
  { name: 'roomCredential', sqliteDef: 'TEXT', pgDef: 'TEXT', mysqlDef: 'VARCHAR(1024)' },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding room sync columns to ${TABLE}...`);
    for (const col of COLUMNS) {
      try {
         
        db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${col.name} ${col.sqliteDef}`);
        logger.debug(`${LABEL} (SQLite): added ${TABLE}.${col.name}`);
      } catch (e: any) {
        if (e.message?.includes('duplicate column')) {
          logger.debug(`${LABEL} (SQLite): ${TABLE}.${col.name} already present, skipping`);
        } else {
          logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${col.name}:`, e.message);
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

export async function runMigration072Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding room sync columns to ${TABLE}...`);
  for (const col of COLUMNS) {
    await client.query(
      `ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${col.name}" ${col.pgDef}`,
    );
  }
}

// ============ MySQL ============

export async function runMigration072Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding room sync columns to ${TABLE}...`);
  const conn = await pool.getConnection();
  try {
    for (const col of COLUMNS) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, col.name],
      );
      if (Array.isArray(rows) && rows.length === 0) {
        await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${col.name} ${col.mysqlDef}`);
        logger.debug(`${LABEL} (MySQL): added ${TABLE}.${col.name}`);
      } else {
        logger.debug(`${LABEL} (MySQL): ${TABLE}.${col.name} already present, skipping`);
      }
    }
  } finally {
    conn.release();
  }
}
