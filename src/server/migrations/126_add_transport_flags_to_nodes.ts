/**
 * Migration 126: Add per-transport "last seen" timestamps to `nodes`.
 *
 * Migration 066 lifted the MOST-RECENT `MeshPacket.transport_mechanism` onto
 * the node row. A single last-wins column cannot express "this node is
 * reachable over RF *and* MQTT", which is the common case: when the local node
 * has an MQTT uplink it receives echoes of the same RF traffic flagged
 * `viaMqtt`, so a last-wins column thrashes and MQTT wins whenever an echo
 * lands last. The node then disappears from the map, because the "Show MQTT"
 * toggle defaults to off (#3112). That is #4240.
 *
 * Rather than a set of sticky booleans, each transport records WHEN the node
 * was last heard over it (unix seconds, NULL = never). That gives the map an
 * OR across transports *and* natural decay: a transport counts as current only
 * if its timestamp is inside the user's configured active window
 * (`maxNodeAgeHours`). A node that stops being heard over RF stops being an RF
 * node on its own, with no sweep job and no extra bookkeeping.
 *
 * Backfill uses the node's existing `lastHeard` as the best available evidence
 * of when it was last seen on its currently-classified transport, mirroring
 * `classifyNodeTransport` so nothing changes visibility at migration time.
 * Rows with a NULL `lastHeard` get NULL timestamps and fall back to the legacy
 * single-value classification at read time.
 *
 * `transportMechanism` is retained for "most recently heard via" display.
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

const COL_RF = 'transportLastRf';
const COL_MQTT = 'transportLastMqtt';
const COL_UDP = 'transportLastUdp';
const COLUMNS = [COL_RF, COL_MQTT, COL_UDP] as const;

const TX_MQTT = 5;
const TX_UDP = 6;

/**
 * Backfill each column with `lastHeard` when the node's legacy classification
 * matches that transport, else NULL. `q` quotes identifiers per backend and
 * `viaMqttTrue` is the backend-specific truthy comparison.
 *
 * The CASE arms mirror `classifyNodeTransport` exactly, including its
 * "INTERNAL / API / unknown falls back to viaMqtt, else RF" tail.
 */
function backfillExpr(column: string, viaMqttTrue: string, q: (c: string) => string): string {
  const tx = q('transportMechanism');
  const lastHeard = q('lastHeard');
  const isMqtt = `(${tx} = ${TX_MQTT} OR (${tx} IS NULL AND ${viaMqttTrue}) OR (${tx} IN (0, 7) AND ${viaMqttTrue}))`;
  const isUdp = `${tx} = ${TX_UDP}`;
  // RF is the residual: everything that is neither MQTT nor UDP.
  const isRf = `NOT (${isMqtt}) AND NOT (${isUdp})`;

  const predicate = column === COL_MQTT ? isMqtt : column === COL_UDP ? isUdp : isRf;
  return `CASE WHEN ${predicate} THEN ${lastHeard} ELSE NULL END`;
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding per-transport last-seen columns...`);
    for (const column of COLUMNS) {
      try {
        db.exec(`ALTER TABLE ${TABLE} ADD COLUMN ${column} INTEGER`);
        logger.debug(`${LABEL} (SQLite): added ${TABLE}.${column}`);
      } catch (e: unknown) {
        if (errMessage(e).includes('duplicate column')) {
          logger.debug(`${LABEL} (SQLite): ${TABLE}.${column} already present, skipping ADD`);
        } else {
          logger.error(`${LABEL} (SQLite): could not add ${TABLE}.${column}:`, errMessage(e));
          throw e;
        }
      }
    }

    try {
      // Guarded so a crash-rerun cannot clobber timestamps live traffic has
      // already written. Only rows where ALL THREE are still NULL are touched.
      const sets = COLUMNS
        .map(c => `${c} = ${backfillExpr(c, 'viaMqtt = 1', x => x)}`)
        .join(', ');
      const result = db
        .prepare(
          `UPDATE ${TABLE} SET ${sets}
            WHERE ${COL_RF} IS NULL AND ${COL_MQTT} IS NULL AND ${COL_UDP} IS NULL`,
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
  logger.info(`${LABEL} (PostgreSQL): adding per-transport last-seen columns...`);
  for (const column of COLUMNS) {
    await client.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS "${column}" BIGINT`);
  }
  const q = (c: string) => `"${c}"`;
  const sets = COLUMNS.map(c => `"${c}" = ${backfillExpr(c, '"viaMqtt" = TRUE', q)}`).join(', ');
  const result = await client.query(
    `UPDATE ${TABLE} SET ${sets}
      WHERE "${COL_RF}" IS NULL AND "${COL_MQTT}" IS NULL AND "${COL_UDP}" IS NULL`,
  );
  logger.info(`${LABEL} (PostgreSQL): backfilled ${result.rowCount ?? 0} rows`);
}

// ============ MySQL ============

export async function runMigration126Mysql(pool: MysqlPoolLike): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding per-transport last-seen columns...`);
  const conn = await pool.getConnection();
  try {
    for (const column of COLUMNS) {
      const [rows] = await conn.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
        [TABLE, column],
      );
      if (Array.isArray(rows) && rows.length === 0) {
        await conn.query(`ALTER TABLE ${TABLE} ADD COLUMN ${column} BIGINT`);
        logger.debug(`${LABEL} (MySQL): added ${TABLE}.${column}`);
      } else {
        logger.debug(`${LABEL} (MySQL): ${TABLE}.${column} already present, skipping ADD`);
      }
    }

    const sets = COLUMNS.map(c => `${c} = ${backfillExpr(c, 'viaMqtt = TRUE', x => x)}`).join(', ');
    const [updateResult] = await conn.query(
      `UPDATE ${TABLE} SET ${sets}
        WHERE ${COL_RF} IS NULL AND ${COL_MQTT} IS NULL AND ${COL_UDP} IS NULL`,
    );
    const affected = (updateResult as { affectedRows?: number } | null)?.affectedRows ?? 0;
    logger.info(`${LABEL} (MySQL): backfilled ${affected} rows`);
  } finally {
    conn.release();
  }
}
