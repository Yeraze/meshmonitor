/**
 * Migration 110: MeshCore position-history table (#3852).
 *
 * Creates `meshcore_position_history`: one row per distinct GPS fix observed
 * for a MeshCore node (via contact adverts or the Cayenne-LPP telemetry poll).
 * This is the MeshCore analogue of the Meshtastic position-history trail and
 * backs the MeshCore map's movement-trail overlay.
 *
 * Source-scoped (`sourceId`) like every other per-source MeshCore table. A
 * rolling retention window (default 7 days) is swept by
 * `meshcorePositionHistoryService`; the index on (sourceId, publicKey,
 * timestamp) serves both per-node trail queries and the age-based sweep.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 110';
const TABLE = 'meshcore_position_history';
const IDX = 'meshcore_position_history_node_idx';
// Timestamp-only index for the age-based retention sweep, which filters on
// `timestamp` alone and can't use the leading column of the composite index.
const TS_IDX = 'meshcore_position_history_ts_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        publicKey TEXT NOT NULL,
        latitude REAL NOT NULL,
        longitude REAL NOT NULL,
        altitude REAL,
        timestamp INTEGER NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${IDX} ON ${TABLE}(sourceId, publicKey, timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${TS_IDX} ON ${TABLE}(timestamp)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration110Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "publicKey" TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      altitude DOUBLE PRECISION,
      timestamp BIGINT NOT NULL,
      "createdAt" BIGINT NOT NULL
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${IDX} ON ${TABLE}("sourceId", "publicKey", timestamp)`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${TS_IDX} ON ${TABLE}(timestamp)`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration110Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  const conn = await pool.getConnection();
  try {
    const [exists] = await conn.query(
      `SELECT TABLE_NAME FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [TABLE],
    );
    if ((exists as any[]).length === 0) {
      await conn.query(`
        CREATE TABLE ${TABLE} (
          id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
          sourceId VARCHAR(255) NOT NULL,
          publicKey VARCHAR(64) NOT NULL,
          latitude DOUBLE NOT NULL,
          longitude DOUBLE NOT NULL,
          altitude DOUBLE,
          timestamp BIGINT NOT NULL,
          createdAt BIGINT NOT NULL,
          INDEX ${IDX} (sourceId, publicKey, timestamp),
          INDEX ${TS_IDX} (timestamp)
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
