/**
 * Migration 223: Create `meshcore_source_pki_keys`.
 *
 * One row per MeshCore Companion source holding that device's OWN Ed25519
 * identity private key (orlp format), encrypted at rest (AES-256-GCM envelope
 * JSON). Captured automatically on connect, it lets the server derive the
 * X25519 DM shared secret per peer and decrypt our own echoed direct messages
 * for exact #6194 heard-by matching (issue #6195). The private key only ever
 * lives in `encryptedPrivateKey`; `publicKey` is clear. `keyMismatch` records
 * that the device later reported a different key, so we never overwrite a
 * captured key silently.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 223';
const TABLE = 'meshcore_source_pki_keys';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sourceId TEXT PRIMARY KEY,
        encryptedPrivateKey TEXT NOT NULL,
        publicKey TEXT,
        keyMismatch INTEGER NOT NULL DEFAULT 0,
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

export async function runMigration223Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "sourceId" TEXT PRIMARY KEY,
      "encryptedPrivateKey" TEXT NOT NULL,
      "publicKey" TEXT,
      "keyMismatch" INTEGER NOT NULL DEFAULT 0,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
}

// ============ MySQL ============

export async function runMigration223Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      sourceId VARCHAR(36) PRIMARY KEY,
      encryptedPrivateKey TEXT NOT NULL,
      publicKey VARCHAR(64),
      keyMismatch INT NOT NULL DEFAULT 0,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    )
  `);
}
