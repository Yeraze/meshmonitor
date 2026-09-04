/**
 * Migration 158: per-observer attribution on `meshcore_packet_log` (#5040 Phase 2).
 *
 * A `meshcore_mqtt` source ingests what EVERY observer in a region heard, so
 * one over-the-air packet arrives once per observer that heard it. Those copies
 * are not duplicates to be collapsed on the way in — differing SNR/RSSI per
 * observer is precisely the coverage data that makes a region feed worth
 * reading. The table therefore becomes a *reception* log for these sources
 * (N rows per packet), deduped at query time, exactly as `mqtt_packet_log`
 * already is for per-gateway Meshtastic receptions.
 *
 *   observerId  TEXT  64-hex public key of the observer that heard this copy.
 *                     NULL for a locally-heard packet (device-backed sources),
 *                     which is every existing row.
 *
 * NULL is the correct backfill, not a sentinel: existing rows came from this
 * install's own radio via `LogRxData`, and there is no observer key to name
 * because we WERE the observer. Queries distinguish the two on `IS NULL`
 * rather than on the source type, so a device-backed source keeps its
 * one-row-per-packet behaviour with no branching.
 *
 * The index is on (sourceId, rawHex) — the query-time dedup groups receptions
 * of the same frame within a source, and `rawHex` is the frame identity (the
 * decoder already treats it as the sole source of truth). Deliberately NOT on
 * observerId alone: no query asks "everything one observer heard" without also
 * scoping to a source.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 158';
const TABLE = 'meshcore_packet_log';
const COLUMN = 'observerId';
const INDEX = 'idx_meshcore_packet_log_source_raw';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);

    try {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} TEXT`);
      logger.debug(`${LABEL} (SQLite): added ${TABLE}.${COLUMN}`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already exists, skipping`);
      } else {
        logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${COLUMN}:`, message);
        throw e;
      }
    }

    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} (sourceId, rawHex)`);
    logger.debug(`${LABEL} (SQLite): ensured ${INDEX}`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration158Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);

  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" TEXT`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE} ("sourceId", "rawHex")`);
  logger.debug(`${LABEL} (PostgreSQL): ensured ${TABLE}.${COLUMN} and ${INDEX}`);
}

// ============ MySQL ============

export async function runMigration158Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);

  const conn = await pool.getConnection();
  try {
    const [cols] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (!Array.isArray(cols) || cols.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} VARCHAR(64)`);
      logger.debug(`${LABEL} (MySQL): added ${TABLE}.${COLUMN}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already exists, skipping`);
    }

    // MySQL has no CREATE INDEX IF NOT EXISTS — pre-check information_schema.
    const [idx] = await conn.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
      [TABLE, INDEX],
    );
    if (!Array.isArray(idx) || idx.length === 0) {
      // rawHex is TEXT on MySQL, so the index needs a prefix length.
      await conn.query(`CREATE INDEX ${INDEX} ON ${TABLE} (sourceId, rawHex(64))`);
      logger.debug(`${LABEL} (MySQL): created ${INDEX}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${INDEX} already exists, skipping`);
    }
  } finally {
    conn.release();
  }
}
