/**
 * Migration 126: Add `transportFlags` bitmask to `nodes` and backfill from
 * `transportMechanism` / `viaMqtt`.
 *
 * Migration 066 lifted the MOST-RECENT `MeshPacket.transport_mechanism` onto
 * the node row. A single last-wins column cannot express "this node is
 * reachable over RF *and* MQTT", which is the common case: when the local node
 * has an MQTT uplink it receives echoes of the same RF traffic flagged
 * `viaMqtt`, so a last-wins column thrashes and MQTT wins whenever an echo
 * happens to land last. The node then disappears from the map, because the
 * "Show MQTT" toggle defaults to off (#3112). That is #4240.
 *
 * `transportFlags` accumulates instead of replacing: each bit records that the
 * node has EVER been heard over that transport, and the map ORs the bits
 * against the three visibility toggles. A node heard over RF stays visible
 * under "Show RF" no matter how many MQTT echoes arrive afterwards.
 *
 * Bits:
 *   1  RF   (LORA / LORA_ALT* / INTERNAL / API / unknown)
 *   2  MQTT
 *   4  UDP  (MULTICAST_UDP)
 *
 * Backfill mirrors `classifyNodeTransport` exactly, so no node changes
 * visibility at migration time — behavior only diverges as new packets add
 * bits. Rows keep `transportMechanism` for "most recently heard via" display.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

/** Minimal shapes for the driver handles the registry hands us — enough to
 *  avoid `any` without importing pg/mysql2 types into a migration. */
interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }>;
}
interface MysqlConnLike {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  release(): void;
}
interface MysqlPoolLike {
  getConnection(): Promise<MysqlConnLike>;
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const LABEL = 'Migration 126';
const TABLE = 'nodes';
const COLUMN = 'transportFlags';

const RF = 1;
const MQTT = 2;
const UDP = 4;

const TX_MQTT = 5;
const TX_UDP = 6;

/**
 * CASE expression mapping the legacy single-value columns onto bits.
 * `viaMqttTrue` is the backend-specific truthy comparison for `viaMqtt`.
 */
const backfillCase = (viaMqttTrue: string, q: (c: string) => string) => `
  CASE
    WHEN ${q('transportMechanism')} = ${TX_MQTT} THEN ${MQTT}
    WHEN ${q('transportMechanism')} = ${TX_UDP}  THEN ${UDP}
    WHEN ${q('transportMechanism')} IN (1, 2, 3, 4) THEN ${RF}
    WHEN ${viaMqttTrue} THEN ${MQTT}
    ELSE ${RF}
  END`;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    try {
      db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${COLUMN} INTEGER`);
      logger.debug(`${LABEL} (SQLite): added ${TABLE}.${COLUMN}`);
    } catch (e: unknown) {
      if (errMessage(e).includes('duplicate column')) {
        logger.debug(`${LABEL} (SQLite): ${TABLE}.${COLUMN} already present, skipping ADD`);
      } else {
        logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${COLUMN}:`, errMessage(e));
        throw e;
      }
    }

    try {
      // Guarded by `IS NULL` so a re-run after a crash cannot clobber bits that
      // live traffic has already accumulated.
      const result = db
        .prepare(
          `UPDATE ${TABLE}
             SET ${COLUMN} = ${backfillCase('viaMqtt = 1', c => c)}
           WHERE ${COLUMN} IS NULL`,
        )
        .run();
      logger.info(`${LABEL} (SQLite): backfilled ${result.changes} rows`);
    } catch (e: unknown) {
      logger.error(`${LABEL} (SQLite): backfill failed:`, errMessage(e));
      throw e;
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration126Postgres(client: PgClientLike): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${COLUMN}" INTEGER`);
  const q = (c: string) => `"${c}"`;
  const result = await client.query(
    `UPDATE ${TABLE}
       SET "${COLUMN}" = ${backfillCase('"viaMqtt" = TRUE', q)}
     WHERE "${COLUMN}" IS NULL`,
  );
  logger.info(`${LABEL} (PostgreSQL): backfilled ${result.rowCount ?? 0} rows`);
}

// ============ MySQL ============

export async function runMigration126Mysql(pool: MysqlPoolLike): Promise<void> {
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

    const [updateResult] = await conn.query(
      `UPDATE ${TABLE}
         SET ${COLUMN} = ${backfillCase('viaMqtt = TRUE', c => c)}
       WHERE ${COLUMN} IS NULL`,
    );
    const affected = (updateResult as { affectedRows?: number } | null)?.affectedRows ?? 0;
    logger.info(`${LABEL} (MySQL): backfilled ${affected} rows`);
  } finally {
    conn.release();
  }
}
