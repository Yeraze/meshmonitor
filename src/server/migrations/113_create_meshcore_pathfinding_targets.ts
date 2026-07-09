/**
 * Migration 113: MeshCore Auto-Pathfinding target allowlist (#4024).
 *
 * Creates `meshcore_pathfinding_targets`: one row per selected contact
 * `publicKey` per `sourceId` — the OR-union "specific contact" sub-filter for
 * MeshCore Auto-Pathfinding target filtering. Every row is source-scoped
 * (unlike `auto_traceroute_nodes`, there is no legacy unscoped data for this
 * table — `sourceId` is `NOT NULL`).
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 113';
const TABLE = 'meshcore_pathfinding_targets';
const IDX = 'meshcore_pathfinding_targets_source_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        UNIQUE(sourceId, publicKey)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${IDX} ON ${TABLE}(sourceId)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration113Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "publicKey" TEXT NOT NULL,
      "createdAt" BIGINT NOT NULL,
      CONSTRAINT meshcore_pathfinding_targets_source_pk_uniq UNIQUE ("sourceId","publicKey")
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${IDX} ON ${TABLE}("sourceId")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration113Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  const conn = await pool.getConnection();
  try {
    const [exists] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [TABLE],
    );
    if ((exists as unknown[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${TABLE} (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          sourceId VARCHAR(255) NOT NULL,
          publicKey VARCHAR(64) NOT NULL,
          createdAt BIGINT NOT NULL,
          UNIQUE KEY meshcore_pathfinding_targets_source_pk_uniq (sourceId, publicKey),
          INDEX ${IDX} (sourceId)
        )
      `);
    } else {
      logger.debug(`${TABLE} already exists, skipping create`);
    }
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
