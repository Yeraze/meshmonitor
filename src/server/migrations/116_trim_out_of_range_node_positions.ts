/**
 * Migration 116: Trim out-of-range node positions.
 *
 * MeshCore adverts (and, rarely, corrupt Meshtastic fixes) can carry wildly
 * out-of-range junk coordinates — e.g. latitude 1853.45, longitude -1598.75 —
 * that pre-date the {@link isBogusPosition} ingestion guard. A single such row
 * blows the map's auto-fit bounds out to nothing, so this one-shot data cleanup
 * NULLs `nodes.latitude`/`longitude` wherever either value is outside the valid
 * WGS-84 range (latitude ∈ [-90, 90], longitude ∈ [-180, 180]). The node keeps
 * all its other data and simply shows no position until it re-acquires a valid
 * fix.
 *
 * NULL rows are never matched (a NULL comparison yields NULL, not true), so
 * positionless nodes are untouched. Null Island (0,0) is intentionally left to
 * the existing runtime filters — it is a valid-range coordinate, just a bogus
 * default, and nulling it here is unnecessary. `latitudeOverride`/
 * `longitudeOverride` (user-set) are deliberately left alone.
 *
 * Idempotent across SQLite / PostgreSQL / MySQL: after it runs, no row matches
 * the range predicate, so a re-run is a no-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 116';

// A single dialect-agnostic UPDATE. `latitude`/`longitude` are single-word
// column names identical across all three backends' schemas.
const UPDATE_SQL = `UPDATE nodes SET latitude = NULL, longitude = NULL
  WHERE latitude < -90 OR latitude > 90 OR longitude < -180 OR longitude > 180`;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): trimming out-of-range node positions...`);
    const info = db.prepare(UPDATE_SQL).run();
    if (info.changes > 0) {
      logger.info(`${LABEL} (SQLite): cleared ${info.changes} out-of-range node position(s)`);
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (the discarded junk coordinates are unrecoverable)`);
  },
};

// ============ PostgreSQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pg client is untyped in the migration runner (matches all sibling migrations)
export async function runMigration116Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): trimming out-of-range node positions...`);
  const res = await client.query(
    `UPDATE nodes SET "latitude" = NULL, "longitude" = NULL
     WHERE "latitude" < -90 OR "latitude" > 90 OR "longitude" < -180 OR "longitude" > 180`,
  );
  if (res?.rowCount) {
    logger.info(`${LABEL} (PostgreSQL): cleared ${res.rowCount} out-of-range node position(s)`);
  }
}

// ============ MySQL ============

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mysql pool is untyped in the migration runner (matches all sibling migrations)
export async function runMigration116Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): trimming out-of-range node positions...`);
  const [res] = await pool.query(UPDATE_SQL);
  const affected = (res as { affectedRows?: number } | undefined)?.affectedRows ?? 0;
  if (affected > 0) {
    logger.info(`${LABEL} (MySQL): cleared ${affected} out-of-range node position(s)`);
  }
}
