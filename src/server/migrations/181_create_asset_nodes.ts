/**
 * Migration 181: the `asset_nodes` table (issue #5354, Asset Tracking Phase 1).
 *
 * One row per physical node the operator has marked as a tracked asset, with
 * the number of days its telemetry is kept. See the schema file
 * (`src/db/schema/assetNodes.ts`) for the rationale.
 *
 * GLOBAL by design — no `sourceId`, and no foreign key to `nodes` (the node row
 * is per source; the flag is per physical node). Copies migration 167
 * (`solar_node_overrides`).
 *
 * `nodeNum` is BIGINT on PostgreSQL/MySQL because it is an unsigned 32-bit
 * value that overflows a signed INTEGER.
 *
 * No backfill — an absent row means "not an asset", which is today's behaviour.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL (CLAUDE.md migration recipe).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 181';
const TABLE = 'asset_nodes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        nodeNum INTEGER PRIMARY KEY,
        retentionDays INTEGER NOT NULL,
        updatedBy INTEGER,
        updatedAt INTEGER NOT NULL
      )
    `);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (dropping asset flags is destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration181Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      "nodeNum" BIGINT PRIMARY KEY,
      "retentionDays" INTEGER NOT NULL,
      "updatedBy" INTEGER,
      "updatedAt" BIGINT NOT NULL
    )
  `);
}

// ============ MySQL ============

export async function runMigration181Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);
  await createTableIfMissingMysql(
    pool,
    TABLE,
    `CREATE TABLE ${TABLE} (
      nodeNum BIGINT NOT NULL PRIMARY KEY,
      retentionDays INT NOT NULL,
      updatedBy INT,
      updatedAt BIGINT NOT NULL
    )`,
  );
}
