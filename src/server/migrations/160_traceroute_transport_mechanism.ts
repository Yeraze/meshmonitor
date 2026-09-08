/**
 * Migration 160: `traceroutes.transportMechanism` (#5097).
 *
 * The map's Show RF / Show UDP / Show MQTT toggles filtered node markers and
 * neighbor links but not traceroute route segments, because nothing on the
 * traceroute row said which transport carried it. The traceroute protobuf has
 * no per-hop transport field either — the only per-hop signal is the firmware's
 * unknown-SNR sentinel, which marks an MQTT hop and says nothing about UDP.
 *
 *   transportMechanism  INTEGER  `meshtastic.MeshPacket.TransportMechanism` of
 *                                the packet that carried the route data:
 *                                1 LORA · 5 MQTT · 6 MULTICAST_UDP (and the
 *                                LORA_ALT / INTERNAL / API values in between).
 *
 * NULL is the right backfill and there is nothing better available: the
 * transport of a traceroute received before this migration was never recorded
 * anywhere, so it cannot be reconstructed. Readers run NULL through
 * `classifyNodeTransport`, which falls back to `'rf'` — the pre-existing map
 * behaviour, so every historical traceroute stays visible under the default
 * toggles rather than vanishing on upgrade.
 *
 * No index: the column is never a query predicate. Filtering happens in the
 * renderer, on rows already fetched by timestamp for the map's age window.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 160';
const TABLE = 'traceroutes';
const COLUMN = 'transportMechanism';

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

export async function runMigration160Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingPostgres(client, TABLE, COLUMN, `"${COLUMN}" INTEGER`);
}

// ============ MySQL ============

export async function runMigration160Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE}.${COLUMN}...`);
  await addColumnIfMissingMysql(pool, TABLE, COLUMN, `${COLUMN} INT`);
}
