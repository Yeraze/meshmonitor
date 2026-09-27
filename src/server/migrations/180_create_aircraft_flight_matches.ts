/**
 * Migration 180: create `aircraft_flight_matches` (ADS-B flight matching,
 * #5374, ADSB_MATCH_SPEC.md "Data").
 *
 * One row per (source, node): the current likely-aircraft "flagging" and the
 * ADS-B lookups spent on it. The row is the lookup cap — at most 2 lookups per
 * flagging — so it lives in the database, where a restart or a settings save
 * cannot reset it.
 *
 * PER-SOURCE. PK (sourceId, nodeNum); FK to sources(id) ON DELETE CASCADE so a
 * deleted source takes its rows with it. nodeNum is BIGINT on PG/MySQL
 * (unsigned 32-bit). Timestamps are epoch ms (BIGINT on PG/MySQL).
 *
 * No backfill: the table starts empty. Idempotent on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 180';
const TABLE = 'aircraft_flight_matches';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sourceId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        episodeStartedAt INTEGER NOT NULL,
        lookups INTEGER NOT NULL DEFAULT 0,
        firstLookupAt INTEGER,
        status TEXT NOT NULL DEFAULT 'none',
        feed TEXT,
        hex TEXT,
        callsign TEXT,
        aircraftType TEXT,
        registration TEXT,
        gsKt REAL,
        trackDeg REAL,
        altM REAL,
        distanceKm REAL,
        matchedAt INTEGER,
        PRIMARY KEY (sourceId, nodeNum),
        FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
      )
    `);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration180Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "sourceId" TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      "nodeNum" BIGINT NOT NULL,
      "episodeStartedAt" BIGINT NOT NULL,
      lookups INTEGER NOT NULL DEFAULT 0,
      "firstLookupAt" BIGINT,
      status TEXT NOT NULL DEFAULT 'none',
      feed TEXT,
      hex TEXT,
      callsign TEXT,
      "aircraftType" TEXT,
      registration TEXT,
      "gsKt" DOUBLE PRECISION,
      "trackDeg" DOUBLE PRECISION,
      "altM" DOUBLE PRECISION,
      "distanceKm" DOUBLE PRECISION,
      "matchedAt" BIGINT,
      PRIMARY KEY ("sourceId", "nodeNum")
    )
  `);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration180Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  // sourceId matches sources.id (VARCHAR(36)) so the FK is type-compatible.
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      sourceId VARCHAR(36) NOT NULL,
      nodeNum BIGINT NOT NULL,
      episodeStartedAt BIGINT NOT NULL,
      lookups INT NOT NULL DEFAULT 0,
      firstLookupAt BIGINT,
      status VARCHAR(16) NOT NULL DEFAULT 'none',
      feed VARCHAR(32),
      hex VARCHAR(16),
      callsign VARCHAR(32),
      aircraftType VARCHAR(16),
      registration VARCHAR(32),
      gsKt DOUBLE,
      trackDeg DOUBLE,
      altM DOUBLE,
      distanceKm DOUBLE,
      matchedAt BIGINT,
      PRIMARY KEY (sourceId, nodeNum),
      CONSTRAINT fk_aircraft_flight_matches_source FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
    )
  `);
  logger.info(`${LABEL} complete (MySQL)`);
}
