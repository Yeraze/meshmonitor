/**
 * Migration 225: create `meshcore_trace_runs` (issue #6276, P14 WP4).
 *
 * An attempt log of the MeshCore traces a source's Companion SENT: target,
 * path, origin and outcome (answered, timeout, failed). `meshcore_hop_snr`
 * keeps only traces that came back, so a timeout used to leave no trace and the
 * Traceroute Explorer could not show an answer rate or the real destination.
 * PER-SOURCE — every row carries a `sourceId`.
 *
 * Idempotent on all three backends: pure `CREATE ... IF NOT EXISTS` (MySQL via
 * the information_schema helper). No backfill; the table fills from live traces.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 225';
const TABLE = 'meshcore_trace_runs';
const TIME_INDEX = 'meshcore_trace_runs_time_idx';
const TAG_INDEX = 'meshcore_trace_runs_tag_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sourceId TEXT NOT NULL,
        traceTag INTEGER NOT NULL,
        authCode INTEGER NOT NULL,
        targetPublicKey TEXT,
        pathHex TEXT NOT NULL,
        hashBytes INTEGER NOT NULL,
        autoReturn INTEGER NOT NULL,
        origin TEXT NOT NULL,
        status TEXT NOT NULL,
        sentAt INTEGER NOT NULL,
        completedAt INTEGER
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS ${TIME_INDEX} ON ${TABLE}(sourceId, sentAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${TAG_INDEX} ON ${TABLE}(sourceId, traceTag, authCode)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration225Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id SERIAL PRIMARY KEY,
      "sourceId" TEXT NOT NULL,
      "traceTag" BIGINT NOT NULL,
      "authCode" BIGINT NOT NULL,
      "targetPublicKey" TEXT,
      "pathHex" TEXT NOT NULL,
      "hashBytes" INTEGER NOT NULL,
      "autoReturn" BOOLEAN NOT NULL,
      origin TEXT NOT NULL,
      status TEXT NOT NULL,
      "sentAt" BIGINT NOT NULL,
      "completedAt" BIGINT
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS ${TIME_INDEX} ON ${TABLE}("sourceId", "sentAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${TAG_INDEX} ON ${TABLE}("sourceId", "traceTag", "authCode")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration225Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sourceId VARCHAR(64) NOT NULL,
      traceTag BIGINT NOT NULL,
      authCode BIGINT NOT NULL,
      targetPublicKey VARCHAR(64),
      pathHex VARCHAR(512) NOT NULL,
      hashBytes INT NOT NULL,
      autoReturn BOOLEAN NOT NULL,
      origin VARCHAR(16) NOT NULL,
      status VARCHAR(16) NOT NULL,
      sentAt BIGINT NOT NULL,
      completedAt BIGINT,
      INDEX ${TIME_INDEX} (sourceId, sentAt),
      INDEX ${TAG_INDEX} (sourceId, traceTag, authCode)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
