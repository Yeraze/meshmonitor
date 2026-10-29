/**
 * Migration 219: create `automation_fire_state`.
 *
 * Persists the Automation Engine's cooldown and rate-limit state so a restart
 * or a disable/re-enable does not re-arm a rule (CLAUDE.md Mesh impact
 * checklist §3). Cooldown rows hold the last fire per (automation, cooldown
 * key); a rate row holds the fire times still inside the rule's window.
 * GLOBAL — no sourceId, matching the automations table.
 *
 * Creates a new empty table, so there is nothing to backfill. Idempotent
 * across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql, createIndexIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 219';
const TABLE = 'automation_fire_state';
const INDEX = 'afs_automation_kind_key_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automationId TEXT NOT NULL,
        kind TEXT NOT NULL,
        scopeKey TEXT NOT NULL,
        firedAt INTEGER NOT NULL,
        events TEXT
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(automationId, kind, scopeKey)`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration219Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "automationId" TEXT NOT NULL,
      kind TEXT NOT NULL,
      "scopeKey" TEXT NOT NULL,
      "firedAt" BIGINT NOT NULL,
      events TEXT
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX}
    ON ${TABLE}("automationId", kind, "scopeKey")
  `);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration219Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      automationId VARCHAR(36) NOT NULL,
      kind VARCHAR(16) NOT NULL,
      scopeKey VARCHAR(191) NOT NULL,
      firedAt BIGINT NOT NULL,
      events TEXT,
      UNIQUE KEY ${INDEX} (automationId, kind, scopeKey)
    )
  `);
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    INDEX,
    `CREATE UNIQUE INDEX ${INDEX} ON ${TABLE}(automationId, kind, scopeKey)`,
  );
  logger.info(`${LABEL} complete (MySQL)`);
}
