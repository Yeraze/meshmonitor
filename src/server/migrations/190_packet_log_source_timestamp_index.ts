/**
 * Migration 190: `idx_packet_log_source_timestamp` on packet_log(sourceId,
 * timestamp) (#5557).
 *
 * The Live Mesh Activity dashboard widget polls
 * `GET /api/packets/stats/node-activity` every 10 s per open widget, and that
 * query filters `sourceId = ? AND timestamp >= ?`. The only existing
 * packet_log index is on `created_at`, so without this index every poll
 * scans the whole table. The table is bounded by the packet-log cap
 * (default 1000 rows, user-configurable upward), so the build is cheap.
 *
 * Column names: packet_log keeps snake_case columns on every backend, except
 * `sourceId` (added by migration 021), which is camelCase and must be quoted
 * on PostgreSQL. MySQL's `sourceId` is VARCHAR(36), so it indexes without a
 * prefix length.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createIndexIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 190';
export const PACKET_LOG_SOURCE_TIMESTAMP_INDEX = 'idx_packet_log_source_timestamp';
const INDEX = PACKET_LOG_SOURCE_TIMESTAMP_INDEX;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${INDEX}...`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON packet_log(sourceId, timestamp)`);
  },

  down: (db: Database): void => {
    db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration190Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${INDEX}...`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON packet_log("sourceId", timestamp)`);
}

// ============ MySQL ============

export async function runMigration190Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${INDEX}...`);
  await createIndexIfMissingMysql(
    pool,
    'packet_log',
    INDEX,
    `CREATE INDEX ${INDEX} ON packet_log(sourceId, timestamp)`,
  );
}
