/**
 * Migration 145: add own-mode radio-config + device-info columns to
 * `reticulum_interfaces` (Reticulum epic #3960, Phase 3 WP3).
 *
 * Deferred from Phase 1a (see `docs/internal/dev-notes/RETICULUM_PHASE1A_BUILD_SPEC.md`
 * §3.1) — Phase 3 introduces own mode, where the bridge drives an RNodeInterface
 * directly and can read/set its LoRa radio parameters (see
 * `docs/internal/dev-notes/RETICULUM_PHASE3_BUILD_SPEC.md` §2.B/§3/§R2).
 * Written ONLY when the source is running in own mode; attach/tcp_peer
 * sources leave every column here NULL.
 *
 * `deviceInfoJson` is a single loose JSON-text column (R2: avoids a churny
 * per-field migration for read-only RNode board/firmware info) — mirrors the
 * `fields` JSON-text convention already used on `reticulum_messages`
 * (migration 143).
 *
 * All nine columns are nullable. Idempotent across SQLite / PostgreSQL /
 * MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 145';
const TABLE = 'reticulum_interfaces';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding radio-config columns to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'frequency', 'frequency REAL');
    addColumnIfMissing(db, TABLE, 'bandwidth', 'bandwidth REAL');
    addColumnIfMissing(db, TABLE, 'spreadingFactor', 'spreadingFactor INTEGER');
    addColumnIfMissing(db, TABLE, 'codingRate', 'codingRate INTEGER');
    addColumnIfMissing(db, TABLE, 'txPower', 'txPower INTEGER');
    addColumnIfMissing(db, TABLE, 'stAlock', 'stAlock REAL');
    addColumnIfMissing(db, TABLE, 'ltAlock', 'ltAlock REAL');
    addColumnIfMissing(db, TABLE, 'radioState', 'radioState INTEGER');
    addColumnIfMissing(db, TABLE, 'deviceInfoJson', 'deviceInfoJson TEXT');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration145Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding radio-config columns to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'frequency', '"frequency" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'bandwidth', '"bandwidth" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'spreadingFactor', '"spreadingFactor" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'codingRate', '"codingRate" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'txPower', '"txPower" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'stAlock', '"stAlock" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'ltAlock', '"ltAlock" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'radioState', '"radioState" BOOLEAN');
  await addColumnIfMissingPostgres(client, TABLE, 'deviceInfoJson', '"deviceInfoJson" TEXT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration145Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding radio-config columns to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'frequency', 'frequency DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'bandwidth', 'bandwidth DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'spreadingFactor', 'spreadingFactor INT');
  await addColumnIfMissingMysql(pool, TABLE, 'codingRate', 'codingRate INT');
  await addColumnIfMissingMysql(pool, TABLE, 'txPower', 'txPower INT');
  await addColumnIfMissingMysql(pool, TABLE, 'stAlock', 'stAlock DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'ltAlock', 'ltAlock DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'radioState', 'radioState TINYINT(1)');
  await addColumnIfMissingMysql(pool, TABLE, 'deviceInfoJson', 'deviceInfoJson TEXT');
  logger.info(`${LABEL} complete (MySQL)`);
}
