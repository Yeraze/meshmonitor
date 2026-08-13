/**
 * Migration 142: create `reticulum_interfaces` (Reticulum epic #3960, Phase 1a WP1).
 *
 * Row per RNS interface reported by the bridge (current snapshot / inventory —
 * the `rnstatus` view; see
 * `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md` §3.1). Phase 1a
 * scope = interfaces MINUS LoRa-parameter columns (frequency/bandwidth/SF/
 * CR/txPower/airtime → Phase 3 own-mode radio config).
 *
 * PER-SOURCE — every row carries a `sourceId`.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 142';
const TABLE = 'reticulum_interfaces';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        interfaceName TEXT NOT NULL,
        interfaceType TEXT,
        interfaceHash TEXT,
        mode TEXT,
        status TEXT NOT NULL,
        online INTEGER NOT NULL DEFAULT 0,
        bitrate INTEGER,
        txBytes INTEGER NOT NULL DEFAULT 0,
        rxBytes INTEGER NOT NULL DEFAULT 0,
        lastSeenAt INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS reticulum_interfaces_source_name_idx
      ON ${TABLE}(sourceId, interfaceName)
    `);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration142Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "interfaceName" TEXT NOT NULL,
      "interfaceType" TEXT,
      "interfaceHash" TEXT,
      mode TEXT,
      status TEXT NOT NULL,
      online BOOLEAN NOT NULL DEFAULT false,
      bitrate INTEGER,
      "txBytes" BIGINT NOT NULL DEFAULT 0,
      "rxBytes" BIGINT NOT NULL DEFAULT 0,
      "lastSeenAt" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS reticulum_interfaces_source_name_idx
    ON ${TABLE}("sourceId", "interfaceName")
  `);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration142Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(191) NOT NULL,
      interfaceName VARCHAR(255) NOT NULL,
      interfaceType VARCHAR(128),
      interfaceHash VARCHAR(64),
      mode VARCHAR(64),
      status VARCHAR(16) NOT NULL,
      online TINYINT(1) NOT NULL DEFAULT 0,
      bitrate INT,
      txBytes BIGINT NOT NULL DEFAULT 0,
      rxBytes BIGINT NOT NULL DEFAULT 0,
      lastSeenAt BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY reticulum_interfaces_source_name_idx (sourceId, interfaceName)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
