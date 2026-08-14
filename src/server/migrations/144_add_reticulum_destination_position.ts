/**
 * Migration 144: add position columns to `reticulum_destinations` (Reticulum
 * epic #3960, Phase 3 WP3).
 *
 * Deferred from Phase 1a (see `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md`
 * §3.1) — Sideband clients embed a `SID_LOCATION` sample inside LXMF
 * `FIELD_TELEMETRY` payloads (see `docs/internal/dev-notes/RETICULUM_PHASE3_BUILD_SPEC.md`
 * §2.A/§3). Reticulum position is peer-shared per-source and LATEST-ONLY —
 * unlike Meshtastic's `estimated_positions`, there is no history table and no
 * global batch estimator; `ReticulumManager.handleTelemetry` overwrites these
 * six columns (+ `positionUpdatedAt`) directly on the owning destination row.
 *
 * All seven columns are nullable: most destinations never share a position at
 * all, and existing rows predate this migration.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 144';
const TABLE = 'reticulum_destinations';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding position columns to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'latitude', 'latitude REAL');
    addColumnIfMissing(db, TABLE, 'longitude', 'longitude REAL');
    addColumnIfMissing(db, TABLE, 'altitude', 'altitude REAL');
    addColumnIfMissing(db, TABLE, 'speed', 'speed REAL');
    addColumnIfMissing(db, TABLE, 'bearing', 'bearing REAL');
    addColumnIfMissing(db, TABLE, 'accuracy', 'accuracy REAL');
    addColumnIfMissing(db, TABLE, 'positionUpdatedAt', 'positionUpdatedAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration144Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding position columns to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'latitude', '"latitude" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'longitude', '"longitude" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'altitude', '"altitude" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'speed', '"speed" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'bearing', '"bearing" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'accuracy', '"accuracy" DOUBLE PRECISION');
  // ms-epoch timestamps overflow 32-bit INTEGER; JS Date.now() is ~1.8e12.
  await addColumnIfMissingPostgres(client, TABLE, 'positionUpdatedAt', '"positionUpdatedAt" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration144Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding position columns to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'latitude', 'latitude DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'longitude', 'longitude DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'altitude', 'altitude DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'speed', 'speed DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'bearing', 'bearing DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'accuracy', 'accuracy DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'positionUpdatedAt', 'positionUpdatedAt BIGINT');
  logger.info(`${LABEL} complete (MySQL)`);
}
