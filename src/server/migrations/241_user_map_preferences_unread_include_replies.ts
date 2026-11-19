/**
 * Migration 241: `user_map_preferences.unread_include_replies` (#5254).
 *
 * Opt-in for the per-source unread badge (#5161) to also count unread channel
 * replies and tapbacks aimed at messages the source's own node sent.
 *
 *   unread_include_replies  BOOLEAN  DEFAULT FALSE
 *
 * Off by default, as the issue asks: it widens what the badge counts, and a
 * busy channel would otherwise light badges that used to mean "unread DM".
 *
 * Plus `idx_messages_source_reply ON messages(sourceId, replyId)`, so the
 * reply scan reads only rows that are replies (34 ms -> 13 ms per source on a
 * 100k-row source, SQLite). No new `messages` column: the parent of a counted
 * reply was sent by this source's own node, so its primary key is
 * `${sourceId}_${localNodeNum}_${replyId}` and the query looks it up directly
 * — no `packetId` column or backfill.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createIndexIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 241';
const TABLE = 'user_map_preferences';
const COLUMN = 'unread_include_replies';
const INDEX = 'idx_messages_source_reply';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON messages(sourceId, replyId)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration241Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN DEFAULT FALSE`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON messages("sourceId", "replyId")`);
}

// ============ MySQL ============

export async function runMigration241Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} BOOLEAN DEFAULT FALSE`);
  await createIndexIfMissingMysql(pool, 'messages', INDEX, `CREATE INDEX ${INDEX} ON messages(sourceId, replyId)`);
}
