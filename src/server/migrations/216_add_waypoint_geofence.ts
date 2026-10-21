/**
 * Migration 216: waypoint geofence fields (#5922).
 *
 * Firmware's `meshtastic.Waypoint` carries a geofence (fields 9-13): a
 * circular `geofence_radius` in metres, an optional rectangular
 * `bounding_box`, and three flags that tell each receiving node when to raise
 * a local alert. MeshMonitor dropped them on ingest, so a waypoint made in the
 * Apple or Android app lost its geofence here, and a rebroadcast stripped it
 * from the mesh. These columns store them so they round-trip.
 *
 * - `geofence_radius_m` (nullable integer): NULL or 0 = no circle.
 * - `bbox_west` / `bbox_south` / `bbox_east` / `bbox_north` (nullable
 *   degrees): all four set, or all NULL for no box.
 * - `notify_on_enter` / `notify_on_exit` / `notify_favorites_only`
 *   (integer 0/1, default 0), like `is_virtual`.
 *
 * Existing rows get no geofence and all flags off, which is what they carried
 * on the wire. Idempotent across SQLite / PostgreSQL / MySQL via the helpers.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';
import {
  addColumnIfMissing,
  addColumnIfMissingPostgres,
  addColumnIfMissingMysql,
} from './helpers.js';

const LABEL = 'Migration 216';
const TABLE = 'waypoints';
const BBOX_COLUMNS = ['bbox_west', 'bbox_south', 'bbox_east', 'bbox_north'] as const;
const FLAG_COLUMNS = ['notify_on_enter', 'notify_on_exit', 'notify_favorites_only'] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): adding ${TABLE} geofence columns...`);
    addColumnIfMissing(db, TABLE, 'geofence_radius_m', 'geofence_radius_m INTEGER');
    for (const c of BBOX_COLUMNS) addColumnIfMissing(db, TABLE, c, `${c} REAL`);
    for (const c of FLAG_COLUMNS) addColumnIfMissing(db, TABLE, c, `${c} INTEGER NOT NULL DEFAULT 0`);
    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (column drops are destructive)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration216Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): adding ${TABLE} geofence columns...`);
  await addColumnIfMissingPostgres(client, TABLE, 'geofence_radius_m', '"geofence_radius_m" INTEGER');
  for (const c of BBOX_COLUMNS) await addColumnIfMissingPostgres(client, TABLE, c, `"${c}" DOUBLE PRECISION`);
  for (const c of FLAG_COLUMNS) {
    await addColumnIfMissingPostgres(client, TABLE, c, `"${c}" INTEGER NOT NULL DEFAULT 0`);
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration216Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): adding ${TABLE} geofence columns...`);
  await addColumnIfMissingMysql(pool, TABLE, 'geofence_radius_m', 'geofence_radius_m INT');
  for (const c of BBOX_COLUMNS) await addColumnIfMissingMysql(pool, TABLE, c, `${c} DOUBLE`);
  for (const c of FLAG_COLUMNS) await addColumnIfMissingMysql(pool, TABLE, c, `${c} INT NOT NULL DEFAULT 0`);
  logger.info(`${LABEL} complete (MySQL)`);
}
