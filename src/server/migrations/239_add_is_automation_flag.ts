/**
 * Migration 239: Add the Meshtastic `is_automation` flag to `messages`
 * (`isAutomation`) and `packet_log` (`is_automation`) — issue #6449.
 *
 * meshtastic/protobufs#1134 reserves bit 2 (0x04) of `Data.bitfield` as
 * `is_automation`: the sender says a bot or script sent the packet, not a
 * person. The flag is self-reported and advisory.
 *
 * Semantics (both columns):
 *   NULL  → unknown (bitfield absent on the wire, or row stored before this)
 *   0     → bitfield present, bit 2 clear
 *   1     → bitfield present, bit 2 set
 *
 * Column names follow each table's existing convention, the same as the
 * XEdDSA flag: camelCase `isAutomation` on `messages` (migration 140),
 * snake_case `is_automation` on `packet_log` (migration 125).
 *
 * No backfill. Idempotent across SQLite / PostgreSQL / MySQL via the helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 239';
const COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: 'messages', column: 'isAutomation' },
  { table: 'packet_log', column: 'is_automation' },
];

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    for (const { table, column } of COLUMNS) {
      logger.info(`${LABEL} (SQLite): adding ${table}.${column}...`);
      addColumnIfMissing(db, table, column, `"${column}" INTEGER`);
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #6449 pg PoolClient: migration signature convention (matches helpers.ts)
export async function runMigration239Postgres(client: any): Promise<void> {
  for (const { table, column } of COLUMNS) {
    logger.info(`${LABEL} (PostgreSQL): adding ${table}.${column}...`);
    await addColumnIfMissingPostgres(client, table, column, `"${column}" BOOLEAN`);
  }
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #6449 mysql2 Pool: migration signature convention (matches helpers.ts)
export async function runMigration239Mysql(pool: any): Promise<void> {
  for (const { table, column } of COLUMNS) {
    logger.info(`${LABEL} (MySQL): adding ${table}.${column}...`);
    await addColumnIfMissingMysql(pool, table, column, `\`${column}\` BOOLEAN`);
  }
}
