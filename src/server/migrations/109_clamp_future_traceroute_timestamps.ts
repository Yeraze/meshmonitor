/**
 * Migration 109: Repair future-dated traceroute timestamps (#2768).
 *
 * The direct/TCP traceroute ingest path used to stamp a row's `timestamp` from
 * the node's device clock (`rxTime`). A node whose RTC is set ahead of real time
 * therefore produced a traceroute `timestamp` in the future, which the UI renders
 * as a negative "last traced" age (e.g. "-1676m ago"). The ingest path is fixed
 * to cap the device time at server time going forward; this one-shot migration
 * repairs rows already written.
 *
 * Every traceroute row also stores `createdAt` (the server `Date.now()` at insert,
 * which can never be in the future), so it is the authoritative "received at"
 * time. We clamp any row whose `timestamp` is later than its own `createdAt` back
 * down to `createdAt`. This also satisfies the field request to "clean the DB of
 * entries from the future" — no manual Database-Maintenance action needed.
 *
 * Naturally idempotent: after the update every row has `timestamp <= createdAt`,
 * so a re-run matches nothing. Only the `traceroutes` table is touched (the
 * source of the "last traced" display); `createdAt` itself is never modified.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 109 (SQLite): Clamping future-dated traceroute timestamps...');
    try {
      const result = db
        .prepare('UPDATE traceroutes SET timestamp = createdAt WHERE timestamp > createdAt')
        .run();
      logger.info(`Migration 109 complete (SQLite): clamped ${result.changes} future traceroute timestamp(s)`);
    } catch (e: any) {
      logger.warn('Migration 109 (SQLite): could not clamp traceroute timestamps:', e.message);
    }
  },

  down: (_db: Database): void => {
    logger.debug('Migration 109 down: Not implemented (original future timestamps are not recoverable)');
  },
};

// ============ PostgreSQL ============

export async function runMigration109Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info('Running migration 109 (PostgreSQL): Clamping future-dated traceroute timestamps...');
  try {
    const result = await client.query(
      'UPDATE traceroutes SET "timestamp" = "createdAt" WHERE "timestamp" > "createdAt"',
    );
    logger.info(`Migration 109 complete (PostgreSQL): clamped ${result.rowCount ?? 0} future traceroute timestamp(s)`);
  } catch (error: any) {
    logger.error('Migration 109 (PostgreSQL) failed:', error.message);
    throw error;
  }
}

// ============ MySQL ============

export async function runMigration109Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info('Running migration 109 (MySQL): Clamping future-dated traceroute timestamps...');
  try {
    // `timestamp` is a MySQL keyword — backtick the column names.
    const [result] = await pool.query(
      'UPDATE traceroutes SET `timestamp` = `createdAt` WHERE `timestamp` > `createdAt`',
    );
    const changed = (result as { affectedRows?: number }).affectedRows ?? 0;
    logger.info(`Migration 109 complete (MySQL): clamped ${changed} future traceroute timestamp(s)`);
  } catch (error: any) {
    logger.error('Migration 109 (MySQL) failed:', error.message);
    throw error;
  }
}
