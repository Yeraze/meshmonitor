/**
 * Migration 172: create `coverage_receptions` (Coverage Report epic #5277,
 * Phase 1 WP1).
 *
 * One row per (packet, path, receiver) RF reception, recorded from the live
 * Meshtastic RX path (P1) — WP2's `maybeRecordCoverageReception` hook. No
 * backfill; the table starts empty and populates going forward only.
 * PER-SOURCE — every row carries a `sourceId`.
 *
 * Every unique-key column is NOT NULL (`sourceId`, `receiverId`, `senderId`,
 * `packetKey`, `pathKey`) because all three backends treat NULL as distinct
 * in a UNIQUE index, which would silently defeat the dedupe.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. See
 * `docs/internal/dev-notes/COVERAGE_P1_SPEC.md` §2.1/§2.2 for the full column
 * table and index rationale.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 172';
const TABLE = 'coverage_receptions';
const UNIQUE_INDEX = 'cov_rx_path_uniq';
const RECEIVED_INDEX = 'cov_rx_received_idx';
const SOURCE_RECEIVED_INDEX = 'cov_rx_source_received_idx';
const SENDER_RECEIVED_INDEX = 'cov_rx_sender_received_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        protocol TEXT NOT NULL,
        receiverKind TEXT NOT NULL,
        receiverId TEXT NOT NULL,
        receiverNodeNum INTEGER,
        receiverLatitude REAL,
        receiverLongitude REAL,
        senderId TEXT NOT NULL,
        senderNodeNum INTEGER,
        packetKey TEXT NOT NULL,
        packetId INTEGER,
        pathKey TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude REAL,
        precisionBits INTEGER,
        snr REAL,
        rssi INTEGER,
        hopStart INTEGER,
        hopLimit INTEGER,
        hopsAway INTEGER,
        relayNode INTEGER,
        transportMechanism INTEGER,
        channel INTEGER,
        rxTime INTEGER,
        receivedAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}(sourceId, receiverId, senderId, packetKey, pathKey)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${RECEIVED_INDEX} ON ${TABLE}(receivedAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${SOURCE_RECEIVED_INDEX} ON ${TABLE}(sourceId, receivedAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${SENDER_RECEIVED_INDEX} ON ${TABLE}(senderId, receivedAt)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration172Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      protocol TEXT NOT NULL,
      "receiverKind" TEXT NOT NULL,
      "receiverId" TEXT NOT NULL,
      "receiverNodeNum" BIGINT,
      "receiverLatitude" DOUBLE PRECISION,
      "receiverLongitude" DOUBLE PRECISION,
      "senderId" TEXT NOT NULL,
      "senderNodeNum" BIGINT,
      "packetKey" TEXT NOT NULL,
      "packetId" BIGINT,
      "pathKey" TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      altitude REAL,
      "precisionBits" INTEGER,
      snr REAL,
      rssi INTEGER,
      "hopStart" INTEGER,
      "hopLimit" INTEGER,
      "hopsAway" INTEGER,
      "relayNode" INTEGER,
      "transportMechanism" INTEGER,
      channel INTEGER,
      "rxTime" BIGINT,
      "receivedAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${UNIQUE_INDEX} ON ${TABLE}("sourceId", "receiverId", "senderId", "packetKey", "pathKey")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${RECEIVED_INDEX} ON ${TABLE}("receivedAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${SOURCE_RECEIVED_INDEX} ON ${TABLE}("sourceId", "receivedAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${SENDER_RECEIVED_INDEX} ON ${TABLE}("senderId", "receivedAt")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration172Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      protocol VARCHAR(16) NOT NULL,
      receiverKind VARCHAR(16) NOT NULL,
      receiverId VARCHAR(80) NOT NULL,
      receiverNodeNum BIGINT,
      receiverLatitude DOUBLE,
      receiverLongitude DOUBLE,
      senderId VARCHAR(80) NOT NULL,
      senderNodeNum BIGINT,
      packetKey VARCHAR(80) NOT NULL,
      packetId BIGINT,
      pathKey VARCHAR(32) NOT NULL,
      latitude DOUBLE NOT NULL,
      longitude DOUBLE NOT NULL,
      altitude DOUBLE,
      precisionBits INT,
      snr DOUBLE,
      rssi INT,
      hopStart INT,
      hopLimit INT,
      hopsAway INT,
      relayNode INT,
      transportMechanism INT,
      channel INT,
      rxTime BIGINT,
      receivedAt BIGINT NOT NULL,
      UNIQUE KEY ${UNIQUE_INDEX} (sourceId, receiverId, senderId, packetKey, pathKey),
      INDEX ${RECEIVED_INDEX} (receivedAt),
      INDEX ${SOURCE_RECEIVED_INDEX} (sourceId, receivedAt),
      INDEX ${SENDER_RECEIVED_INDEX} (senderId, receivedAt)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
