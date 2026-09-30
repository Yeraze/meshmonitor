/**
 * Migration 184: Add `ackProofStatus` column to the `messages` table (#5279).
 *
 * Firmware 2.8.1+ attaches an 8-byte HMAC ("ack proof") to unicast acks and
 * naks, and reports the verdict on the phone-bound copy of the ack that
 * settles a DM we sent, as `MeshPacket.ack_proof_status` (field 23, enum
 * `MeshPacket.AckProofStatus`). This column records that verdict on the
 * outbound DM row so Delivery Details can show "Proven receipt".
 *
 * Semantics (stored as the enum NUMBER, never its name):
 *   NULL → no status reported (older firmware, MQTT, channel broadcast,
 *          or a message stored before this feature)
 *   0    → ACK_PROOF_ABSENT  (not proven; common on multi-hop paths)
 *   1    → ACK_PROOF_VALID   (the addressed node's key signed the ack)
 *   2    → ACK_PROOF_INVALID (a proof was carried and failed)
 *   3    → ACK_PROOF_NO_KEY  (a proof was carried, no key to check it)
 *
 * No backfill. Column naming follows the `messages` table's camelCase
 * convention on all three backends (see migration 140).
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

const LABEL = 'Migration 184';
const TABLE = 'messages';
const COLUMN = 'ackProofStatus';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5279 pg PoolClient: migration signature convention (matches helpers.ts)
export async function runMigration184Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" SMALLINT`);
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- #5279 mysql2 Pool: migration signature convention (matches helpers.ts)
export async function runMigration184Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `\`${COLUMN}\` SMALLINT`);
}
