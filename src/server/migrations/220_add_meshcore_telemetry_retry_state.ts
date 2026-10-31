/**
 * Migration 220: meshcore_nodes retry-burst / cooldown state (#6033).
 *
 * Adds three columns the MeshCoreRemoteTelemetryScheduler uses to turn a
 * single missed/timed-out scheduled telemetry pull into a short retry burst
 * followed by a cooldown, instead of waiting a whole interval:
 *   - lastTelemetrySuccessAt  (epoch ms) — last poll that returned rows.
 *   - telemetryMissCount      — consecutive empty/timeout count (default 0).
 *   - telemetryCooldownUntil  (epoch ms) — eligibility blocked until it passes.
 *
 * All nullable (miss-count defaults 0) so existing rows carry no retry state
 * and behave exactly as before until the scheduler first touches them.
 * Idempotent across SQLite / PostgreSQL / MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 220';
const TABLE = 'meshcore_nodes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE} telemetry retry-state columns...`);
    addColumnIfMissing(db, TABLE, 'lastTelemetrySuccessAt', 'lastTelemetrySuccessAt INTEGER');
    addColumnIfMissing(db, TABLE, 'telemetryMissCount', 'telemetryMissCount INTEGER DEFAULT 0');
    addColumnIfMissing(db, TABLE, 'telemetryCooldownUntil', 'telemetryCooldownUntil INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration220Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE} telemetry retry-state columns...`);
  await addColumnIfMissingPostgres(client, TABLE, 'lastTelemetrySuccessAt', '"lastTelemetrySuccessAt" BIGINT');
  await addColumnIfMissingPostgres(client, TABLE, 'telemetryMissCount', '"telemetryMissCount" INTEGER DEFAULT 0');
  await addColumnIfMissingPostgres(client, TABLE, 'telemetryCooldownUntil', '"telemetryCooldownUntil" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration220Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE} telemetry retry-state columns...`);
  await addColumnIfMissingMysql(pool, TABLE, 'lastTelemetrySuccessAt', 'lastTelemetrySuccessAt BIGINT');
  await addColumnIfMissingMysql(pool, TABLE, 'telemetryMissCount', 'telemetryMissCount INT DEFAULT 0');
  await addColumnIfMissingMysql(pool, TABLE, 'telemetryCooldownUntil', 'telemetryCooldownUntil BIGINT');
  logger.info(`${LABEL} complete (MySQL)`);
}
