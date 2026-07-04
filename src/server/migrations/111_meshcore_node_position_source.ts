/**
 * Migration 111: `positionSource` marker on `meshcore_nodes` (#3908).
 *
 * Adds a single nullable text column:
 *
 *   positionSource  TEXT  ('contact' | 'telemetry' | NULL)
 *
 * `meshcore_nodes.latitude/longitude` is written by two independent paths
 * that previously shared the columns with no precedence rule: contact
 * adverts (the static position cached on the in-memory contact record) and
 * the Cayenne-LPP remote-telemetry poll (the node's actual live GNSS fix).
 * Because advert-driven writes (`persistContact`) fire far more often than
 * the telemetry poll, they repeatedly clobbered a telemetry-derived fix with
 * the static one, corrupting both the node's current position and the
 * `meshcore_position_history` trail.
 *
 * This column lets `MeshCoreRepository.upsertNode` tell the two apart and
 * give telemetry-sourced fixes precedence once established, falling back to
 * the static contact position only when no telemetry fix has ever been
 * recorded for that node.
 *
 * Backfill is unnecessary — existing rows default to NULL (unknown source),
 * which behaves like the pre-migration fallback path.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 111';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding positionSource column to meshcore_nodes...`);
    try {
      db.exec(`ALTER TABLE meshcore_nodes ADD COLUMN positionSource TEXT`);
      logger.debug(`${LABEL} (SQLite): added meshcore_nodes.positionSource`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): meshcore_nodes.positionSource already exists, skipping`);
      } else {
        logger.error(`${LABEL} (SQLite): could not add meshcore_nodes.positionSource:`, e.message);
        throw e;
      }
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration111Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding positionSource column to meshcore_nodes...`);
  await client.query(
    `ALTER TABLE meshcore_nodes ADD COLUMN IF NOT EXISTS "positionSource" TEXT`,
  );
  logger.debug(`${LABEL} (PostgreSQL): ensured meshcore_nodes.positionSource`);
}

// ============ MySQL ============

export async function runMigration111Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding positionSource column to meshcore_nodes...`);

  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meshcore_nodes' AND COLUMN_NAME = 'positionSource'`,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      await conn.query(`ALTER TABLE meshcore_nodes ADD COLUMN positionSource VARCHAR(16)`);
      logger.debug(`${LABEL} (MySQL): added meshcore_nodes.positionSource`);
    } else {
      logger.debug(`${LABEL} (MySQL): meshcore_nodes.positionSource already exists, skipping`);
    }
  } finally {
    conn.release();
  }
}
