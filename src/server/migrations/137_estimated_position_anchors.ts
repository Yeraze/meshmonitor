/**
 * Migration 137: record the rationale behind an estimated position (#4609).
 *
 * Two changes, both GLOBAL (no `sourceId`) to match `estimated_positions`
 * (#3271) — position estimation pools observations from ALL Meshtastic sources
 * into one estimate per physical `nodeNum`, so an anchor has no single owning
 * source.
 *
 *   1. Creates `estimated_position_anchors`: one row per retained contributing
 *      anchor. The estimator previously discarded its observation set after
 *      solving, which left no way to explain a pin. Rows are capped per node by
 *      the writer and replaced wholesale on each estimator run.
 *
 *   2. Adds `nEff` and `radiusMethod` to `estimated_positions`, recording how
 *      the uncertainty radius was derived (lone-anchor 5 km heuristic vs
 *      multi-anchor convergence, and the blend between them).
 *
 * Existing rows keep NULL for both new columns until the next estimator run —
 * the API reports that honestly rather than guessing a method.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
  createTableIfMissingMysql,
  createIndexIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 137';
const TABLE = 'estimated_position_anchors';
const PARENT = 'estimated_positions';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE} and estimate rationale columns...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nodeNum INTEGER NOT NULL,
        anchorNodeNum INTEGER NOT NULL,
        anchorNodeId TEXT NOT NULL,
        anchorLat REAL NOT NULL,
        anchorLon REAL NOT NULL,
        kind TEXT NOT NULL,
        snrDb REAL,
        observedAt INTEGER NOT NULL,
        weight REAL NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS epa_node_idx ON ${TABLE}(nodeNum)`);
    db.exec(`CREATE INDEX IF NOT EXISTS epa_node_weight_idx ON ${TABLE}(nodeNum, weight)`);

    addColumnIfMissing(db, PARENT, 'nEff', 'nEff REAL');
    addColumnIfMissing(db, PARENT, 'radiusMethod', 'radiusMethod TEXT');

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration137Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE} and estimate rationale columns...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "nodeNum" BIGINT NOT NULL,
      "anchorNodeNum" BIGINT NOT NULL,
      "anchorNodeId" TEXT NOT NULL,
      "anchorLat" DOUBLE PRECISION NOT NULL,
      "anchorLon" DOUBLE PRECISION NOT NULL,
      kind TEXT NOT NULL,
      "snrDb" DOUBLE PRECISION,
      "observedAt" BIGINT NOT NULL,
      weight DOUBLE PRECISION NOT NULL,
      "createdAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS epa_node_idx ON ${TABLE}("nodeNum")`);
  await client.query(`CREATE INDEX IF NOT EXISTS epa_node_weight_idx ON ${TABLE}("nodeNum", weight)`);

  await addColumnIfMissingPostgres(client, PARENT, 'nEff', '"nEff" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, PARENT, 'radiusMethod', '"radiusMethod" TEXT');

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration137Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE} and estimate rationale columns...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nodeNum BIGINT NOT NULL,
      anchorNodeNum BIGINT NOT NULL,
      anchorNodeId VARCHAR(16) NOT NULL,
      anchorLat DOUBLE NOT NULL,
      anchorLon DOUBLE NOT NULL,
      kind VARCHAR(16) NOT NULL,
      snrDb DOUBLE,
      observedAt BIGINT NOT NULL,
      weight DOUBLE NOT NULL,
      createdAt BIGINT NOT NULL,
      KEY epa_node_idx (nodeNum),
      KEY epa_node_weight_idx (nodeNum, weight)
    )
  `);
  // Covers a database where the table pre-existed without the indexes.
  await createIndexIfMissingMysql(pool, TABLE, 'epa_node_idx', `CREATE INDEX epa_node_idx ON ${TABLE}(nodeNum)`);
  await createIndexIfMissingMysql(pool, TABLE, 'epa_node_weight_idx', `CREATE INDEX epa_node_weight_idx ON ${TABLE}(nodeNum, weight)`);

  await addColumnIfMissingMysql(pool, PARENT, 'nEff', 'nEff DOUBLE');
  await addColumnIfMissingMysql(pool, PARENT, 'radiusMethod', 'radiusMethod VARCHAR(24)');

  logger.info(`${LABEL} complete (MySQL)`);
}
