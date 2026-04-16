/**
 * Migration 038: Delete orphan source-scoped notification rows.
 *
 * Source deletes don't cascade to user_notification_preferences or
 * push_subscriptions, so deleting a source leaves dangling rows pointing at a
 * non-existent sourceId. Those rows cause duplicate-notification fan-out:
 * getUsersWithServiceEnabled() returns the same userId once per row, so a user
 * with prefs rows for N sources (orphan or live) receives N notifications for
 * every preference broadcast.
 *
 * Idempotent — safe to run repeatedly. Does not add a foreign key (would
 * require table recreation on SQLite); cleanup is one-shot.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up(db: Database): void {
    const unp = db
      .prepare(`DELETE FROM user_notification_preferences WHERE source_id NOT IN (SELECT id FROM sources)`)
      .run();
    if (unp.changes > 0) {
      logger.info(`Migration 038: deleted ${unp.changes} orphan user_notification_preferences rows`);
    }

    const push = db
      .prepare(`DELETE FROM push_subscriptions WHERE source_id NOT IN (SELECT id FROM sources)`)
      .run();
    if (push.changes > 0) {
      logger.info(`Migration 038: deleted ${push.changes} orphan push_subscriptions rows`);
    }
  },
};

export async function runMigration038Postgres(client: any): Promise<void> {
  const unp = await client.query(
    `DELETE FROM user_notification_preferences WHERE "sourceId" NOT IN (SELECT id FROM sources)`
  );
  if (unp.rowCount && unp.rowCount > 0) {
    logger.info(`Migration 038: deleted ${unp.rowCount} orphan user_notification_preferences rows (PG)`);
  }

  const push = await client.query(
    `DELETE FROM push_subscriptions WHERE "sourceId" NOT IN (SELECT id FROM sources)`
  );
  if (push.rowCount && push.rowCount > 0) {
    logger.info(`Migration 038: deleted ${push.rowCount} orphan push_subscriptions rows (PG)`);
  }
}

export async function runMigration038Mysql(pool: any): Promise<void> {
  // Anti-join with explicit COLLATE on both sides — sourceId columns added by
  // later migrations may carry a different collation (utf8mb4_unicode_ci) than
  // sources.id (utf8mb4_0900_ai_ci on MySQL 8 defaults), which makes a plain
  // IN-subquery throw "Illegal mix of collations".
  const [unpRes] = await pool.query(
    `DELETE unp FROM user_notification_preferences unp
     LEFT JOIN sources s
       ON unp.sourceId COLLATE utf8mb4_unicode_ci = s.id COLLATE utf8mb4_unicode_ci
     WHERE s.id IS NULL`
  );
  const unpAffected = (unpRes as any).affectedRows ?? 0;
  if (unpAffected > 0) {
    logger.info(`Migration 038: deleted ${unpAffected} orphan user_notification_preferences rows (MySQL)`);
  }

  const [pushRes] = await pool.query(
    `DELETE ps FROM push_subscriptions ps
     LEFT JOIN sources s
       ON ps.sourceId COLLATE utf8mb4_unicode_ci = s.id COLLATE utf8mb4_unicode_ci
     WHERE s.id IS NULL`
  );
  const pushAffected = (pushRes as any).affectedRows ?? 0;
  if (pushAffected > 0) {
    logger.info(`Migration 038: deleted ${pushAffected} orphan push_subscriptions rows (MySQL)`);
  }
}
