/**
 * Migration 128: `ok_to_mqtt` violation detection (#4114).
 *
 * Part A: adds `bitfield` / `okToMqttViolation` / `topic` to `mqtt_packet_log`
 * so a reception's originator-set ok_to_mqtt bit (and the derived violation
 * flag) survive alongside the rest of the packet log row.
 *
 * Part B: creates `mqtt_ok_to_mqtt_violations`, a retention-immune history
 * table of *confirmed* violations (a gateway relayed another node's packet
 * while its bit was explicitly clear). It is intentionally a separate table
 * from `mqtt_packet_log` — see `src/db/schema/mqttOkToMqttViolations.ts` and
 * docs/internal/dev-notes/MQTT_OK_TO_MQTT_PHASE1_SPEC.md §1.9/§2(d) for why.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createTableIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 128';
const PL = 'mqtt_packet_log';
const V = 'mqtt_ok_to_mqtt_violations';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ok_to_mqtt columns to ${PL} and creating ${V}...`);

    addColumnIfMissing(db, PL, 'bitfield', 'bitfield INTEGER');
    addColumnIfMissing(db, PL, 'okToMqttViolation', 'okToMqttViolation INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, PL, 'topic', 'topic TEXT');

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${V} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        packetId INTEGER,
        fromNode INTEGER,
        fromNodeId TEXT,
        gatewayId TEXT,
        gatewayNodeNum INTEGER,
        channelId TEXT,
        portnum INTEGER,
        portnumName TEXT,
        bitfield INTEGER,
        topic TEXT,
        rxTime INTEGER,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_ts ON ${V}(sourceId, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_gw_ts ON ${V}(sourceId, gatewayNodeNum, timestamp)`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mqtt_v_dedupe ON ${V}(sourceId, packetId, fromNode, gatewayNodeNum)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops / table drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration128Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ok_to_mqtt columns to ${PL} and creating ${V}...`);

  await addColumnIfMissingPostgres(client, PL, 'bitfield', '"bitfield" INTEGER');
  await addColumnIfMissingPostgres(client, PL, 'okToMqttViolation', '"okToMqttViolation" INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissingPostgres(client, PL, 'topic', '"topic" TEXT');

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${V} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "packetId" BIGINT,
      "fromNode" BIGINT,
      "fromNodeId" TEXT,
      "gatewayId" TEXT,
      "gatewayNodeNum" BIGINT,
      "channelId" TEXT,
      portnum INTEGER,
      "portnumName" TEXT,
      bitfield INTEGER,
      topic TEXT,
      "rxTime" BIGINT,
      "timestamp" BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_ts ON ${V}("sourceId","timestamp")`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_mqtt_v_source_gw_ts ON ${V}("sourceId","gatewayNodeNum","timestamp")`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mqtt_v_dedupe ON ${V}("sourceId","packetId","fromNode","gatewayNodeNum")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration128Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ok_to_mqtt columns to ${PL} and creating ${V}...`);

  await addColumnIfMissingMysql(pool, PL, 'bitfield', 'bitfield INT');
  await addColumnIfMissingMysql(pool, PL, 'okToMqttViolation', 'okToMqttViolation INT NOT NULL DEFAULT 0');
  await addColumnIfMissingMysql(pool, PL, 'topic', 'topic VARCHAR(512)');

  await createTableIfMissingMysql(pool, V, `CREATE TABLE ${V} (
    id SERIAL PRIMARY KEY,
    sourceId VARCHAR(255) NOT NULL,
    packetId BIGINT,
    fromNode BIGINT,
    fromNodeId VARCHAR(16),
    gatewayId VARCHAR(32),
    gatewayNodeNum BIGINT,
    channelId VARCHAR(64),
    portnum INT,
    portnumName VARCHAR(48),
    bitfield INT,
    topic VARCHAR(512),
    rxTime BIGINT,
    timestamp BIGINT NOT NULL,
    createdAt BIGINT NOT NULL,
    INDEX idx_mqtt_v_source_ts (sourceId, timestamp),
    INDEX idx_mqtt_v_source_gw_ts (sourceId, gatewayNodeNum, timestamp),
    UNIQUE KEY idx_mqtt_v_dedupe (sourceId, packetId, fromNode, gatewayNodeNum)
  )`);

  logger.info(`${LABEL} complete (MySQL)`);
}
