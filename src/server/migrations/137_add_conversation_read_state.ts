/**
 * Migration 137: Create `conversation_read_state` (issue #4607).
 *
 * A durable, per-user "last read" watermark per (source, conversation). It is
 * what the unread divider and the jump-to-first-unread entry scroll anchor on
 * for MeshCore, whose messages were never covered by Meshtastic's per-message
 * `read_messages` table and were previously tracked only in browser
 * localStorage — per-browser rather than per-user.
 *
 * `userId` is a plain INTEGER with `0` standing in for the anonymous operator
 * rather than a nullable FK: the UNIQUE index is the upsert's conflict target,
 * and SQLite/PostgreSQL both treat NULLs as distinct, so a nullable column
 * would append a fresh row on every write instead of updating one.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 137';
const TABLE = 'conversation_read_state';
const UNIQUE_INDEX = 'idx_conversation_read_state_unique';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        conversation_kind TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        last_read_at INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX}
        ON ${TABLE} (user_id, source_id, conversation_kind, conversation_key)
    `);
    logger.debug(`${LABEL} (SQLite): ${TABLE} ready`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (table drops are destructive)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the 136 migration-file convention (pg Client)
export async function runMigration137Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "id" SERIAL PRIMARY KEY,
      "userId" INTEGER NOT NULL,
      "sourceId" TEXT NOT NULL,
      "conversationKind" TEXT NOT NULL,
      "conversationKey" TEXT NOT NULL,
      "lastReadAt" BIGINT NOT NULL
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX}
      ON ${TABLE} ("userId", "sourceId", "conversationKind", "conversationKey")
  `);
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the 136 migration-file convention (mysql2 Pool)
export async function runMigration137Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  // MySQL has no CREATE INDEX IF NOT EXISTS, so the unique key is declared
  // inline in the CREATE TABLE (per the helpers.ts guidance).
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      userId INT NOT NULL,
      sourceId VARCHAR(64) NOT NULL,
      conversationKind VARCHAR(32) NOT NULL,
      conversationKey VARCHAR(128) NOT NULL,
      lastReadAt BIGINT NOT NULL,
      UNIQUE KEY ${UNIQUE_INDEX} (userId, sourceId, conversationKind, conversationKey)
    )
  `);
}
