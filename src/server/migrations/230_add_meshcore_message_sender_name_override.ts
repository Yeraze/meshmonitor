/**
 * Migration 230: `meshcore_messages.senderNameOverride` (#6282).
 *
 *   senderNameOverride TEXT NULL - the sender name an API caller asked this
 *   own channel send to go out under (instead of the node's real name).
 *
 * Set only on rows MeshMonitor sent as a raw `CMD_SEND_RAW_PACKET` under an
 * allowlisted override name. The resend path reads it: a row with an override
 * is rebuilt as a raw packet and never re-sent under the real node name. NULL
 * for every other row (received, normal sends, rows from before this
 * migration). Per-source like the rest of `meshcore_messages`. Additive and
 * idempotent on all three backends via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 230';
const TABLE = 'meshcore_messages';
const COLUMN = 'senderNameOverride';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, 'senderNameOverride TEXT');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration230Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, '"senderNameOverride" TEXT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration230Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, 'senderNameOverride TEXT NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
