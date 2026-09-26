/**
 * Migration 178: `firstHeard` on `nodes` and `meshcore_nodes` (#5390).
 *
 *   nodes.firstHeard           INTEGER/BIGINT NULL — Unix SECONDS (same unit as nodes.lastHeard)
 *   meshcore_nodes.firstHeard  INTEGER/BIGINT NULL — epoch MILLISECONDS (same unit as meshcore_nodes.lastHeard)
 *
 * Each column follows its own table's `lastHeard` unit so a row's two stamps
 * compare directly. Both are per-source because both tables are keyed by
 * sourceId. After this migration the repositories stamp `firstHeard` once, from
 * the first plausible `lastHeard` a write carries, and never overwrite it.
 *
 * `createdAt` alone is not an honest "first heard": it is set by any INSERT —
 * a message that only references a node, a contact-URL import, a MeshCore
 * contact record for a node never heard on air — so the new column exists.
 *
 * Backfill (existing rows only, rows with firstHeard still NULL): a node that
 * has a `lastHeard` has been heard. Its first reception is no later than the
 * earlier of `createdAt` (when MeshMonitor first stored it) and `lastHeard`,
 * so we take the earlier of the two, ignoring either value when it is
 * implausible (before 2020, or more than a day in the future — MeshCore RTC
 * drift, #5339). Rows never heard (`lastHeard` NULL/0) stay NULL = "unknown".
 * The `firstHeard IS NULL` guard makes a re-run a no-op for stamped rows.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 178';

/** 2020-01-01T00:00:00Z. Neither firmware existed before this. */
const MIN_PLAUSIBLE_SEC = 1_577_836_800;
const MAX_FUTURE_SKEW_SEC = 24 * 60 * 60;

type Dialect = 'sqlite' | 'postgres' | 'mysql';

function quote(dialect: Dialect, col: string): string {
  return dialect === 'postgres' ? `"${col}"` : col;
}

/**
 * Build the backfill UPDATE for one table.
 *
 * @param unitMs true when the table stores lastHeard/firstHeard in ms
 *   (meshcore_nodes), false for seconds (nodes).
 */
export function buildBackfillSql(dialect: Dialect, table: string, unitMs: boolean, nowMs: number): string {
  const fh = quote(dialect, 'firstHeard');
  const lh = quote(dialect, 'lastHeard');
  const ca = quote(dialect, 'createdAt');
  const scale = unitMs ? 1000 : 1;
  const min = MIN_PLAUSIBLE_SEC * scale;
  const max = unitMs
    ? nowMs + MAX_FUTURE_SKEW_SEC * 1000
    : Math.floor(nowMs / 1000) + MAX_FUTURE_SKEW_SEC;

  // createdAt is always ms in both tables. For the seconds table, convert with
  // integer division (MySQL's `/` yields a DECIMAL, so it needs DIV).
  const createdAtInUnit = unitMs
    ? ca
    : dialect === 'mysql'
      ? `(${ca} DIV 1000)`
      : `(${ca} / 1000)`;

  const lhOk = `(${lh} >= ${min} AND ${lh} <= ${max})`;
  const caOk = `(${createdAtInUnit} >= ${min} AND ${createdAtInUnit} <= ${max})`;

  return `UPDATE ${table} SET ${fh} = CASE
      WHEN ${lhOk} AND ${caOk} THEN (CASE WHEN ${lh} < ${createdAtInUnit} THEN ${lh} ELSE ${createdAtInUnit} END)
      WHEN ${lhOk} THEN ${lh}
      WHEN ${caOk} THEN ${createdAtInUnit}
      ELSE NULL END
    WHERE ${fh} IS NULL AND ${lh} IS NOT NULL AND ${lh} > 0`;
}

const TABLES = [
  { table: 'nodes', unitMs: false },
  { table: 'meshcore_nodes', unitMs: true },
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding firstHeard to nodes and meshcore_nodes...`);
    const nowMs = Date.now();
    for (const { table, unitMs } of TABLES) {
      addColumnIfMissing(db, table, 'firstHeard', 'firstHeard INTEGER');
      const res = db.prepare(buildBackfillSql('sqlite', table, unitMs, nowMs)).run();
      logger.info(`${LABEL} (SQLite): backfilled firstHeard on ${res.changes} ${table} rows`);
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration178Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding firstHeard to nodes and meshcore_nodes...`);
  const nowMs = Date.now();
  for (const { table, unitMs } of TABLES) {
    await addColumnIfMissingPostgres(client, table, 'firstHeard', '"firstHeard" BIGINT');
    const res = await client.query(buildBackfillSql('postgres', table, unitMs, nowMs));
    logger.info(`${LABEL} (PostgreSQL): backfilled firstHeard on ${res.rowCount ?? 0} ${table} rows`);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration178Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding firstHeard to nodes and meshcore_nodes...`);
  const nowMs = Date.now();
  for (const { table, unitMs } of TABLES) {
    await addColumnIfMissingMysql(pool, table, 'firstHeard', 'firstHeard BIGINT');
    const [res] = await pool.query(buildBackfillSql('mysql', table, unitMs, nowMs));
    const affected = (res as { affectedRows?: number }).affectedRows ?? 0;
    logger.info(`${LABEL} (MySQL): backfilled firstHeard on ${affected} ${table} rows`);
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
