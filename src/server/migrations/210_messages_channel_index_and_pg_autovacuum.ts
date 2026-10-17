/**
 * Migration 210 (issue #5870): database performance on busy installs.
 *
 * 1. `idx_messages_source_channel_ts` on messages(sourceId, channel, timestamp),
 *    all three backends. The MQTT-source channel list groups a source's
 *    messages by channel with COUNT and MAX(timestamp)
 *    (`MessagesRepository.getDistinctChannelsForSource`); without this index
 *    that is a full scan of the source's rows on every Channels-tab load.
 *
 * 2. PostgreSQL only: per-table autovacuum thresholds on the high-churn
 *    tables. The default scale factor (0.2) waits for 20% of a table to be
 *    dead rows, so a 1.75M-row `route_segments` was never vacuumed on a
 *    production instance. 0.05 / 0.02 vacuums and analyzes these tables
 *    about four to ten times as often. Storage parameters only: no rewrite,
 *    and ALTER TABLE ... SET takes a lock that does not block reads or writes.
 *
 * Idempotent: CREATE INDEX IF NOT EXISTS (MySQL via the information_schema
 * helper), and SET on a storage parameter is a plain overwrite.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createIndexIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 210';
const INDEX = 'idx_messages_source_channel_ts';

/** Tables that take a constant stream of inserts and deletes. */
export const AUTOVACUUM_TABLES = ['telemetry', 'route_segments', 'nodes', 'messages', 'audit_log', 'packet_log'] as const;
const AUTOVACUUM_SETTINGS = 'autovacuum_vacuum_scale_factor = 0.05, autovacuum_analyze_scale_factor = 0.02';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${INDEX}...`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${INDEX} ON messages(sourceId, channel, timestamp)`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    db.exec(`DROP INDEX IF EXISTS ${INDEX}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration210Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${INDEX} and autovacuum thresholds...`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${INDEX} ON messages("sourceId", channel, timestamp)`);
  for (const table of AUTOVACUUM_TABLES) {
    const exists = await client.query(`SELECT to_regclass($1) AS oid`, [`public.${table}`]);
    if (!exists.rows[0]?.oid) continue;
    await client.query(`ALTER TABLE ${table} SET (${AUTOVACUUM_SETTINGS})`);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration210Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${INDEX}...`);
  await createIndexIfMissingMysql(
    pool,
    'messages',
    INDEX,
    `CREATE INDEX ${INDEX} ON messages(sourceId, channel, timestamp)`,
  );
  logger.info(`${LABEL} complete (MySQL)`);
}
