/**
 * Migration 151: create `message_events` (Delivery Diagnostics epic #4816,
 * Phase 3 WP1).
 *
 * Persists a per-message delivery event timeline — submitted / sent_to_radio /
 * delivered / confirmed / routing_error / timeout / retry — so the Delivery
 * Details popup can render a chronological history that survives restart.
 * Protocol-agnostic: one table serves both Meshtastic (`messages.id`) and
 * MeshCore (`meshcore_messages.id`), keyed by `(sourceId, messageId)` rather
 * than `requestId` since the message id is stable across retries while a
 * requestId rotates per attempt.
 *
 * PER-SOURCE — every row carries a `sourceId`.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. Pure `CREATE ... IF NOT
 * EXISTS` — no backfill; the table starts empty and populates from live
 * send/ack traffic going forward (there is no historical event data to
 * recover for pre-existing messages).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 151';
const TABLE = 'message_events';
const INDEX = 'idx_message_events_source_message';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        eventType TEXT NOT NULL,
        provenance TEXT NOT NULL,
        detail TEXT,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(sourceId, messageId)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration151Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      "eventType" TEXT NOT NULL,
      provenance TEXT NOT NULL,
      detail TEXT,
      "timestamp" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}("sourceId", "messageId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration151Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(36) NOT NULL,
      messageId VARCHAR(64) NOT NULL,
      eventType VARCHAR(24) NOT NULL,
      provenance VARCHAR(12) NOT NULL,
      detail TEXT,
      timestamp BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      INDEX ${INDEX} (sourceId, messageId)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
