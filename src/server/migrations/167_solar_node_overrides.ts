/**
 * Migration 167: the `solar_node_overrides` table (issue #3195).
 *
 * Lets an operator mark a node as solar-powered (or not) when the telemetry
 * pattern detector gets it wrong — typically an over-specced panel and battery
 * bank that never dips far enough to show a charge/discharge cycle.
 *
 * GLOBAL by design — no `sourceId`. A solar panel is a property of the physical
 * node, and the Solar Monitoring report pools telemetry across sources. See the
 * schema file for the full rationale.
 *
 * `nodeNum` is the primary key: at most one classification per node, so every
 * write is an upsert. It is BIGINT on PostgreSQL/MySQL because nodeNum is an
 * unsigned 32-bit value that overflows a signed INTEGER.
 *
 * No backfill — an absent row means "auto-detect", which is today's behaviour.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL (CLAUDE.md migration recipe).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 167';
const TABLE = 'solar_node_overrides';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        nodeNum INTEGER PRIMARY KEY,
        isSolar INTEGER NOT NULL,
        updatedBy TEXT,
        updatedAt INTEGER NOT NULL
      )
    `);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (dropping operator classifications is destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration167Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "nodeNum" BIGINT PRIMARY KEY,
      "isSolar" BOOLEAN NOT NULL,
      "updatedBy" TEXT,
      "updatedAt" BIGINT NOT NULL
    )
  `);
}

// ============ MySQL ============

export async function runMigration167Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(
    pool,
    TABLE,
    `CREATE TABLE ${TABLE} (
      nodeNum BIGINT NOT NULL PRIMARY KEY,
      isSolar BOOLEAN NOT NULL,
      updatedBy VARCHAR(191),
      updatedAt BIGINT NOT NULL
    )`,
  );
}
