/**
 * Migration 182: create `meshcore_ignored_nodes` and `meshcore_message_filters`
 * (MeshCore client-side Ignore / Block, #5408, MESHCORE_IGNORE_BLOCK_SPEC.md).
 *
 * PER-SOURCE. Both FK to sources(id) ON DELETE CASCADE, so a deleted source
 * takes its lists with it. Timestamps are epoch ms (BIGINT on PG/MySQL).
 *
 * No backfill: both tables start empty. Idempotent on all three backends
 * (CREATE ... IF NOT EXISTS on SQLite/PG; information_schema checks on MySQL).
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 182';
const NODES = 'meshcore_ignored_nodes';
const FILTERS = 'meshcore_message_filters';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${NODES} and ${FILTERS}...`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${NODES} (
        sourceId TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        name TEXT,
        mode TEXT NOT NULL DEFAULT 'ignore',
        createdAt INTEGER NOT NULL,
        createdBy INTEGER,
        hitCount INTEGER NOT NULL DEFAULT 0,
        lastHitAt INTEGER,
        PRIMARY KEY (sourceId, publicKey),
        FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${FILTERS} (
        id TEXT PRIMARY KEY,
        sourceId TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'ignore',
        matchType TEXT NOT NULL,
        pattern TEXT NOT NULL,
        caseSensitive INTEGER NOT NULL DEFAULT 0,
        fields TEXT NOT NULL DEFAULT 'both',
        enabled INTEGER NOT NULL DEFAULT 1,
        createdAt INTEGER NOT NULL,
        createdBy INTEGER,
        hitCount INTEGER NOT NULL DEFAULT 0,
        lastHitAt INTEGER,
        FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${FILTERS}_source ON ${FILTERS} (sourceId)`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    db.exec(`DROP TABLE IF EXISTS ${FILTERS}`);
    db.exec(`DROP TABLE IF EXISTS ${NODES}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration182Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${NODES} and ${FILTERS}...`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${NODES} (
      "sourceId" TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      "publicKey" TEXT NOT NULL,
      name TEXT,
      mode TEXT NOT NULL DEFAULT 'ignore',
      "createdAt" BIGINT NOT NULL,
      "createdBy" INTEGER,
      "hitCount" INTEGER NOT NULL DEFAULT 0,
      "lastHitAt" BIGINT,
      PRIMARY KEY ("sourceId", "publicKey")
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${FILTERS} (
      id TEXT PRIMARY KEY,
      "sourceId" TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      mode TEXT NOT NULL DEFAULT 'ignore',
      "matchType" TEXT NOT NULL,
      pattern TEXT NOT NULL,
      "caseSensitive" BOOLEAN NOT NULL DEFAULT false,
      fields TEXT NOT NULL DEFAULT 'both',
      enabled BOOLEAN NOT NULL DEFAULT true,
      "createdAt" BIGINT NOT NULL,
      "createdBy" INTEGER,
      "hitCount" INTEGER NOT NULL DEFAULT 0,
      "lastHitAt" BIGINT
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_${FILTERS}_source ON ${FILTERS} ("sourceId")`);
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration182Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${NODES} and ${FILTERS}...`);
  // sourceId matches sources.id (VARCHAR(36)) so the FK is type-compatible.
  await createTableIfMissingMysql(pool, NODES, `
    CREATE TABLE ${NODES} (
      sourceId VARCHAR(36) NOT NULL,
      publicKey VARCHAR(64) NOT NULL,
      name VARCHAR(255),
      mode VARCHAR(8) NOT NULL DEFAULT 'ignore',
      createdAt BIGINT NOT NULL,
      createdBy INT,
      hitCount INT NOT NULL DEFAULT 0,
      lastHitAt BIGINT,
      PRIMARY KEY (sourceId, publicKey),
      CONSTRAINT fk_meshcore_ignored_nodes_source FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
    )
  `);
  await createTableIfMissingMysql(pool, FILTERS, `
    CREATE TABLE ${FILTERS} (
      id VARCHAR(36) NOT NULL PRIMARY KEY,
      sourceId VARCHAR(36) NOT NULL,
      mode VARCHAR(8) NOT NULL DEFAULT 'ignore',
      matchType VARCHAR(16) NOT NULL,
      pattern VARCHAR(512) NOT NULL,
      caseSensitive BOOLEAN NOT NULL DEFAULT false,
      fields VARCHAR(8) NOT NULL DEFAULT 'both',
      enabled BOOLEAN NOT NULL DEFAULT true,
      createdAt BIGINT NOT NULL,
      createdBy INT,
      hitCount INT NOT NULL DEFAULT 0,
      lastHitAt BIGINT,
      INDEX idx_meshcore_message_filters_source (sourceId),
      CONSTRAINT fk_meshcore_message_filters_source FOREIGN KEY (sourceId) REFERENCES sources(id) ON DELETE CASCADE
    )
  `);
  logger.info(`${LABEL} complete (MySQL)`);
}
