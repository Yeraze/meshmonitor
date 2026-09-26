/**
 * Migration 175: likely-aircraft classification columns on `nodes`
 * (#5364/#5365 Phase 1 WP1, decision D1).
 *
 * New columns land on `nodes` rather than a side table: every node read path
 * (poll, /api/nodes, Dashboard per-source feed, unified merge, popups)
 * already selects `nodes.*`, so a side table would need a join in 4+ read
 * paths, its own delete cleanup, and its own source scoping. `nodes` already
 * has the composite PK `(nodeNum, sourceId)`, so the flag is per source for
 * free, and a node purge removes it automatically.
 *
 *   likelyAircraft       BOOLEAN  NULL  — true/false/unknown (never classified)
 *   aircraftBasis        TEXT     NULL  — 'agl' | 'msl' | 'unknown'
 *   groundElevation      REAL     NULL  — DEM metres at the classified point
 *   heightAboveGround    REAL     NULL  — altitude - groundElevation, signed
 *   aircraftClassifiedAt INTEGER  NULL  — ms epoch of the last write (backfill key)
 *
 * No DEFAULT, no index. `upsertNode` never writes these columns (like
 * `mobile`/`notes`) — only the aircraft-classification repository methods do.
 *
 * All five columns are pure additive `ADD COLUMN`, idempotent across
 * SQLite / PostgreSQL / MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 175';
const TABLE = 'nodes';

const COLS_SQLITE = [
  ['likelyAircraft', 'likelyAircraft INTEGER'],
  ['aircraftBasis', 'aircraftBasis TEXT'],
  ['groundElevation', 'groundElevation REAL'],
  ['heightAboveGround', 'heightAboveGround REAL'],
  ['aircraftClassifiedAt', 'aircraftClassifiedAt INTEGER'],
] as const;

const COLS_PG = [
  ['likelyAircraft', '"likelyAircraft" BOOLEAN'],
  ['aircraftBasis', '"aircraftBasis" TEXT'],
  ['groundElevation', '"groundElevation" DOUBLE PRECISION'],
  ['heightAboveGround', '"heightAboveGround" DOUBLE PRECISION'],
  ['aircraftClassifiedAt', '"aircraftClassifiedAt" BIGINT'],
] as const;

const COLS_MYSQL = [
  ['likelyAircraft', 'likelyAircraft BOOLEAN'],
  ['aircraftBasis', 'aircraftBasis VARCHAR(8)'],
  ['groundElevation', 'groundElevation DOUBLE'],
  ['heightAboveGround', 'heightAboveGround DOUBLE'],
  ['aircraftClassifiedAt', 'aircraftClassifiedAt BIGINT'],
] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding aircraft-classification columns to ${TABLE}...`);
    for (const [column, ddl] of COLS_SQLITE) {
      addColumnIfMissing(db, TABLE, column, ddl);
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration175Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding aircraft-classification columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_PG) {
    await addColumnIfMissingPostgres(client, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration175Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding aircraft-classification columns to ${TABLE}...`);
  for (const [column, ddl] of COLS_MYSQL) {
    await addColumnIfMissingMysql(pool, TABLE, column, ddl);
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
