/**
 * Migration 186: `meshcore_messages.senderTimestamp` (#5512).
 *
 *   senderTimestamp INTEGER/BIGINT NULL — wire `sender_timestamp` (epoch
 *   SECONDS) our own outgoing channel send was stamped with.
 *
 * MeshCore repeaters dedupe a flood by payload hash, and a GRP_TXT payload is
 * `timestamp + "name: text"`. A user-initiated resend must reuse the ORIGINAL
 * timestamp, so repeaters that already relayed it drop the resend and ones that
 * missed it carry it. Storing it on the row lets that resend survive a restart.
 *
 * Nullable: rows written before this migration (and every received message)
 * stay NULL, which the resend path reads as "can't resend". Per-source like the
 * rest of `meshcore_messages`. Pure additive, idempotent `ADD COLUMN` on all
 * three backends via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 186';
const TABLE = 'meshcore_messages';
const COLUMN = 'senderTimestamp';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${COLUMN} to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, COLUMN, 'senderTimestamp INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration186Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, '"senderTimestamp" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration186Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${COLUMN} to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, 'senderTimestamp BIGINT NULL');
  logger.info(`${LABEL} complete (MySQL)`);
}
