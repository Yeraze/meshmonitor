/**
 * Migration 055: Backfill global `waypoints` permission grants.
 *
 * Migration 054 only seeded waypoints from per-source `messages` rows
 * (`sourceId = <source.id>`). Permissions stored globally
 * (`sourceId IS NULL`) were skipped, leaving non-admin users — including
 * the seeded `anonymous` user — without any `waypoints` row even though
 * they had a global `messages` grant. Without this row,
 * `requirePermission('waypoints', …)` returns 403 for everyone except
 * admins (who bypass via `isAdmin`).
 *
 * This migration mirrors 054 but for the `sourceId IS NULL` case: it
 * copies each user's global `messages` grant levels into a global
 * `waypoints` row. Idempotent via INSERT OR IGNORE / ON CONFLICT.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 055 (SQLite): seeding global waypoints permission grants...');

    const result = db
      .prepare(
        `
        INSERT OR IGNORE INTO permissions
          (user_id, resource, can_view_on_map, can_read, can_write, can_delete, granted_at, granted_by, sourceId)
        SELECT user_id, 'waypoints', can_view_on_map, can_read, can_write, can_delete, ?, granted_by, NULL
          FROM permissions
         WHERE resource = 'messages'
           AND sourceId IS NULL
        `,
      )
      .run(Date.now());

    logger.info(`Migration 055 (SQLite): inserted ${result.changes ?? 0} global waypoints grant(s)`);
  },

  down: (db: Database): void => {
    db.prepare(`DELETE FROM permissions WHERE resource = 'waypoints' AND sourceId IS NULL`).run();
  },
};

// ============ PostgreSQL ============

export async function runMigration055Postgres(client: any): Promise<void> {
  logger.info('Running migration 055 (PostgreSQL): seeding global waypoints permission grants...');

  const res = await client.query(
    `
      INSERT INTO permissions
        ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId")
      SELECT "userId", 'waypoints', "canViewOnMap", "canRead", "canWrite", "canDelete", $1, "grantedBy", NULL
        FROM permissions
       WHERE resource = 'messages'
         AND "sourceId" IS NULL
      ON CONFLICT DO NOTHING
    `,
    [Date.now()],
  );
  logger.info(`Migration 055 (PostgreSQL): inserted ${res.rowCount ?? 0} global waypoints grant(s)`);
}

// ============ MySQL ============

export async function runMigration055Mysql(pool: any): Promise<void> {
  logger.info('Running migration 055 (MySQL): seeding global waypoints permission grants...');

  const conn = await pool.getConnection();
  try {
    const [result] = await conn.query(
      `INSERT IGNORE INTO permissions
         (userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId)
       SELECT userId, 'waypoints', canViewOnMap, canRead, canWrite, canDelete, ?, grantedBy, NULL
         FROM permissions
        WHERE resource = 'messages'
          AND sourceId IS NULL`,
      [Date.now()],
    );
    const inserted = (result as any)?.affectedRows ?? 0;
    logger.info(`Migration 055 (MySQL): inserted ${inserted} global waypoints grant(s)`);
  } finally {
    conn.release();
  }
}
