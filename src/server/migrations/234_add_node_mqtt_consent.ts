/**
 * Migration 234: per-node MQTT consent columns on `nodes` (#5156 part 1).
 *
 *  - `mqttOkToMqtt`      — the `ok_to_mqtt` bit (Data.bitfield bit 0) from the
 *                          most recent MQTT-delivered packet of this node whose
 *                          bitfield we could read. NULL = never read (unknown).
 *  - `mqttOkToMqttAt`    — unix seconds when that bit was read.
 *  - `rfDirectLastHeard` — unix seconds of the last packet from this node heard
 *                          over LoRa with `via_mqtt` clear, i.e. real RF and not
 *                          an MQTT downlink rebroadcast. NULL = never.
 *
 * `nodes` is keyed by (nodeNum, sourceId), so all three are per-source. They
 * feed the opt-in anonymous-viewer filter (`anonHideMqttNoConsent`); no
 * backfill, since no stored data records either signal. Nullable and additive,
 * idempotent via the shared helpers (full DDL).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 234';
const TABLE = 'nodes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding MQTT consent columns to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'mqttOkToMqtt', 'mqttOkToMqtt INTEGER');
    addColumnIfMissing(db, TABLE, 'mqttOkToMqttAt', 'mqttOkToMqttAt INTEGER');
    addColumnIfMissing(db, TABLE, 'rfDirectLastHeard', 'rfDirectLastHeard INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration234Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding MQTT consent columns to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'mqttOkToMqtt', '"mqttOkToMqtt" BOOLEAN');
  await addColumnIfMissingPostgres(client, TABLE, 'mqttOkToMqttAt', '"mqttOkToMqttAt" BIGINT');
  await addColumnIfMissingPostgres(client, TABLE, 'rfDirectLastHeard', '"rfDirectLastHeard" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration234Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding MQTT consent columns to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'mqttOkToMqtt', 'mqttOkToMqtt BOOLEAN');
  await addColumnIfMissingMysql(pool, TABLE, 'mqttOkToMqttAt', 'mqttOkToMqttAt BIGINT');
  await addColumnIfMissingMysql(pool, TABLE, 'rfDirectLastHeard', 'rfDirectLastHeard BIGINT');
  logger.info(`${LABEL} complete (MySQL)`);
}
