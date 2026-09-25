/**
 * Migration 173: create `coverage_surveys` (Coverage Report epic #5277,
 * Phase 4b WP1).
 *
 * A saved coverage survey: "this sender, this time range" — name, canonical
 * sender id, start/end window (end null = live), an optional encoded
 * receiver-filter wire string (view preference only), an optional configured
 * broadcast interval for gap detection, free-text notes, and the creating
 * user. GLOBAL table (no `sourceId`) — see
 * `docs/internal/dev-notes/COVERAGE_P4_SPEC.md` §2b.1 for why (same shape as
 * the `automations` global-by-design exception in CLAUDE.md).
 *
 * `id` is a UUID text primary key (`crypto.randomUUID()`), **not** a serial —
 * see §2b.6 for the PG-sequence trap this avoids for backup/restore: a
 * restore that inserts explicit serial ids never resets the PG sequence, and
 * `insertIgnore`'s target-less `onConflictDoNothing()` would then silently
 * drop any later row whose id collides. A UUID PK sidesteps the whole class
 * of bug. `id` also serves as an opaque deep-link id (`?survey=<id>`).
 *
 * No backfill; the table starts empty and populates going forward only.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL. See
 * `docs/internal/dev-notes/COVERAGE_P4_SPEC.md` §2b.2/§2b.3 for the full
 * column table and index rationale.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import { createTableIfMissingMysql } from './helpers.js';

const LABEL = 'Migration 173';
const TABLE = 'coverage_surveys';
const SENDER_START_INDEX = 'cov_sv_sender_start_idx';
const CREATED_BY_INDEX = 'cov_sv_created_by_idx';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): creating ${TABLE}...`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        senderId TEXT NOT NULL,
        startAt INTEGER NOT NULL,
        endAt INTEGER,
        receivers TEXT,
        intervalSec INTEGER,
        notes TEXT,
        createdBy INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      )
    `);

    db.exec(`CREATE INDEX IF NOT EXISTS ${SENDER_START_INDEX} ON ${TABLE}(senderId, startAt)`);
    db.exec(`CREATE INDEX IF NOT EXISTS ${CREATED_BY_INDEX} ON ${TABLE}(createdBy)`);

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (db: Database): void => {
    logger.info(`${LABEL} down (SQLite): dropping ${TABLE}`);
    db.exec(`DROP TABLE IF EXISTS ${TABLE}`);
  },
};

// ============ PostgreSQL ============

export async function runMigration173Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): creating ${TABLE}...`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      "senderId" TEXT NOT NULL,
      "startAt" BIGINT NOT NULL,
      "endAt" BIGINT,
      receivers TEXT,
      "intervalSec" INTEGER,
      notes TEXT,
      "createdBy" INTEGER,
      "createdAt" BIGINT NOT NULL,
      "updatedAt" BIGINT NOT NULL
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS ${SENDER_START_INDEX} ON ${TABLE}("senderId", "startAt")`);
  await client.query(`CREATE INDEX IF NOT EXISTS ${CREATED_BY_INDEX} ON ${TABLE}("createdBy")`);

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration173Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): creating ${TABLE}...`);

  await createTableIfMissingMysql(pool, TABLE, `
    CREATE TABLE ${TABLE} (
      id VARCHAR(36) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      senderId VARCHAR(80) NOT NULL,
      startAt BIGINT NOT NULL,
      endAt BIGINT,
      receivers TEXT,
      intervalSec INT,
      notes TEXT,
      createdBy INT,
      createdAt BIGINT NOT NULL,
      updatedAt BIGINT NOT NULL,
      INDEX ${SENDER_START_INDEX} (senderId, startAt),
      INDEX ${CREATED_BY_INDEX} (createdBy)
    )
  `);

  logger.info(`${LABEL} complete (MySQL)`);
}
