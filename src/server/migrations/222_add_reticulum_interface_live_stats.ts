/**
 * Migration 222: add live RNode interface-gauge columns to
 * `reticulum_interfaces` (issue #6120).
 *
 * RNS's `Reticulum.get_interface_stats()` reports these for an RNode LoRa
 * interface (attach OR own mode) — airtime, channel load, noise floor,
 * interference (+ its last timestamp/dBm), CPU load, and battery state/percent
 * (`RNS/Reticulum.py` ~L1534-1562). The bridge drops them today; this adds the
 * columns so the Info page's interface-status card and the source header can
 * surface them. Non-RNode interfaces never report them, so every column is
 * nullable and stays NULL for those rows.
 *
 * Units are stored exactly as RNS returns them (and as `rnstatus` prints):
 * airtime/channel-load/cpu-load are percentages, noise-floor/interference are
 * dBm, battery-percent is 0-100, and `interferenceLastTs` is RNS epoch SECONDS.
 *
 * All eleven columns are nullable. Idempotent across SQLite / PostgreSQL /
 * MySQL via the shared helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 222';
const TABLE = 'reticulum_interfaces';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding live interface-gauge columns to ${TABLE}...`);
    addColumnIfMissing(db, TABLE, 'airtimeShort', 'airtimeShort REAL');
    addColumnIfMissing(db, TABLE, 'airtimeLong', 'airtimeLong REAL');
    addColumnIfMissing(db, TABLE, 'channelLoadShort', 'channelLoadShort REAL');
    addColumnIfMissing(db, TABLE, 'channelLoadLong', 'channelLoadLong REAL');
    addColumnIfMissing(db, TABLE, 'noiseFloor', 'noiseFloor REAL');
    addColumnIfMissing(db, TABLE, 'interference', 'interference REAL');
    addColumnIfMissing(db, TABLE, 'interferenceLastTs', 'interferenceLastTs REAL');
    addColumnIfMissing(db, TABLE, 'interferenceLastDbm', 'interferenceLastDbm REAL');
    addColumnIfMissing(db, TABLE, 'cpuLoad', 'cpuLoad REAL');
    addColumnIfMissing(db, TABLE, 'batteryState', 'batteryState TEXT');
    addColumnIfMissing(db, TABLE, 'batteryPercent', 'batteryPercent REAL');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration222Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding live interface-gauge columns to ${TABLE}...`);
  await addColumnIfMissingPostgres(client, TABLE, 'airtimeShort', '"airtimeShort" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'airtimeLong', '"airtimeLong" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'channelLoadShort', '"channelLoadShort" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'channelLoadLong', '"channelLoadLong" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'noiseFloor', '"noiseFloor" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'interference', '"interference" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'interferenceLastTs', '"interferenceLastTs" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'interferenceLastDbm', '"interferenceLastDbm" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'cpuLoad', '"cpuLoad" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'batteryState', '"batteryState" TEXT');
  await addColumnIfMissingPostgres(client, TABLE, 'batteryPercent', '"batteryPercent" DOUBLE PRECISION');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration222Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding live interface-gauge columns to ${TABLE}...`);
  await addColumnIfMissingMysql(pool, TABLE, 'airtimeShort', 'airtimeShort DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'airtimeLong', 'airtimeLong DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'channelLoadShort', 'channelLoadShort DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'channelLoadLong', 'channelLoadLong DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'noiseFloor', 'noiseFloor DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'interference', 'interference DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'interferenceLastTs', 'interferenceLastTs DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'interferenceLastDbm', 'interferenceLastDbm DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'cpuLoad', 'cpuLoad DOUBLE');
  await addColumnIfMissingMysql(pool, TABLE, 'batteryState', 'batteryState VARCHAR(32)');
  await addColumnIfMissingMysql(pool, TABLE, 'batteryPercent', 'batteryPercent DOUBLE');
  logger.info(`${LABEL} complete (MySQL)`);
}
