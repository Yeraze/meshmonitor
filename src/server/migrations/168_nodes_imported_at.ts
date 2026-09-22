/**
 * Migration 168: `nodes.importedAt` (issue #5317).
 *
 * Records when a node row was created by importing a Meshtastic contact URL
 * (`https://meshtastic.org/v/#...`) rather than by hearing the node on the
 * mesh. The UI badges such a row until the node is actually heard, so an
 * imported contact is never mistaken for a real node whose data has gone
 * stale — an imported row has no `lastHeard` at all, which otherwise looks
 * identical to a node that simply has not reported recently.
 *
 * Milliseconds, matching `createdAt` (see nodes.createdAt — ms, while
 * `lastHeard` is seconds).
 *
 * NULL for every existing row, which reads as "not imported" — today's
 * behaviour for everything already in the table, so no backfill.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL (CLAUDE.md migration recipe).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 168';
const TABLE = 'nodes';
const COLUMN = 'importedAt';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (dropping the column loses import provenance)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration168Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BIGINT`);
}

// ============ MySQL ============

export async function runMigration168Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `\`${COLUMN}\` BIGINT`);
}
