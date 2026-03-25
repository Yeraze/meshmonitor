/**
 * Migration 015: Add UNIQUE constraint to user_notification_preferences.userId
 *
 * The onConflictDoUpdate (upsert) for notification preferences requires a
 * UNIQUE constraint on userId, but the original schema omitted it.
 * This caused a 500 error when saving notification preferences.
 *
 * Fixes #2426
 */
import type Database from 'better-sqlite3';

// SQLite migration
export const migration = {
  up: (db: Database.Database) => {
    // SQLite doesn't support ADD CONSTRAINT — need to deduplicate first, then create unique index
    try {
      // Remove duplicate rows (keep the one with the highest id per user)
      db.exec(`
        DELETE FROM user_notification_preferences
        WHERE id NOT IN (
          SELECT MAX(id) FROM user_notification_preferences GROUP BY user_id
        )
      `);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notification_preferences_user_id ON user_notification_preferences(user_id)`);
    } catch {
      // Index may already exist
    }
  }
};

// PostgreSQL migration
export async function runMigration015Postgres(client: any): Promise<void> {
  // Remove duplicates (keep highest id per user)
  await client.query(`
    DELETE FROM user_notification_preferences
    WHERE id NOT IN (
      SELECT MAX(id) FROM user_notification_preferences GROUP BY "userId"
    )
  `);
  // Add unique constraint if not exists
  await client.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_notification_preferences_userId_unique'
      ) THEN
        ALTER TABLE user_notification_preferences ADD CONSTRAINT "user_notification_preferences_userId_unique" UNIQUE ("userId");
      END IF;
    END $$;
  `);
}

// MySQL migration
export async function runMigration015Mysql(pool: any): Promise<void> {
  // Remove duplicates (keep highest id per user)
  await pool.execute(`
    DELETE t1 FROM user_notification_preferences t1
    INNER JOIN user_notification_preferences t2
    WHERE t1.id < t2.id AND t1.userId = t2.userId
  `);
  // Add unique index if not exists
  const [rows] = await pool.execute(`
    SELECT COUNT(*) as cnt FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'user_notification_preferences'
    AND INDEX_NAME = 'idx_user_notification_preferences_userId'
  `);
  if (rows[0].cnt === 0) {
    await pool.execute(`CREATE UNIQUE INDEX idx_user_notification_preferences_userId ON user_notification_preferences(userId)`);
  }
}
