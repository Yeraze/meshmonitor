/**
 * Migration 225: persisted security flags on `meshcore_nodes` (#6281, P7b).
 *
 *   isExcessivePackets     boolean, default false   packets/hour over the threshold
 *   packetRatePerHour      int                      distinct packets in the last hour
 *   advertRatePerHour      int                      of which adverts
 *   packetRateLastChecked  bigint (ms)
 *   isTimeOffsetIssue      boolean, default false   clock off by more than the threshold
 *   timeOffsetSeconds      int                      receipt minus sender time (s)
 *   timeOffsetSource       text / varchar(16)       'advert' | 'message'
 *   timeOffsetCheckedAt    bigint (ms)
 *
 * Only the security scanner and the clear route write them; `upsertNode` never
 * does. All nullable or default false, no backfill. Idempotent on all three
 * backends through the shared add-column helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 225';
const TABLE = 'meshcore_nodes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE} security flag columns...`);
    addColumnIfMissing(db, TABLE, 'isExcessivePackets', 'isExcessivePackets INTEGER DEFAULT 0');
    addColumnIfMissing(db, TABLE, 'packetRatePerHour', 'packetRatePerHour INTEGER');
    addColumnIfMissing(db, TABLE, 'advertRatePerHour', 'advertRatePerHour INTEGER');
    addColumnIfMissing(db, TABLE, 'packetRateLastChecked', 'packetRateLastChecked INTEGER');
    addColumnIfMissing(db, TABLE, 'isTimeOffsetIssue', 'isTimeOffsetIssue INTEGER DEFAULT 0');
    addColumnIfMissing(db, TABLE, 'timeOffsetSeconds', 'timeOffsetSeconds INTEGER');
    addColumnIfMissing(db, TABLE, 'timeOffsetSource', 'timeOffsetSource TEXT');
    addColumnIfMissing(db, TABLE, 'timeOffsetCheckedAt', 'timeOffsetCheckedAt INTEGER');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration225Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE} security flag columns...`);
  await addColumnIfMissingPostgres(client, TABLE, 'isExcessivePackets', '"isExcessivePackets" BOOLEAN DEFAULT false');
  await addColumnIfMissingPostgres(client, TABLE, 'packetRatePerHour', '"packetRatePerHour" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'advertRatePerHour', '"advertRatePerHour" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'packetRateLastChecked', '"packetRateLastChecked" BIGINT');
  await addColumnIfMissingPostgres(client, TABLE, 'isTimeOffsetIssue', '"isTimeOffsetIssue" BOOLEAN DEFAULT false');
  await addColumnIfMissingPostgres(client, TABLE, 'timeOffsetSeconds', '"timeOffsetSeconds" INTEGER');
  await addColumnIfMissingPostgres(client, TABLE, 'timeOffsetSource', '"timeOffsetSource" TEXT');
  await addColumnIfMissingPostgres(client, TABLE, 'timeOffsetCheckedAt', '"timeOffsetCheckedAt" BIGINT');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration225Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE} security flag columns...`);
  await addColumnIfMissingMysql(pool, TABLE, 'isExcessivePackets', 'isExcessivePackets BOOLEAN DEFAULT false');
  await addColumnIfMissingMysql(pool, TABLE, 'packetRatePerHour', 'packetRatePerHour INT');
  await addColumnIfMissingMysql(pool, TABLE, 'advertRatePerHour', 'advertRatePerHour INT');
  await addColumnIfMissingMysql(pool, TABLE, 'packetRateLastChecked', 'packetRateLastChecked BIGINT');
  await addColumnIfMissingMysql(pool, TABLE, 'isTimeOffsetIssue', 'isTimeOffsetIssue BOOLEAN DEFAULT false');
  await addColumnIfMissingMysql(pool, TABLE, 'timeOffsetSeconds', 'timeOffsetSeconds INT');
  await addColumnIfMissingMysql(pool, TABLE, 'timeOffsetSource', 'timeOffsetSource VARCHAR(16)');
  await addColumnIfMissingMysql(pool, TABLE, 'timeOffsetCheckedAt', 'timeOffsetCheckedAt BIGINT');
  logger.info(`${LABEL} complete (MySQL)`);
}
