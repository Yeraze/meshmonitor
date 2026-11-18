/**
 * Migration 240: Create `script_secrets`.
 *
 * Named values that user scripts receive as environment variables. GLOBAL by
 * design (no sourceId): every script run gets every stored secret. The value
 * only ever lives in `encryptedValue` as an AES-256-GCM envelope JSON keyed
 * from SESSION_SECRET; `name` is clear (it is the variable name).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 240';
const TABLE = 'script_secrets';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        name TEXT PRIMARY KEY,
        encryptedValue TEXT NOT NULL,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the migration-file convention (pg Client)
export async function runMigration240Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "name" TEXT PRIMARY KEY,
      "encryptedValue" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches the migration-file convention (mysql2 Pool)
export async function runMigration240Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      name VARCHAR(64) PRIMARY KEY,
      encryptedValue TEXT NOT NULL,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL
    )
  `);
}
