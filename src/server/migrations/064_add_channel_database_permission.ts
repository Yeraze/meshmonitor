/**
 * Migration 064: Backfill global `channel_database` permission grants for admins.
 *
 * Introduces `channel_database` as a global (not per-source) permission resource.
 * The channel/PSK library is pooled across all sources by
 * `channelDecryptionService`, so a single global grant governs access.
 *
 * Behaviour:
 *   - For every user with `is_admin = 1` (SQLite) / `"isAdmin" = true` (PG/MySQL),
 *     insert a row `(userId, 'channel_database', canRead, canWrite=true, sourceId=NULL)`
 *     if no matching row already exists.
 *   - Non-admin users get no row — they default to "denied" until an admin grants
 *     them access via the user-permissions UI.
 *
 * Idempotency: each backend checks for an existing row before inserting, so
 * re-running this migration is a no-op. The unique index on
 * `(user_id, resource, sourceId)` created by migration 033 treats NULL as a
 * distinct value in SQLite, so we cannot rely on INSERT OR IGNORE here.
 *
 * Dialect notes:
 *   - SQLite columns: user_id, resource, can_view_on_map, can_read, can_write,
 *     can_delete, granted_at, granted_by, sourceId
 *   - PostgreSQL/MySQL columns: userId, resource, canViewOnMap, canRead, canWrite,
 *     canDelete, grantedAt, grantedBy, sourceId
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    logger.info('Running migration 064 (SQLite): backfilling channel_database permission for admins...');

    const result = db
      .prepare(
        `
        INSERT INTO permissions
          (user_id, resource, can_view_on_map, can_read, can_write, can_delete, granted_at, granted_by, sourceId)
        SELECT u.id, 'channel_database', 0, 1, 1, 0, ?, NULL, NULL
          FROM users u
         WHERE u.is_admin = 1
           AND NOT EXISTS (
             SELECT 1 FROM permissions p
              WHERE p.user_id = u.id
                AND p.resource = 'channel_database'
                AND p.sourceId IS NULL
           )
        `,
      )
      .run(Date.now());

    logger.info(`Migration 064 (SQLite): inserted ${result.changes ?? 0} channel_database grant(s) for admins`);
  },

  down: (db: Database): void => {
    db.prepare(`DELETE FROM permissions WHERE resource = 'channel_database'`).run();
  },
};

// ============ PostgreSQL ============

export async function runMigration064Postgres(client: any): Promise<void> {
  logger.info('Running migration 064 (PostgreSQL): backfilling channel_database permission for admins...');

  const res = await client.query(
    `
      INSERT INTO permissions
        ("userId", resource, "canViewOnMap", "canRead", "canWrite", "canDelete", "grantedAt", "grantedBy", "sourceId")
      SELECT u.id, 'channel_database', false, true, true, false, $1, NULL, NULL
        FROM users u
       WHERE u."isAdmin" = true
         AND NOT EXISTS (
           SELECT 1 FROM permissions p
            WHERE p."userId" = u.id
              AND p.resource = 'channel_database'
              AND p."sourceId" IS NULL
         )
    `,
    [Date.now()],
  );
  logger.info(`Migration 064 (PostgreSQL): inserted ${res.rowCount ?? 0} channel_database grant(s) for admins`);
}

// ============ MySQL ============

export async function runMigration064Mysql(pool: any): Promise<void> {
  logger.info('Running migration 064 (MySQL): backfilling channel_database permission for admins...');

  const conn = await pool.getConnection();
  try {
    const [result] = await conn.query(
      `INSERT INTO permissions
         (userId, resource, canViewOnMap, canRead, canWrite, canDelete, grantedAt, grantedBy, sourceId)
       SELECT u.id, 'channel_database', 0, 1, 1, 0, ?, NULL, NULL
         FROM users u
        WHERE u.isAdmin = 1
          AND NOT EXISTS (
            SELECT 1 FROM (SELECT * FROM permissions) p
             WHERE p.userId = u.id
               AND p.resource = 'channel_database'
               AND p.sourceId IS NULL
          )`,
      [Date.now()],
    );
    const inserted = (result as any)?.affectedRows ?? 0;
    logger.info(`Migration 064 (MySQL): inserted ${inserted} channel_database grant(s) for admins`);
  } finally {
    conn.release();
  }
}
