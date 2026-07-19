/**
 * Migration 125: Add `xeddsa_signed` column to `packet_log`.
 *
 * Firmware 2.8 adds XEdDSA packet signing; a verified signed broadcast
 * carries `MeshPacket.xeddsa_signed = true` on the wire (protobufs
 * 2.8-preview pin, #4205). This column persists that flag per logged packet
 * so the Packet Monitor can render a signature shield and filter on it
 * (issue #3923), mirroring the green-shield indicator in the official
 * mobile apps.
 *
 * Semantics:
 *   NULL  → unknown (packet logged before this feature, or pre-2.8 firmware
 *           that never sets the field)
 *   0     → decoded packet, not signed / signature not verified
 *   1     → device reported a valid XEdDSA signature
 *
 * No backfill: the flag only exists on packets received after 2.8 firmware
 * appears; historical rows stay NULL (unknown), which the UI renders as no
 * indicator.
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

const LABEL = 'Migration 125';
const TABLE = 'packet_log';
const COLUMN = 'xeddsa_signed';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `${COLUMN} INTEGER`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3923 pg PoolClient: migration signature convention (matches helpers.ts)
export async function runMigration125Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN`);
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3923 mysql2 Pool: migration signature convention (matches helpers.ts)
export async function runMigration125Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} BOOLEAN`);
}
