/**
 * Migration 206: MeshCore contact location override (#5842). PER-SOURCE, like
 * the table.
 *
 * Adds the five columns the Meshtastic `nodes` table already carries for a
 * user-set position, to `meshcore_nodes`:
 *
 *   positionOverrideEnabled   — boolean, default false
 *   latitudeOverride          — the pinned latitude
 *   longitudeOverride         — the pinned longitude
 *   altitudeOverride          — the pinned altitude (optional)
 *   positionOverrideIsPrivate — boolean, default false; hides the override
 *                               from callers without `nodes_private:read`
 *
 * The override lives in MeshMonitor only; nothing is written to the radio.
 * It sits beside the advert `latitude`/`longitude`, which advert ingest keeps
 * writing, so an advert never clears it and the override never overwrites the
 * advert fix.
 *
 * Additive, no backfill. Idempotent `ADD COLUMN` on all three backends.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 206';
const TABLE = 'meshcore_nodes';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding meshcore_nodes position override columns...`);
    addColumnIfMissing(db, TABLE, 'positionOverrideEnabled', 'positionOverrideEnabled INTEGER DEFAULT 0');
    addColumnIfMissing(db, TABLE, 'latitudeOverride', 'latitudeOverride REAL');
    addColumnIfMissing(db, TABLE, 'longitudeOverride', 'longitudeOverride REAL');
    addColumnIfMissing(db, TABLE, 'altitudeOverride', 'altitudeOverride REAL');
    addColumnIfMissing(db, TABLE, 'positionOverrideIsPrivate', 'positionOverrideIsPrivate INTEGER DEFAULT 0');
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration206Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding meshcore_nodes position override columns...`);
  await addColumnIfMissingPostgres(client, TABLE, 'positionOverrideEnabled', '"positionOverrideEnabled" BOOLEAN DEFAULT false');
  await addColumnIfMissingPostgres(client, TABLE, 'latitudeOverride', '"latitudeOverride" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'longitudeOverride', '"longitudeOverride" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'altitudeOverride', '"altitudeOverride" DOUBLE PRECISION');
  await addColumnIfMissingPostgres(client, TABLE, 'positionOverrideIsPrivate', '"positionOverrideIsPrivate" BOOLEAN DEFAULT false');
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration206Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding meshcore_nodes position override columns...`);
  await addColumnIfMissingMysql(pool, TABLE, 'positionOverrideEnabled', 'positionOverrideEnabled BOOLEAN DEFAULT false');
  await addColumnIfMissingMysql(pool, TABLE, 'latitudeOverride', 'latitudeOverride DOUBLE NULL');
  await addColumnIfMissingMysql(pool, TABLE, 'longitudeOverride', 'longitudeOverride DOUBLE NULL');
  await addColumnIfMissingMysql(pool, TABLE, 'altitudeOverride', 'altitudeOverride DOUBLE NULL');
  await addColumnIfMissingMysql(pool, TABLE, 'positionOverrideIsPrivate', 'positionOverrideIsPrivate BOOLEAN DEFAULT false');
  logger.info(`${LABEL} complete (MySQL)`);
}
