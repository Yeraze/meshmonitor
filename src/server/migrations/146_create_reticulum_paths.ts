/**
 * Migration 146: create `reticulum_paths` (Reticulum epic #3960, Phase 4 WP1).
 *
 * Row per next-hop path table entry reported by the bridge (the `path_table`
 * event — `RNSManager.refresh_path_table` / `RNS.Transport.get_path_table()`).
 * See `docs/internal/dev-notes/RETICULUM_PHASE4_BUILD_SPEC.md` §3.1.
 *
 * Write semantics: SNAPSHOT REPLACE scoped by sourceId. The bridge emits the
 * whole path table each poll, so the repository deletes all rows for the
 * source and bulk-inserts the fresh snapshot (`ReticulumRepository.replacePaths`)
 * rather than upserting row-by-row.
 *
 * PER-SOURCE — every row carries a `sourceId`.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql, createIndexIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 146';
const TABLE = 'reticulum_paths';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        destinationHash TEXT NOT NULL,
        viaHash TEXT,
        hops INTEGER,
        interfaceName TEXT,
        expiresAt INTEGER,
        updatedAt INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS reticulum_paths_source_dest_idx
      ON ${TABLE}(sourceId, destinationHash)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS reticulum_paths_source_updated_idx
      ON ${TABLE}(sourceId, updatedAt)
    `);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration146Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "destinationHash" TEXT NOT NULL,
      "viaHash" TEXT,
      hops INTEGER,
      "interfaceName" TEXT,
      "expiresAt" BIGINT,
      "updatedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS reticulum_paths_source_dest_idx
    ON ${TABLE}("sourceId", "destinationHash")
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS reticulum_paths_source_updated_idx
    ON ${TABLE}("sourceId", "updatedAt")
  `);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration146Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(191) NOT NULL,
      destinationHash VARCHAR(64) NOT NULL,
      viaHash VARCHAR(64),
      hops INT,
      interfaceName VARCHAR(191),
      expiresAt BIGINT,
      updatedAt BIGINT NOT NULL,
      UNIQUE KEY reticulum_paths_source_dest_idx (sourceId, destinationHash)
    )
  `);
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    'reticulum_paths_source_updated_idx',
    `CREATE INDEX reticulum_paths_source_updated_idx ON ${TABLE}(sourceId, updatedAt)`,
  );

  logger.info(`${LABEL} complete (MySQL)`);
}
