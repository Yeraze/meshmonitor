/**
 * Migration 121: Create mqtt_packet_log table.
 *
 * Stores one row per gateway reception of an MQTT-bridged Meshtastic packet
 * (ServiceEnvelope), powering the MQTT Packet Monitor. Unlike the Meshtastic
 * `packet_log` table (one row per TCP packet), MQTT's defining trait is N
 * receptions of the same packet — one per gateway — so this table is a
 * purpose-built reception log with a query-time grouped/dedup view. Capture
 * is opt-in via the `mqtt_packet_log_enabled` setting.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 121';
const TABLE = 'mqtt_packet_log';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        packetId INTEGER,
        fromNode INTEGER,
        fromNodeId TEXT,
        toNode INTEGER,
        toNodeId TEXT,
        channel INTEGER,
        channelId TEXT,
        gatewayId TEXT,
        gatewayNodeNum INTEGER,
        timestamp INTEGER NOT NULL,
        rxTime INTEGER,
        rxSnr REAL,
        rxRssi INTEGER,
        hopLimit INTEGER,
        hopStart INTEGER,
        portnum INTEGER,
        portnumName TEXT,
        encrypted INTEGER NOT NULL DEFAULT 0,
        decryptedBy TEXT,
        ingestOutcome TEXT NOT NULL,
        payloadSize INTEGER,
        payloadPreview TEXT,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_ts ON ${TABLE}(sourceId, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_pkt_from ON ${TABLE}(sourceId, packetId, fromNode)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_gw ON ${TABLE}(sourceId, gatewayId)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration121Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "packetId" BIGINT,
      "fromNode" BIGINT,
      "fromNodeId" TEXT,
      "toNode" BIGINT,
      "toNodeId" TEXT,
      channel INTEGER,
      "channelId" TEXT,
      "gatewayId" TEXT,
      "gatewayNodeNum" BIGINT,
      "timestamp" BIGINT NOT NULL,
      "rxTime" BIGINT,
      "rxSnr" REAL,
      "rxRssi" INTEGER,
      "hopLimit" INTEGER,
      "hopStart" INTEGER,
      portnum INTEGER,
      "portnumName" TEXT,
      encrypted INTEGER NOT NULL DEFAULT 0,
      "decryptedBy" TEXT,
      "ingestOutcome" TEXT NOT NULL,
      "payloadSize" INTEGER,
      "payloadPreview" TEXT,
      "createdAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_ts ON ${TABLE}("sourceId", "timestamp")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_pkt_from ON ${TABLE}("sourceId", "packetId", "fromNode")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mqtt_pl_source_gw ON ${TABLE}("sourceId", "gatewayId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration121Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  const conn = await pool.getConnection();
  try {
    const [existRows] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [TABLE],
    );
    if ((existRows as unknown[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${TABLE} (
          id SERIAL PRIMARY KEY,
          sourceId VARCHAR(255) NOT NULL,
          packetId BIGINT,
          fromNode BIGINT,
          fromNodeId VARCHAR(16),
          toNode BIGINT,
          toNodeId VARCHAR(16),
          channel INT,
          channelId VARCHAR(64),
          gatewayId VARCHAR(32),
          gatewayNodeNum BIGINT,
          timestamp BIGINT NOT NULL,
          rxTime BIGINT,
          rxSnr DOUBLE,
          rxRssi INT,
          hopLimit INT,
          hopStart INT,
          portnum INT,
          portnumName VARCHAR(48),
          encrypted INT NOT NULL DEFAULT 0,
          decryptedBy VARCHAR(16),
          ingestOutcome VARCHAR(24) NOT NULL,
          payloadSize INT,
          payloadPreview VARCHAR(256),
          createdAt BIGINT NOT NULL,
          INDEX idx_mqtt_pl_source_ts (sourceId, timestamp),
          INDEX idx_mqtt_pl_source_pkt_from (sourceId, packetId, fromNode),
          INDEX idx_mqtt_pl_source_gw (sourceId, gatewayId)
        )
      `);
    } else {
      logger.debug(`${TABLE} already exists, skipping create`);
    }
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
