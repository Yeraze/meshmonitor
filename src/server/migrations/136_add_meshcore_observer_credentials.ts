/**
 * Migration 136: Create `meshcore_observer_credentials`.
 *
 * One row per MeshCore source holding that source's STATIC MQTT broker
 * username/password for the Analyzer Observer (issue #4595) — the auth mode
 * used by regional brokers such as meshcoretel.ru that do not verify the
 * Ed25519-signed token. The password only ever lives in `encryptedPassword`
 * as an AES-256-GCM envelope JSON; `username` is clear (it is not secret and
 * the UI must be able to display it).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 136';
const TABLE = 'meshcore_observer_credentials';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        sourceId TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        encryptedPassword TEXT NOT NULL,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the 133 migration-file convention (pg Client)
export async function runMigration136Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "sourceId" TEXT PRIMARY KEY,
      "username" TEXT NOT NULL,
      "encryptedPassword" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the 133 migration-file convention (mysql2 Pool)
export async function runMigration136Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      sourceId VARCHAR(36) PRIMARY KEY,
      username VARCHAR(255) NOT NULL,
      encryptedPassword TEXT NOT NULL,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    )
  `);
}
