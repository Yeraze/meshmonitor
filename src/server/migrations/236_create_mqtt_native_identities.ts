/**
 * Migration 236: `mqtt_native_identities` (#4305).
 *
 * PER-SOURCE. One row per MQTT source that sends with no radio attached: the
 * generated node number, the X25519 public key, the private key sealed with
 * the SESSION_SECRET envelope, the last NodeInfo announce time and the recent
 * send timestamps for the hourly cap. Secret table: see BACKUP_SECRET_TABLES.
 *
 * Idempotent on every backend (CREATE TABLE IF NOT EXISTS / information_schema
 * pre-check). Creates nothing destructive.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 236';
const TABLE = 'mqtt_native_identities';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sourceId TEXT PRIMARY KEY,
        nodeNum INTEGER NOT NULL,
        publicKey TEXT NOT NULL,
        encryptedPrivateKey TEXT NOT NULL,
        lastNodeInfoAt INTEGER,
        sendTimes TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration236Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "sourceId" TEXT PRIMARY KEY,
      "nodeNum" BIGINT NOT NULL,
      "publicKey" TEXT NOT NULL,
      "encryptedPrivateKey" TEXT NOT NULL,
      "lastNodeInfoAt" BIGINT,
      "sendTimes" TEXT,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration236Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      sourceId VARCHAR(64) NOT NULL PRIMARY KEY,
      nodeNum BIGINT NOT NULL,
      publicKey VARCHAR(128) NOT NULL,
      encryptedPrivateKey TEXT NOT NULL,
      lastNodeInfoAt BIGINT,
      sendTimes TEXT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    )
  `);
  logger.info(`${LABEL} complete (MySQL)`);
}
