/**
 * Migration 201: create `meshcore_hop_snr` (issue #5722).
 *
 * Per-hop SNR from MeshCore TRACE packets a source's companion radio heard:
 * one row per hop, receiver-heard-sender. PER-SOURCE — every row carries a
 * `sourceId`.
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill — the table starts empty and
 * fills from live traces.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 201';
const TABLE = 'meshcore_hop_snr';
const LINK_INDEX = 'meshcore_hop_snr_link_idx';
const TIME_INDEX = 'meshcore_hop_snr_time_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        traceTag INTEGER NOT NULL,
        authCode INTEGER NOT NULL,
        hopIndex INTEGER NOT NULL,
        hopCount INTEGER NOT NULL,
        hashBytes INTEGER NOT NULL,
        senderPublicKey TEXT,
        senderHash TEXT,
        senderCandidates INTEGER NOT NULL,
        receiverPublicKey TEXT,
        receiverHash TEXT,
        receiverCandidates INTEGER NOT NULL,
        snrQuarterDb INTEGER NOT NULL,
        initiated INTEGER NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${LINK_INDEX} ON ${TABLE}(sourceId, receiverPublicKey, senderPublicKey, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${TIME_INDEX} ON ${TABLE}(sourceId, timestamp)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration201Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "traceTag" BIGINT NOT NULL,
      "authCode" BIGINT NOT NULL,
      "hopIndex" INTEGER NOT NULL,
      "hopCount" INTEGER NOT NULL,
      "hashBytes" INTEGER NOT NULL,
      "senderPublicKey" TEXT,
      "senderHash" TEXT,
      "senderCandidates" INTEGER NOT NULL,
      "receiverPublicKey" TEXT,
      "receiverHash" TEXT,
      "receiverCandidates" INTEGER NOT NULL,
      "snrQuarterDb" INTEGER NOT NULL,
      initiated BOOLEAN NOT NULL,
      "timestamp" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${LINK_INDEX} ON ${TABLE}("sourceId", "receiverPublicKey", "senderPublicKey", "timestamp")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${TIME_INDEX} ON ${TABLE}("sourceId", "timestamp")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration201Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      traceTag BIGINT NOT NULL,
      authCode BIGINT NOT NULL,
      hopIndex INT NOT NULL,
      hopCount INT NOT NULL,
      hashBytes INT NOT NULL,
      senderPublicKey VARCHAR(64),
      senderHash VARCHAR(8),
      senderCandidates INT NOT NULL,
      receiverPublicKey VARCHAR(64),
      receiverHash VARCHAR(8),
      receiverCandidates INT NOT NULL,
      snrQuarterDb INT NOT NULL,
      initiated BOOLEAN NOT NULL,
      \`timestamp\` BIGINT NOT NULL,
      INDEX ${LINK_INDEX} (sourceId, receiverPublicKey, senderPublicKey, \`timestamp\`),
      INDEX ${TIME_INDEX} (sourceId, \`timestamp\`)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
