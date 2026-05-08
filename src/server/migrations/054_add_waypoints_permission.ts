/**
 * Migration 054: Seed per-source `waypoints` permission grants.
 *
 * Adds the new `waypoints` resource as a per-source permission. Mirrors the
 * pattern from migration 033: iterate over registered sources and copy each
 * user's existing `messages` grant level into a new `waypoints` row scoped to
 * that source. This preserves the principle of "if you can read messages on
 * this source you can read waypoints on it" without granting access to users
 * who had no permissions before. Admin users are not seeded — they bypass row
 * checks via `isAdmin`.
 *
 * Idempotent across SQLite/PostgreSQL/MySQL via INSERT OR IGNORE / ON CONFLICT
 * DO NOTHING / INSERT IGNORE.
 *
 * Dialect notes:
 *   - SQLite column names: user_id, resource, can_view_on_map, can_read,
 *     can_write, can_delete, granted_at, granted_by, sourceId
 *   - PostgreSQL/MySQL column names: userId, resource, canViewOnMap, canRead,
 *     canWrite, canDelete, grantedAt, grantedBy, sourceId
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 054 (SQLite): seeding waypoints permission grants...');

    const sources = db.prepare(`SELECT id FROM sources`).all() as { id: string }[];
    if (sources.length === 0) {
      logger.info('Migration 054 (SQLite): no sources registered, nothing to seed');
      return;
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO permissions
        (user_id, resource, can_view_on_map, can_read, can_write, can_delete, granted_at, granted_by, sourceId)
      SELECT user_id, 'waypoints', can_view_on_map, can_read, can_write, can_delete, ?, granted_by, ?
        FROM permissions
       WHERE resource = 'messages'
         AND sourceId = ?
    `);

    const now = Date.now();
    let inserted = 0;
    for (const src of sources) {
      const result = insert.run(now, src.id, src.id);
      inserted += result.changes ?? 0;
    }
    logger.info(`Migration 054 (SQLite): inserted ${inserted} waypoints grant(s) across ${sources.length} source(s)`);
  },

  down: (db: Database): void => {
    db.prepare(`DELETE FROM permissions WHERE resource = 'waypoints'`).run();
  },
};

// ============ PostgreSQL ============

export async function runMigration054Postgres(client: any): Promise<void> {
  logger.info('Running migration 054 (PostgreSQL): seeding waypoints permission grants...');

  const sourcesRes = await client.query(`SELECT id FROM sources`);
  const sources: string[] = sourcesRes.rows.map((r: any) => r.id);
  if (sources.length === 0) {
    logger.info('Migration 054 (PostgreSQL): no sources registered, nothing to seed');
    return;
  }

  const now = Date.now();
  let inserted = 0;
  for (const sourceId of sources) {
    const res = await client.query(
      `
        INSERT INTO permissions
          ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId")
        SELECT "userId", 'waypoints', "canViewOnMap", "canRead", "canWrite", "canDelete", $1, "grantedBy", $2
          FROM permissions
         WHERE resource = 'messages'
           AND "sourceId" = $2
        ON CONFLICT DO NOTHING
      `,
      [now, sourceId],
    );
    inserted += res.rowCount ?? 0;
  }
  logger.info(`Migration 054 (PostgreSQL): inserted ${inserted} waypoints grant(s) across ${sources.length} source(s)`);
}

// ============ MySQL ============

export async function runMigration054Mysql(pool: any): Promise<void> {
  logger.info('Running migration 054 (MySQL): seeding waypoints permission grants...');

  const conn = await pool.getConnection();
  try {
    const [sourceRows] = await conn.query(`SELECT id FROM sources`);
    const sources: string[] = (sourceRows as any[]).map((r) => r.id);
    if (sources.length === 0) {
      logger.info('Migration 054 (MySQL): no sources registered, nothing to seed');
      return;
    }

    const now = Date.now();
    let inserted = 0;
    for (const sourceId of sources) {
      const [result] = await conn.query(
        `INSERT IGNORE INTO permissions
           (userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId)
         SELECT userId, 'waypoints', canViewOnMap, canRead, canWrite, canDelete, ?, grantedBy, ?
           FROM permissions
          WHERE resource = 'messages'
            AND sourceId = ?`,
        [now, sourceId, sourceId],
      );
      inserted += (result as any)?.affectedRows ?? 0;
    }
    logger.info(`Migration 054 (MySQL): inserted ${inserted} waypoints grant(s) across ${sources.length} source(s)`);
  } finally {
    conn.release();
  }
}
