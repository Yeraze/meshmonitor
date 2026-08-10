/**
 * Migration 139: create `automation_home_anchors` for trigger.leftHome.
 *
 * Persists per-(automation, node) home/anchor coordinates so left-home
 * automations survive restarts without re-homing a moved (stolen) node.
 * GLOBAL — no sourceId, matching the automations table.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql, createIndexIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 139';
const TABLE = 'automation_home_anchors';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        automationId TEXT NOT NULL,
        nodeNum INTEGER NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        setAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS aha_automation_node_idx ON ${TABLE}(automationId, nodeNum)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration139Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "automationId" TEXT NOT NULL,
      "nodeNum" BIGINT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      "setAt" BIGINT NOT NULL
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS aha_automation_node_idx
    ON ${TABLE}("automationId", "nodeNum")
  `);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration139Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      automationId VARCHAR(36) NOT NULL,
      nodeNum BIGINT NOT NULL,
      latitude DOUBLE NOT NULL,
      longitude DOUBLE NOT NULL,
      setAt BIGINT NOT NULL,
      UNIQUE KEY aha_automation_node_idx (automationId, nodeNum)
    )
  `);
  await createIndexIfMissingMysql(
    pool,
    TABLE,
    'aha_automation_node_idx',
    `CREATE UNIQUE INDEX aha_automation_node_idx ON ${TABLE}(automationId, nodeNum)`,
  );

  logger.info(`${LABEL} complete (MySQL)`);
}
