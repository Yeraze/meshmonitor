/**
 * Migration 051: Drop legacy single-column UNIQUE on
 * user_notification_preferences.userId.
 *
 * Migration 028 made notification preferences per-source by introducing the
 * composite UNIQUE on ("userId", "sourceId"), and tried to drop the old
 * single-column UNIQUE constraint added by migration 015. However, it only
 * targeted the constraint name `user_notification_preferences_userId_unique`
 * (the name 015 used). On databases that were originally created from a
 * Drizzle schema that declared `.unique()` at the column level, PostgreSQL
 * auto-named the constraint `user_notification_preferences_userId_key`, which
 * survived migration 028 and continues to block per-source upserts with:
 *
 *   duplicate key value violates unique constraint
 *   "user_notification_preferences_userId_key"
 *
 * MySQL has the analogous problem: 015 created `idx_user_notification_preferences_userId`,
 * which 028 never dropped.
 *
 * This migration is defensive — it drops every single-column UNIQUE on
 * userId by both known names, leaving the composite (userId, sourceId)
 * constraint from 028 intact.
 */
import type Database from 'better-sqlite3';

// SQLite migration: 028 already drops idx_user_notification_preferences_user_id.
// Repeat defensively in case anyone added a different variant.
export const migration = {
  up: (db: Database.Database) => {
    try {
      db.exec(`DROP INDEX IF EXISTS idx_user_notification_preferences_user_id`);
    } catch {
      // Ignore — index may not exist
    }
    try {
      db.exec(`DROP INDEX IF EXISTS idx_user_notification_preferences_userId`);
    } catch {
      // Ignore — index may not exist
    }
  },
};

// PostgreSQL migration
export async function runMigration051Postgres(client: any): Promise<void> {
  // Drop both known names. Both are no-ops if the constraint doesn't exist.
  await client.query(`
    ALTER TABLE user_notification_preferences
    DROP CONSTRAINT IF EXISTS "user_notification_preferences_userId_unique"
  `);
  await client.query(`
    ALTER TABLE user_notification_preferences
    DROP CONSTRAINT IF EXISTS "user_notification_preferences_userId_key"
  `);

  // Belt-and-braces: drop any remaining single-column UNIQUE on userId
  // that isn't the composite (userId, sourceId) we want to keep.
  const { rows } = await client.query(`
    SELECT con.conname AS name
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE ns.nspname = 'public'
      AND rel.relname = 'user_notification_preferences'
      AND con.contype = 'u'
      AND array_length(con.conkey, 1) = 1
      AND EXISTS (
        SELECT 1 FROM pg_attribute att
        WHERE att.attrelid = rel.oid
          AND att.attnum = con.conkey[1]
          AND att.attname = 'userId'
      )
  `);
  for (const row of rows as Array<{ name: string }>) {
    await client.query(
      `ALTER TABLE user_notification_preferences DROP CONSTRAINT IF EXISTS "${row.name}"`
    );
  }
}

// MySQL migration
export async function runMigration051Mysql(pool: any): Promise<void> {
  // Drop the legacy single-column unique index from migration 015.
  const [rows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'user_notification_preferences'
       AND INDEX_NAME = 'idx_user_notification_preferences_userId'`
  );
  if (Array.isArray(rows) && rows.length > 0) {
    await pool.query(
      `ALTER TABLE user_notification_preferences DROP INDEX idx_user_notification_preferences_userId`
    );
  }
}
