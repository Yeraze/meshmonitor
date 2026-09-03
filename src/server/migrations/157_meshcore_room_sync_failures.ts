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
 * Idempotent across SQLite / PostgreSQL / MySQL via the shared helpers in
 * `./helpers.js` (CLAUDE.md migration recipe).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingMysql,
  addColumnIfMissingPostgres,
} from './helpers.js';

const LABEL = 'Migration 157';

/**
 * The shared helpers take the FULL column definition, name included — and
 * PostgreSQL's wants the name quoted, since these are camelCase. Passing only
 * the type produces `ADD COLUMN INTEGER DEFAULT 0`, which fails in a way the
 * "duplicate column" guard does not recognise.
 */
interface ColumnSpec {
  name: string;
  sqliteDdl: string;
  postgresDdl: string;
  mysqlDdl: string;
}

const COLUMNS: ColumnSpec[] = [
  {
    name: 'roomSyncFailureCount',
    sqliteDdl: 'roomSyncFailureCount INTEGER DEFAULT 0',
    postgresDdl: '"roomSyncFailureCount" INTEGER DEFAULT 0',
    mysqlDdl: 'roomSyncFailureCount INT DEFAULT 0',
  },
  {
    name: 'roomSyncLastError',
    sqliteDdl: 'roomSyncLastError TEXT',
    postgresDdl: '"roomSyncLastError" TEXT',
    mysqlDdl: 'roomSyncLastError VARCHAR(32)',
  },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding room-sync failure columns to meshcore_nodes...`);

    for (const col of COLUMNS) {
      addColumnIfMissing(db, 'meshcore_nodes', col.name, col.sqliteDdl);
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
    await addColumnIfMissingPostgres(client, 'meshcore_nodes', col.name, col.postgresDdl);
  }
}

// ============ MySQL ============

export async function runMigration157Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding room-sync failure columns...`);

  for (const col of COLUMNS) {
    await addColumnIfMissingMysql(pool, 'meshcore_nodes', col.name, col.mysqlDdl);
  }
}
