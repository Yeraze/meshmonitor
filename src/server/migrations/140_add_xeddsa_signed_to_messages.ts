/**
 * Migration 140: Add `xeddsaSigned` column to the `messages` table.
 *
 * Firmware 2.8 adds XEdDSA broadcast signing; a verified signed broadcast
 * carries `MeshPacket.xeddsa_signed = true` on the wire. Migration 125 already
 * persists that flag per logged packet for the Packet Monitor — this column is
 * the message-level counterpart, so the shield indicator survives a reload in
 * the message list and reception views (issue #3923).
 *
 * Semantics:
 *   NULL  → unknown (message stored before this feature, or pre-2.8 firmware
 *           that never sets the field)
 *   0     → decoded packet, not signed / signature not verified
 *   1     → device reported a valid XEdDSA signature
 *
 * No backfill: the flag only exists on messages received from 2.8 firmware;
 * historical rows stay NULL (unknown), which the UI renders as no indicator.
 *
 * Column naming follows the `messages` table's existing camelCase convention
 * (`viaMqtt`, `viaStoreForward`) on all three backends, rather than the
 * snake_case used by newer tables.
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

const LABEL = 'Migration 140';
const TABLE = 'messages';
const COLUMN = 'xeddsaSigned';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE}.${COLUMN}...`);
    addColumnIfMissing(db, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3923 pg PoolClient: migration signature convention (matches helpers.ts)
export async function runMigration140Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" BOOLEAN`);
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #3923 mysql2 Pool: migration signature convention (matches helpers.ts)
export async function runMigration140Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `\`${COLUMN}\` BOOLEAN`);
}
