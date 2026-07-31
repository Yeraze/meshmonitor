/**
 * Migration 133: Create `meshcore_observer_keys`.
 *
 * One row per MeshCore source holding that source's companion Ed25519
 * (orlp format) signing key, encrypted at rest (AES-256-GCM envelope JSON).
 * Powers the MeshCore Analyzer Observer MQTT output (epic #4457). The
 * private key only ever lives in `encryptedPrivateKey`; `publicKey` is clear
 * (it is not secret — it is broadcast over the air in every ADVERT).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 133';
const TABLE = 'meshcore_observer_keys';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sourceId TEXT PRIMARY KEY,
        encryptedPrivateKey TEXT NOT NULL,
        publicKey TEXT,
        keyOrigin TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);
    logger.debug(`${LABEL} (SQLite): ${TABLE} ready`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (table drops are destructive)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the 088 migration-file convention (pg Client)
export async function runMigration133Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "sourceId" TEXT PRIMARY KEY,
      "encryptedPrivateKey" TEXT NOT NULL,
      "publicKey" TEXT,
      "keyOrigin" TEXT,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the 088 migration-file convention (mysql2 Pool)
export async function runMigration133Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      sourceId VARCHAR(36) PRIMARY KEY,
      encryptedPrivateKey TEXT NOT NULL,
      publicKey VARCHAR(64),
      keyOrigin VARCHAR(16),
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    )
  `);
}
