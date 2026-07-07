/**
 * Migration 066: Add `transportMechanism` column to `nodes` and
 * backfill from `viaMqtt`.
 *
 * The Meshtastic firmware's `MeshPacket.transport_mechanism` enum
 * is already persisted on packets; this column lifts the most-recent
 * value seen onto the node row so the map's per-class visibility
 * toggles ("Show RF / UDP / MQTT") can filter markers without
 * scanning every packet. Closes the node-level half of #3112.
 *
 * Value map (mirrors meshtastic.MeshPacket.TransportMechanism):
 *   0  INTERNAL
 *   1  LORA           ← RF default
 *   2  LORA_ALT1
 *   3  LORA_ALT2
 *   4  LORA_ALT3
 *   5  MQTT
 *   6  MULTICAST_UDP
 *   7  API
 *
 * Backfill semantics (honors existing `viaMqtt`):
 *   - `viaMqtt = TRUE`  → MQTT (5)
 *   - everything else   → LORA (1)
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 066';
const TABLE = 'nodes';
const COLUMN = 'transportMechanism';

const LORA = 1;
const MQTT = 5;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
       
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER`);
      logger.debug(`${LABEL} (SQLite): added ${TABLE}.${COLUMN}`);
    } catch (e: any) {
      if (e.message?.includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already present, skipping ADD`);
      } else {
        logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${COLUMN}:`, e.message);
        throw e;
      }
    }

    // Backfill: honor existing viaMqtt; everything else defaults to LORA.
    try {
       
      const result = db
        .prepare(
          `UPDATE ${TABLE}
             SET ${COLUMN} = CASE WHEN viaMqtt = 1 THEN ${MQTT} ELSE ${LORA} END
           WHERE ${COLUMN} IS NULL`,
        )
        .run();
      logger.info(`${LABEL} (SQLite): backfilled ${result.changes} rows`);
    } catch (e: any) {
      logger.error(`${LABEL} (SQLite): backfill failed:`, e.message);
      throw e;
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration066Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" INTEGER`);
  const result = await client.query(
    `UPDATE ${TABLE}
       SET "${COLUMN}" = CASE WHEN "viaMqtt" = TRUE THEN ${MQTT} ELSE ${LORA} END
     WHERE "${COLUMN}" IS NULL`,
  );
  logger.info(`${LABEL} (PostgreSQL): backfilled ${result.rowCount ?? 0} rows`);
}

// ============ MySQL ============

export async function runMigration066Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [TABLE, COLUMN],
    );
    if (Array.isArray(rows) && rows.length === 0) {
      await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INT`);
      logger.debug(`${LABEL} (MySQL): added ${TABLE}.${COLUMN}`);
    } else {
      logger.debug(`${LABEL} (MySQL): ${TABLE}.${COLUMN} already present, skipping ADD`);
    }

    const [updateResult]: any = await conn.query(
      `UPDATE ${TABLE}
         SET ${COLUMN} = CASE WHEN viaMqtt = TRUE THEN ${MQTT} ELSE ${LORA} END
       WHERE ${COLUMN} IS NULL`,
    );
    logger.info(`${LABEL} (MySQL): backfilled ${updateResult?.affectedRows ?? 0} rows`);
  } finally {
    conn.release();
  }
}
