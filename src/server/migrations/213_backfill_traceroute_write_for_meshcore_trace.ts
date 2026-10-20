/**
 * Migration 213: give `traceroute:write` to every user who holds
 * `nodes:write` on a MeshCore source (issue #5898).
 *
 * Context:
 *   MeshCore `POST /api/sources/:id/meshcore/contacts/:pk/trace-path` used to
 *   take `nodes:write`. It now takes `traceroute:write`, the permission every
 *   other traceroute send uses. Without this backfill, a user who can trace
 *   paths today (nodes:write on the source) but has no traceroute:write there
 *   would lose the button on upgrade.
 *
 * What it does, per (user, MeshCore source) with `nodes` canWrite = true:
 *   - a `traceroute` row exists with canWrite = false → set canWrite = true;
 *   - no `traceroute` row exists → insert one with canWrite = true and every
 *     other flag false (no read access is added).
 *   It never clears a flag and never touches any other row.
 *
 * Scope: only sources with `type = 'meshcore'` (the device-backed type, the
 * only one with a trace-path route — same join as migration 135). A
 * `nodes:write` holder on a Meshtastic source gains nothing here, since that
 * would let them send Meshtastic traceroutes they cannot send today.
 * `sourceId IS NULL` nodes rows authorize nothing for a per-source resource,
 * so they are skipped.
 *
 * Idempotency: the UPDATE only matches canWrite = false rows and the INSERT
 * only fires when no traceroute row exists for the pair, so a rerun is a
 * no-op.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 213';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): backfilling traceroute:write for MeshCore nodes:write holders...`);
    try {
      const tx = db.transaction(() => {
        const updated = db
          .prepare(
            `UPDATE permissions
                SET can_write = 1
              WHERE resource = 'traceroute'
                AND can_write = 0
                AND sourceId IN (SELECT id FROM sources WHERE type = 'meshcore')
                AND EXISTS (
                  SELECT 1 FROM permissions n
                   WHERE n.resource = 'nodes'
                     AND n.can_write = 1
                     AND n.user_id = permissions.user_id
                     AND n.sourceId = permissions.sourceId
                )`,
          )
          .run();
        const inserted = db
          .prepare(
            `INSERT INTO permissions (user_id, resource, can_view_on_map, can_read, can_write, granted_at, granted_by, sourceId)
             SELECT DISTINCT n.user_id, 'traceroute', 0, 0, 1, ?, NULL, n.sourceId
               FROM permissions n
              WHERE n.resource = 'nodes'
                AND n.can_write = 1
                AND n.sourceId IN (SELECT id FROM sources WHERE type = 'meshcore')
                AND NOT EXISTS (
                  SELECT 1 FROM permissions t
                   WHERE t.resource = 'traceroute'
                     AND t.user_id = n.user_id
                     AND t.sourceId = n.sourceId
                )`,
          )
          .run(Date.now());
        return { updated: updated.changes, inserted: inserted.changes };
      });
      const { updated, inserted } = tx();
      if (updated + inserted > 0) {
        logger.info(`${LABEL} (SQLite): updated ${updated}, inserted ${inserted} traceroute grant(s)`);
      }
    } catch (e) {
      logger.warn(`${LABEL} (SQLite): could not backfill traceroute:write:`, e instanceof Error ? e.message : String(e));
    }
    logger.info(`${LABEL} complete (SQLite)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration213Postgres(client: import('pg').PoolClient): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): backfilling traceroute:write for MeshCore nodes:write holders...`);
  try {
    await client.query('BEGIN');
    try {
      const updated = await client.query(
        `UPDATE permissions t
            SET "canWrite" = true
          WHERE t.resource = 'traceroute'
            AND t."canWrite" = false
            AND t."sourceId" IN (SELECT id FROM sources WHERE type = 'meshcore')
            AND EXISTS (
              SELECT 1 FROM permissions n
               WHERE n.resource = 'nodes'
                 AND n."canWrite" = true
                 AND n."userId" = t."userId"
                 AND n."sourceId" = t."sourceId"
            )`,
      );
      const inserted = await client.query(
        `INSERT INTO permissions ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId")
         SELECT DISTINCT n."userId", 'traceroute', false, false, true, false, $1::bigint, NULL::integer, n."sourceId"
           FROM permissions n
          WHERE n.resource = 'nodes'
            AND n."canWrite" = true
            AND n."sourceId" IN (SELECT id FROM sources WHERE type = 'meshcore')
            AND NOT EXISTS (
              SELECT 1 FROM permissions t
               WHERE t.resource = 'traceroute'
                 AND t."userId" = n."userId"
                 AND t."sourceId" = n."sourceId"
            )`,
        [Date.now()],
      );
      await client.query('COMMIT');
      const total = (updated.rowCount ?? 0) + (inserted.rowCount ?? 0);
      if (total > 0) {
        logger.info(`${LABEL} (PostgreSQL): updated ${updated.rowCount ?? 0}, inserted ${inserted.rowCount ?? 0} traceroute grant(s)`);
      }
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } catch (e) {
    logger.warn(`${LABEL} (PostgreSQL): could not backfill traceroute:write:`, e instanceof Error ? e.message : String(e));
  }
  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration213Mysql(pool: import('mysql2/promise').Pool): Promise<void> {
  logger.info(`${LABEL} (MySQL): backfilling traceroute:write for MeshCore nodes:write holders...`);
  try {
    // MySQL cannot name the UPDATE target inside a subquery (ER_UPDATE_TABLE_USED),
    // so the nodes:write match is a self-join instead of EXISTS.
    const [updated] = await pool.query<import('mysql2').ResultSetHeader>(
      `UPDATE permissions t
         JOIN permissions n
           ON n.userId = t.userId
          AND n.sourceId = t.sourceId
          AND n.resource = 'nodes'
          AND n.canWrite = true
         JOIN sources s
           ON s.id = t.sourceId
          AND s.type = 'meshcore'
          SET t.canWrite = true
        WHERE t.resource = 'traceroute'
          AND t.canWrite = false`,
    );
    const [inserted] = await pool.query<import('mysql2').ResultSetHeader>(
      `INSERT INTO permissions (userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId)
       SELECT DISTINCT n.userId, 'traceroute', false, false, true, false, ?, NULL, n.sourceId
         FROM permissions n
         JOIN sources s ON s.id = n.sourceId AND s.type = 'meshcore'
        WHERE n.resource = 'nodes'
          AND n.canWrite = true
          AND NOT EXISTS (
            SELECT 1 FROM permissions t
             WHERE t.resource = 'traceroute'
               AND t.userId = n.userId
               AND t.sourceId = n.sourceId
          )`,
      [Date.now()],
    );
    const u = updated?.affectedRows ?? 0;
    const i = inserted?.affectedRows ?? 0;
    if (u + i > 0) {
      logger.info(`${LABEL} (MySQL): updated ${u}, inserted ${i} traceroute grant(s)`);
    }
  } catch (e) {
    logger.warn(`${LABEL} (MySQL): could not backfill traceroute:write:`, e instanceof Error ? e.message : String(e));
  }
  logger.info(`${LABEL} complete (MySQL)`);
}
