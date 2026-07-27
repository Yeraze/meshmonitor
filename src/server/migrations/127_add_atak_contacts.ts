/**
 * Migration 127: Create atak_contacts table.
 *
 * Stores one row per distinct ATAK EUD (End User Device) seen on a source,
 * built from the PLI (Position Location Information) variant of a decoded
 * TAKPacket (ATAK/CoT Phase 2, issue #3691). Unlike the reception-log tables
 * (mqtt_packet_log, packet_log), this is a one-row-per-device state table —
 * each new PLI beacon upserts the existing row on `(uid, sourceId)` rather
 * than appending. Meshtastic-only: MeshCore has no ATAK format.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. Pure `CREATE ... IF NOT
 * EXISTS` — no backfill; the table starts empty and populates from live PLI
 * traffic.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 127';
const TABLE = 'atak_contacts';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        uid TEXT NOT NULL,
        sourceId TEXT NOT NULL,
        nodeNum INTEGER,
        callsign TEXT,
        deviceCallsign TEXT,
        team INTEGER,
        role INTEGER,
        battery INTEGER,
        latitude REAL,
        longitude REAL,
        altitude INTEGER,
        speed INTEGER,
        course INTEGER,
        lastSeen INTEGER NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY (uid, sourceId)
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_atak_contacts_source_lastseen ON ${TABLE}(sourceId, lastSeen)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_atak_contacts_source_node ON ${TABLE}(sourceId, nodeNum)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration127Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "uid" TEXT NOT NULL,
      "sourceId" TEXT NOT NULL,
      "nodeNum" BIGINT,
      "callsign" TEXT,
      "deviceCallsign" TEXT,
      "team" INTEGER,
      "role" INTEGER,
      "battery" INTEGER,
      "latitude" REAL,
      "longitude" REAL,
      "altitude" INTEGER,
      "speed" INTEGER,
      "course" INTEGER,
      "lastSeen" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      PRIMARY KEY ("uid", "sourceId")
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_atak_contacts_source_lastseen ON ${TABLE}("sourceId", "lastSeen")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_atak_contacts_source_node ON ${TABLE}("sourceId", "nodeNum")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration127Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      uid VARCHAR(191) NOT NULL,
      sourceId VARCHAR(191) NOT NULL,
      nodeNum BIGINT,
      callsign VARCHAR(255),
      deviceCallsign VARCHAR(255),
      team INT,
      role INT,
      battery INT,
      latitude DOUBLE,
      longitude DOUBLE,
      altitude INT,
      speed INT,
      course INT,
      lastSeen BIGINT NOT NULL,
      createdAt BIGINT NOT NULL,
      PRIMARY KEY (uid, sourceId),
      INDEX idx_atak_contacts_source_lastseen (sourceId, lastSeen),
      INDEX idx_atak_contacts_source_node (sourceId, nodeNum)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
