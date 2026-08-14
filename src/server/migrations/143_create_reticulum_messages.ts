/**
 * Migration 143: create `reticulum_messages` (Reticulum epic #3960, Phase 2 WP2).
 *
 * Row per LXMF message (inbound or outbound) observed/sent by the bridge. See
 * `docs/internal/dev-notes/RETICULUM_PHASE2_BUILD_SPEC.md` §4.
 *
 * `id` is the composite key `${sourceId}_${lxmHashHex}` (keeps the
 * `sourceId_` prefix for cross-source dedup — see the message row-id
 * convention used by `messages.id` / MeshCore's per-source ids).
 *
 * PER-SOURCE — every row carries a `sourceId`.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql, createIndexIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 143';
const TABLE = 'reticulum_messages';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        fromHash TEXT NOT NULL,
        toHash TEXT NOT NULL,
        title TEXT,
        content TEXT,
        timestamp INTEGER NOT NULL,
        receivedAt INTEGER,
        createdAt INTEGER NOT NULL,
        state TEXT NOT NULL,
        method TEXT,
        signatureValidated INTEGER NOT NULL DEFAULT 0,
        ratcheted INTEGER NOT NULL DEFAULT 0,
        fields TEXT,
        replyToHash TEXT,
        threadHash TEXT,
        rssi INTEGER,
        snr REAL,
        quality INTEGER
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS reticulum_messages_source_to_from_ts_idx
      ON ${TABLE}(sourceId, toHash, fromHash, timestamp)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS reticulum_messages_source_thread_idx
      ON ${TABLE}(sourceId, threadHash)
    `);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration143Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "fromHash" TEXT NOT NULL,
      "toHash" TEXT NOT NULL,
      title TEXT,
      content TEXT,
      "timestamp" BIGINT NOT NULL,
      "receivedAt" BIGINT,
      "createdAt" BIGINT NOT NULL,
      state TEXT NOT NULL,
      method TEXT,
      "signatureValidated" BOOLEAN NOT NULL DEFAULT false,
      ratcheted BOOLEAN NOT NULL DEFAULT false,
      fields TEXT,
      "replyToHash" TEXT,
      "threadHash" TEXT,
      rssi INTEGER,
      snr DOUBLE PRECISION,
      quality INTEGER
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS reticulum_messages_source_to_from_ts_idx
    ON ${TABLE}("sourceId", "toHash", "fromHash", "timestamp")
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS reticulum_messages_source_thread_idx
    ON ${TABLE}("sourceId", "threadHash")
  `);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration143Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id VARCHAR(191) PRIMARY KEY,
      sourceId VARCHAR(191) NOT NULL,
      fromHash VARCHAR(64) NOT NULL,
      toHash VARCHAR(64) NOT NULL,
      title TEXT,
      content TEXT,
      timestamp BIGINT NOT NULL,
      receivedAt BIGINT,
      createdAt BIGINT NOT NULL,
      state VARCHAR(16) NOT NULL,
      method VARCHAR(16),
      signatureValidated TINYINT(1) NOT NULL DEFAULT 0,
      ratcheted TINYINT(1) NOT NULL DEFAULT 0,
      fields TEXT,
      replyToHash TEXT,
      threadHash VARCHAR(64),
      rssi INT,
      snr DOUBLE,
      quality INT
    )
  `);
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    'reticulum_messages_source_to_from_ts_idx',
    `CREATE INDEX reticulum_messages_source_to_from_ts_idx ON ${TABLE}(sourceId, toHash, fromHash, timestamp)`,
  );
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    'reticulum_messages_source_thread_idx',
    `CREATE INDEX reticulum_messages_source_thread_idx ON ${TABLE}(sourceId, threadHash)`,
  );

  logger.info(`${LABEL} complete (MySQL)`);
}
