/**
 * Migration 147: Create mesh_beacon_offers table.
 *
 * Stores received MeshBeacon offers (firmware 2.8+, issue #4723). Beacons were
 * previously transient — the automation engine fired off the packet and the
 * offer was discarded — so an actionable invitation card had nothing to render
 * and nowhere to record a dismissal.
 *
 * One-row-per-(sourceId, nodeNum) state table, like `atak_contacts`: a
 * rebroadcast upserts the existing row rather than appending, so the table is
 * bounded by beaconing neighbours rather than by uptime.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. Pure `CREATE ... IF NOT
 * EXISTS` — no backfill; the table starts empty and populates from live beacon
 * traffic (there is no historical beacon data to recover).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 147';
const TABLE = 'mesh_beacon_offers';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sourceId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        message TEXT,
        offerChannelName TEXT,
        offerChannelPsk TEXT,
        offerRegion INTEGER,
        offerPreset INTEGER,
        hasOffer INTEGER NOT NULL DEFAULT 0,
        firstSeenAt INTEGER NOT NULL,
        lastSeenAt INTEGER NOT NULL,
        dismissedAt INTEGER,
        PRIMARY KEY (sourceId, nodeNum)
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_mesh_beacon_offers_lastSeenAt ON ${TABLE}(lastSeenAt)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration147Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "sourceId" TEXT NOT NULL,
      "nodeNum" BIGINT NOT NULL,
      "message" TEXT,
      "offerChannelName" TEXT,
      "offerChannelPsk" TEXT,
      "offerRegion" INTEGER,
      "offerPreset" INTEGER,
      "hasOffer" BOOLEAN NOT NULL DEFAULT FALSE,
      "firstSeenAt" BIGINT NOT NULL,
      "lastSeenAt" BIGINT NOT NULL,
      "dismissedAt" BIGINT,
      PRIMARY KEY ("sourceId", "nodeNum")
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_mesh_beacon_offers_lastSeenAt ON ${TABLE}("lastSeenAt")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration147Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      sourceId VARCHAR(191) NOT NULL,
      nodeNum BIGINT NOT NULL,
      message TEXT,
      offerChannelName VARCHAR(255),
      offerChannelPsk TEXT,
      offerRegion INT,
      offerPreset INT,
      hasOffer BOOLEAN NOT NULL DEFAULT FALSE,
      firstSeenAt BIGINT NOT NULL,
      lastSeenAt BIGINT NOT NULL,
      dismissedAt BIGINT,
      PRIMARY KEY (sourceId, nodeNum),
      INDEX idx_mesh_beacon_offers_lastSeenAt (lastSeenAt)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
