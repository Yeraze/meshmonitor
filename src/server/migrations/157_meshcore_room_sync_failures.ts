/**
 * Migration 157: Room-sync failure tracking on `meshcore_nodes`.
 *
 * Fixes the "bad saved password hammers the mesh forever" bug. The room-sync
 * scheduler only wrote `lastRoomSyncAt` after a SUCCESSFUL login, so a room
 * whose saved password no longer works never advanced its clock: it stayed
 * the most-overdue room and was retried on every 60s tick, for ever. Each
 * retry is up to three `login` sends, and a login floods when the path is
 * unknown, so one wrong password cost roughly 180 login floods an hour and
 * filled the room operator's logs with rejected-login noise.
 *
 *   roomSyncFailureCount  INTEGER  (0 default; consecutive failed syncs)
 *   roomSyncLastError     TEXT     (null, or 'rejected' / 'no_reply')
 *
 * Both live in the DATABASE rather than on the scheduler instance for the
 * usual reason (CLAUDE.md, "Does a save reset a safety timer?"): an in-memory
 * counter is cleared by every restart, so a container that restarts hourly
 * would never reach the auto-disable threshold and the flood would continue
 * across reboots.
 *
 * `roomSyncLastError` is a short machine token, never a message and never
 * anything derived from the password — it is surfaced verbatim in the Rooms
 * UI to explain why auto-sync switched itself off.
 *
 * No backfill: existing rows start at 0 failures, which is exactly the state
 * a never-yet-failed room should be in.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 157';

interface ColumnSpec {
  name: string;
  sqliteType: string;
  postgresType: string;
  mysqlType: string;
}

const COLUMNS: ColumnSpec[] = [
  {
    name: 'roomSyncFailureCount',
    sqliteType: 'INTEGER DEFAULT 0',
    postgresType: 'INTEGER DEFAULT 0',
    mysqlType: 'INT DEFAULT 0',
  },
  {
    name: 'roomSyncLastError',
    sqliteType: 'TEXT',
    postgresType: 'TEXT',
    mysqlType: 'VARCHAR(32)',
  },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding room-sync failure columns to meshcore_nodes...`);

    for (const col of COLUMNS) {
      try {
        db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN ${col.name} ${col.sqliteType}`);
        logger.debug(`${LABEL} (SQLite): added meshcore_nodes.${col.name}`);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (message.includes('duplicate column')) {
          logger.debug(`${LABEL} (SQLite): meshcore_nodes.${col.name} already exists, skipping`);
        } else {
          logger.error(`${LABEL} (SQLite): could not add meshcore_nodes.${col.name}:`, message);
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

export async function runMigration157Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding room-sync failure columns...`);

  for (const col of COLUMNS) {
    await client.query(
      `ALTER TABLE meshcore_nodes ADD COLUMN IF NOT EXISTS "${col.name}" ${col.postgresType}`,
    );
    logger.debug(`${LABEL} (PostgreSQL): ensured meshcore_nodes.${col.name}`);
  }
}

// ============ MySQL ============

export async function runMigration157Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding room-sync failure columns...`);

  const conn = await pool.getConnection();
  try {
    for (const col of COLUMNS) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes' AND COLUMN_NAME = ?`,
        [col.name],
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        await conn.query(`ALTER TABLE meshcore_nodes ADD COLUMN ${col.name} ${col.mysqlType}`);
        logger.debug(`${LABEL} (MySQL): added meshcore_nodes.${col.name}`);
      } else {
        logger.debug(`${LABEL} (MySQL): meshcore_nodes.${col.name} already exists, skipping`);
      }
    }
  } finally {
    conn.release();
  }
}
