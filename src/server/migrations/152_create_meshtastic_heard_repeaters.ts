/**
 * Migration 152: create `meshtastic_heard_repeaters` (Delivery Diagnostics
 * epic #4816, Phase 4 WP1 — Meshtastic Heard-By).
 *
 * Persists repeaters that re-flooded our own outgoing Meshtastic channel
 * packet and were overheard back by us, with the observed SNR — the
 * Meshtastic analog of `meshcore_heard_repeaters` (migration 102). Populated
 * by an ingest hook in `processMeshPacket` (WP2), independent of the opt-in
 * `packet_log_enabled` gate, so the data is available even with packet
 * logging off.
 *
 * `relayByte` is only the LAST BYTE of the relaying node's nodeNum
 * (Meshtastic protobuf `relay_node`), so identity is inherently ambiguous —
 * candidate name resolution happens at query time (WP3), never here.
 *
 * Keyed by `(sourceId, messageId)` where `messageId` is `messages.id`
 * (`${sourceId}_${fromNum}_${packetId}`) — zero-translation join with the
 * rest of the delivery-diagnostics data model.
 *
 * PER-SOURCE — every row carries a `sourceId`. UNIQUE on
 * `(sourceId, messageId, relayByte)` so repeated re-floods of the same
 * packet by the same relayer dedup; SNR is updated to the max observed.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. Pure `CREATE ... IF NOT
 * EXISTS` — no backfill; the table starts empty and populates from live RX
 * traffic going forward.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 152';
const TABLE = 'meshtastic_heard_repeaters';
const UNIQUE_INDEX = 'mthr_source_msg_relay_uniq';
const INDEX = 'mthr_source_msg_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        messageId TEXT NOT NULL,
        relayByte INTEGER NOT NULL,
        snr REAL,
        heardAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(sourceId, messageId, relayByte)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(sourceId, messageId)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration152Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "messageId" TEXT NOT NULL,
      "relayByte" INTEGER NOT NULL,
      snr REAL,
      "heardAt" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("sourceId", "messageId", "relayByte")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}("sourceId", "messageId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration152Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      messageId VARCHAR(96) NOT NULL,
      relayByte INT NOT NULL,
      snr DOUBLE,
      heardAt BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      UNIQUE KEY ${UNIQUE_INDEX} (sourceId, messageId, relayByte),
      INDEX ${INDEX} (sourceId, messageId)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
