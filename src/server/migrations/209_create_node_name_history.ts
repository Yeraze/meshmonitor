/**
 * Migration 209: create `node_name_history` (issue #5862).
 *
 * One row per rename a source saw: a node's long/short name changed from one
 * real name to another. PER-SOURCE — every row carries a `sourceId`. Covers
 * both protocols: `protocol` is 'meshtastic' (nodeKey = decimal nodeNum) or
 * 'meshcore' (nodeKey = public key hex; MeshCore has one name, held in the
 * long-name columns).
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill — the old names were never kept.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 209';
const TABLE = 'node_name_history';
const NODE_INDEX = 'node_name_history_node_idx';
const SOURCE_INDEX = 'node_name_history_source_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        protocol TEXT NOT NULL,
        nodeKey TEXT NOT NULL,
        oldLongName TEXT,
        newLongName TEXT,
        oldShortName TEXT,
        newShortName TEXT,
        changedAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${NODE_INDEX} ON ${TABLE}(protocol, nodeKey, sourceId, changedAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${SOURCE_INDEX} ON ${TABLE}(sourceId)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration209Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      protocol TEXT NOT NULL,
      "nodeKey" TEXT NOT NULL,
      "oldLongName" TEXT,
      "newLongName" TEXT,
      "oldShortName" TEXT,
      "newShortName" TEXT,
      "changedAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${NODE_INDEX} ON ${TABLE}(protocol, "nodeKey", "sourceId", "changedAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${SOURCE_INDEX} ON ${TABLE}("sourceId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration209Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      protocol VARCHAR(16) NOT NULL,
      nodeKey VARCHAR(64) NOT NULL,
      oldLongName VARCHAR(255),
      newLongName VARCHAR(255),
      oldShortName VARCHAR(32),
      newShortName VARCHAR(32),
      changedAt BIGINT NOT NULL,
      INDEX ${NODE_INDEX} (protocol, nodeKey, sourceId, changedAt),
      INDEX ${SOURCE_INDEX} (sourceId)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
