/**
 * Migration 203: reaction columns on `meshcore_messages` (#5759).
 *
 *   mc1Hash              MC1 reaction hash of this message (ordinary rows)
 *   reactionEmoji        non-NULL = this row is a reaction; `text` = the emoji
 *   reactionFormat       mc1-channel | mc1-channel-legacy | mc1-dm | mco-v3 | mco-v1
 *   reactionTargetHash   hash the reaction names (MC1/v3) or String(timestampMs) (v1)
 *   reactionTargetSender verbatim text between `@[` and `]` (MC1 channel)
 *   reactionTargetId     id of the target row on the same source; NULL = unmatched
 *   reactionRawText      the body as received
 *
 * All nullable, no default, no backfill: old rows keep NULL and are covered by
 * a bounded lookup-time scan. Plus one index on (sourceId, mc1Hash) so a
 * reaction finds its target without scanning the source. Pure additive and
 * idempotent via the shared helpers on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createIndexIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 203';
const TABLE = 'meshcore_messages';
const INDEX = 'idx_meshcore_messages_mc1hash';

/** [column, MySQL type]. SQLite and PostgreSQL use TEXT for all of them. */
const COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['mc1Hash', 'VARCHAR(8)'],
  ['reactionEmoji', 'VARCHAR(64)'],
  ['reactionFormat', 'VARCHAR(24)'],
  ['reactionTargetHash', 'VARCHAR(64)'],
  ['reactionTargetSender', 'TEXT'],
  ['reactionTargetId', 'VARCHAR(64)'],
  ['reactionRawText', 'TEXT'],
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding reaction columns to ${TABLE}...`);
    for (const [col] of COLUMNS) {
      addColumnIfMissing(db, TABLE, col, `${col} TEXT`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(sourceId, mc1Hash)`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration203Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding reaction columns to ${TABLE}...`);
  for (const [col] of COLUMNS) {
    await addColumnIfMissingPostgres(client, TABLE, col, `"${col}" TEXT`);
  }
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}("sourceId", "mc1Hash")`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration203Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding reaction columns to ${TABLE}...`);
  for (const [col, type] of COLUMNS) {
    await addColumnIfMissingMysql(pool, TABLE, col, `${col} ${type} NULL`);
  }
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    INDEX,
    `CREATE INDEX ${INDEX} ON ${TABLE}(sourceId, mc1Hash)`,
  );
  logger.info(`${LABEL} complete (MySQL)`);
}
