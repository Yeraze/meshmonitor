/**
 * Migration 088: Create `source_pki_keys`.
 *
 * One row per Meshtastic source holding that source's local-node X25519 private
 * key, encrypted at rest (AES-256-GCM envelope JSON). Powers server-side
 * decryption of PKI direct messages for the unified view (issue #3441). The
 * private key only ever lives in `encryptedPrivateKey`; `publicKey` is clear.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 088';
const TABLE = 'source_pki_keys';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
     
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sourceId TEXT PRIMARY KEY,
        nodeNum INTEGER,
        encryptedPrivateKey TEXT NOT NULL,
        publicKey TEXT,
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

export async function runMigration088Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "sourceId" TEXT PRIMARY KEY,
      "nodeNum" BIGINT,
      "encryptedPrivateKey" TEXT NOT NULL,
      "publicKey" TEXT,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
}

// ============ MySQL ============

export async function runMigration088Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      sourceId VARCHAR(36) PRIMARY KEY,
      nodeNum BIGINT,
      encryptedPrivateKey TEXT NOT NULL,
      publicKey VARCHAR(128),
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    )
  `);
}
