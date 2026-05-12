/**
 * Migration 058: Collapse the global `meshcore` permission resource into
 * the existing per-source sourcey set.
 *
 * Context:
 *   Slices 1–2 made MeshCore a first-class per-source citizen (manager
 *   registry, sourceId on domain rows, nested routes under
 *   `/api/sources/:id/meshcore/*`). The permission system still had a
 *   single global `meshcore` resource, which is incompatible with
 *   per-source authorisation. This migration mirrors what 033 did for
 *   Meshtastic globals: expand each global `meshcore` grant into rows on
 *   the sourcey resources actually used by the MeshCore routes
 *   (`connection`, `configuration`, `nodes`, `messages`), scoped per
 *   meshcore-typed source. The original global rows are then deleted so
 *   the now-removed `meshcore` resource id can no longer shadow checks.
 *
 *   Channels are intentionally lumped under `messages` for v1 — per-channel
 *   `mc_channel_N` grants can be added later if a use case appears.
 *
 * Idempotency:
 *   Inserts use INSERT OR IGNORE / ON CONFLICT DO NOTHING so a second run
 *   is a no-op. Deleting the global rows is also idempotent.
 *
 *   The unique index `permissions_user_resource_source_uniq` (created in
 *   033) covers (user_id, resource, sourceId), so the per-source rows we
 *   insert here will not collide with grants the user already has.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 058';

/**
 * Sourcey resources the MeshCore routes check against. Keep this in sync
 * with the requirePermission(...) calls in meshcoreRoutes.ts.
 */
const TARGET_RESOURCES = ['connection', 'configuration', 'nodes', 'messages'] as const;

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info(`${LABEL} (SQLite): collapsing global \`meshcore\` grants into per-source rows...`);

    const meshcoreSources = db
      .prepare(`SELECT id FROM sources WHERE type = 'meshcore'`)
      .all() as { id: string }[];

    if (meshcoreSources.length === 0) {
      logger.info(`${LABEL} (SQLite): no meshcore sources — dropping any orphan global meshcore grants`);
    } else {
      const globalRows = db
        .prepare(`SELECT * FROM permissions WHERE sourceId IS NULL AND resource = 'meshcore'`)
        .all() as any[];

      logger.info(
        `${LABEL} (SQLite): expanding ${globalRows.length} global meshcore grant(s) ` +
          `across ${meshcoreSources.length} meshcore source(s) × ${TARGET_RESOURCES.length} target resource(s)`,
      );

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO permissions
          (user_id, resource, can_view_on_map, can_read, can_write, can_delete, granted_at, granted_by, sourceId)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const row of globalRows) {
        for (const src of meshcoreSources) {
          for (const resource of TARGET_RESOURCES) {
            insertStmt.run(
              row.user_id,
              resource,
              row.can_view_on_map,
              row.can_read,
              row.can_write,
              row.can_delete ?? 0,
              row.granted_at,
              row.granted_by,
              src.id,
            );
          }
        }
      }
    }

    const delResult = db
      .prepare(`DELETE FROM permissions WHERE sourceId IS NULL AND resource = 'meshcore'`)
      .run();
    if (delResult.changes > 0) {
      logger.info(`${LABEL} (SQLite): deleted ${delResult.changes} global meshcore grant(s)`);
    }

    logger.info(`${LABEL} complete (SQLite)`);
  },

  down: (_db: Database): void => {
    // Forward-only — there is no global `meshcore` resource to restore to,
    // and 033 already removed the supporting CHECK constraint.
  },
};

// ============ PostgreSQL ============

export async function runMigration058Postgres(client: any): Promise<void> {
  logger.info(`${LABEL} (PostgreSQL): collapsing global \`meshcore\` grants into per-source rows...`);

  const sourcesRes = await client.query(`SELECT id FROM sources WHERE type = 'meshcore'`);
  const meshcoreSources: string[] = sourcesRes.rows.map((r: any) => r.id);

  if (meshcoreSources.length === 0) {
    logger.info(`${LABEL} (PostgreSQL): no meshcore sources — dropping any orphan global meshcore grants`);
  } else {
    for (const sourceId of meshcoreSources) {
      for (const resource of TARGET_RESOURCES) {
        await client.query(
          `
          INSERT INTO permissions
            ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId")
          SELECT "userId", $2, "canViewOnMap", "canRead", "canWrite", COALESCE("canDelete", false), "grantedAt", "grantedBy", $1
            FROM permissions
           WHERE "sourceId" IS NULL
             AND resource = 'meshcore'
          ON CONFLICT DO NOTHING
          `,
          [sourceId, resource],
        );
      }
    }
    logger.info(
      `${LABEL} (PostgreSQL): expanded global meshcore grants across ${meshcoreSources.length} source(s)`,
    );
  }

  const delRes = await client.query(
    `DELETE FROM permissions WHERE "sourceId" IS NULL AND resource = 'meshcore'`,
  );
  if (delRes.rowCount && delRes.rowCount > 0) {
    logger.info(`${LABEL} (PostgreSQL): deleted ${delRes.rowCount} global meshcore grant(s)`);
  }

  logger.info(`${LABEL} complete (PostgreSQL)`);
}

// ============ MySQL ============

export async function runMigration058Mysql(pool: any): Promise<void> {
  logger.info(`${LABEL} (MySQL): collapsing global \`meshcore\` grants into per-source rows...`);

  const conn = await pool.getConnection();
  try {
    const [sourceRows] = await conn.query(`SELECT id FROM sources WHERE type = 'meshcore'`);
    const meshcoreSources: string[] = (sourceRows as any[]).map((r) => r.id);

    if (meshcoreSources.length === 0) {
      logger.info(`${LABEL} (MySQL): no meshcore sources — dropping any orphan global meshcore grants`);
    } else {
      for (const sourceId of meshcoreSources) {
        for (const resource of TARGET_RESOURCES) {
          await conn.query(
            `INSERT IGNORE INTO permissions
               (userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId)
             SELECT userId, ?, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, ?
               FROM permissions
              WHERE sourceId IS NULL
                AND resource = 'meshcore'`,
            [resource, sourceId],
          );
        }
      }
      logger.info(
        `${LABEL} (MySQL): expanded global meshcore grants across ${meshcoreSources.length} source(s)`,
      );
    }

    const [delResult] = await conn.query(
      `DELETE FROM permissions WHERE sourceId IS NULL AND resource = 'meshcore'`,
    );
    const affected = (delResult as any)?.affectedRows ?? 0;
    if (affected > 0) {
      logger.info(`${LABEL} (MySQL): deleted ${affected} global meshcore grant(s)`);
    }
  } finally {
    conn.release();
  }

  logger.info(`${LABEL} complete (MySQL)`);
}
