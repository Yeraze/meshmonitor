/**
 * Migration 135: Backfill `canViewOnMap` on existing `nodes` permission grants
 * for MeshCore-typed sources.
 *
 * Context (issue #4559):
 *   Until now, MeshCore contact positions reaching the Dashboard/Unified/Map
 *   Analysis maps were gated only by the coarse `nodes:read` permission —
 *   unlike Meshtastic, which additionally requires `viewOnMap` (per channel)
 *   before a node's position is included. `buildSourceNodes()` is being fixed
 *   to apply the same `nodes:viewOnMap` gate to MeshCore sources.
 *
 *   Without a backfill, that fix would silently blank every MeshCore map that
 *   works today: `canViewOnMap` defaults to false and the admin UI never had
 *   a control to set it for the `nodes` resource, so no existing grant has it
 *   set to true. This migration preserves current behavior across the
 *   upgrade by setting `canViewOnMap = true` on existing `nodes` grants for
 *   meshcore-typed sources that already have `canRead = true` — admins can
 *   tighten individual grants afterward now that the UI exposes the control.
 *
 *   Mirrors migration 058's pattern of joining against `sources WHERE type =
 *   'meshcore'`.
 *
 * Idempotency:
 *   A plain UPDATE ... WHERE canViewOnMap = false AND canRead = true; once a
 *   row is updated it no longer matches the WHERE clause, so a second run is
 *   a no-op. Safe to re-run on a partially-applied database.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 135';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): backfilling canViewOnMap on meshcore nodes grants...`);
    try {
      const result = db
        .prepare(
          `UPDATE permissions
             SET can_view_on_map = 1
           WHERE resource = 'nodes'
             AND can_read = 1
             AND can_view_on_map = 0
             AND sourceId IN (SELECT id FROM sources WHERE type = 'meshcore')`,
        )
        .run();
      if (result.changes > 0) {
        logger.info(`${LABEL} (SQLite): backfilled canViewOnMap on ${result.changes} grant(s)`);
      }
    } catch (e) {
      logger.warn(`${LABEL} (SQLite): could not backfill canViewOnMap:`, e instanceof Error ? e.message : String(e));
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration135Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): backfilling canViewOnMap on meshcore nodes grants...`);
  try {
    const result = await client.query(
      `UPDATE permissions
          SET "canViewOnMap" = true
        WHERE resource = 'nodes'
          AND "canRead" = true
          AND "canViewOnMap" = false
          AND "sourceId" IN (SELECT id FROM sources WHERE type = 'meshcore')`,
    );
    if (result.rowCount && result.rowCount > 0) {
      logger.info(`${LABEL} (PostgreSQL): backfilled canViewOnMap on ${result.rowCount} grant(s)`);
    }
  } catch (e) {
    logger.warn(`${LABEL} (PostgreSQL): could not backfill canViewOnMap:`, e instanceof Error ? e.message : String(e));
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration135Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): backfilling canViewOnMap on meshcore nodes grants...`);
  try {
    const [result] = await pool.query<import('mysql2').ResultSetHeader>(
      `UPDATE permissions
          SET canViewOnMap = true
        WHERE resource = 'nodes'
          AND canRead = true
          AND canViewOnMap = false
          AND sourceId IN (SELECT id FROM sources WHERE type = 'meshcore')`,
    );
    const affected = result?.affectedRows ?? 0;
    if (affected > 0) {
      logger.info(`${LABEL} (MySQL): backfilled canViewOnMap on ${affected} grant(s)`);
    }
  } catch (e) {
    logger.warn(`${LABEL} (MySQL): could not backfill canViewOnMap:`, e instanceof Error ? e.message : String(e));
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
