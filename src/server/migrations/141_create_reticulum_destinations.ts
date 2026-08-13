/**
 * Migration 141: create `reticulum_destinations` (Reticulum epic #3960, Phase 1a WP1).
 *
 * Row per announced Reticulum destination hash observed by the bridge (see
 * `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md` §3.1). Phase 1a
 * scope = destinations MINUS position/telemetry columns (those land in
 * Phase 3) but INCLUDES the per-packet signal columns (`rssi`/`snr`/
 * `quality`) since they are available in attach mode and are a core
 * Destinations-view column per the attach spec.
 *
 * PER-SOURCE — every row carries a `sourceId`.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql, createIndexIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 141';
const TABLE = 'reticulum_destinations';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        destinationHash TEXT NOT NULL,
        identityHash TEXT,
        appName TEXT,
        aspects TEXT,
        displayName TEXT,
        appDataB64 TEXT,
        hops INTEGER,
        nextHopInterface TEXT,
        rssi INTEGER,
        snr REAL,
        quality INTEGER,
        announceCount INTEGER NOT NULL DEFAULT 0,
        firstSeen INTEGER NOT NULL,
        lastSeen INTEGER NOT NULL,
        lastAnnounceAt INTEGER,
        isFavorite INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS reticulum_destinations_source_hash_idx
      ON ${TABLE}(sourceId, destinationHash)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS reticulum_destinations_source_lastseen_idx
      ON ${TABLE}(sourceId, lastSeen)
    `);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration141Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "destinationHash" TEXT NOT NULL,
      "identityHash" TEXT,
      "appName" TEXT,
      aspects TEXT,
      "displayName" TEXT,
      "appDataB64" TEXT,
      hops INTEGER,
      "nextHopInterface" TEXT,
      rssi INTEGER,
      snr DOUBLE PRECISION,
      quality INTEGER,
      "announceCount" INTEGER NOT NULL DEFAULT 0,
      "firstSeen" BIGINT NOT NULL,
      "lastSeen" BIGINT NOT NULL,
      "lastAnnounceAt" BIGINT,
      "isFavorite" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS reticulum_destinations_source_hash_idx
    ON ${TABLE}("sourceId", "destinationHash")
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS reticulum_destinations_source_lastseen_idx
    ON ${TABLE}("sourceId", "lastSeen")
  `);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration141Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(191) NOT NULL,
      destinationHash VARCHAR(64) NOT NULL,
      identityHash VARCHAR(64),
      appName VARCHAR(255),
      aspects VARCHAR(255),
      displayName VARCHAR(255),
      appDataB64 TEXT,
      hops INT,
      nextHopInterface VARCHAR(255),
      rssi INT,
      snr DOUBLE,
      quality INT,
      announceCount INT NOT NULL DEFAULT 0,
      firstSeen BIGINT NOT NULL,
      lastSeen BIGINT NOT NULL,
      lastAnnounceAt BIGINT,
      isFavorite TINYINT(1) NOT NULL DEFAULT 0,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY reticulum_destinations_source_hash_idx (sourceId, destinationHash)
    )
  `);
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    'reticulum_destinations_source_lastseen_idx',
    `CREATE INDEX reticulum_destinations_source_lastseen_idx ON ${TABLE}(sourceId, lastSeen)`,
  );

  logger.info(`${LABEL} complete (MySQL)`);
}
