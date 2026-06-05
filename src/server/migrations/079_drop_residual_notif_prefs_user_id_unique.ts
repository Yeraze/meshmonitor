/**
 * Migration 079: Drop residual single-column unique indexes on
 * user_notification_preferences.user_id.
 *
 * Migrations 028 and 051 dropped the old unique index created by migration 015
 * (`idx_user_notification_preferences_user_id`) by name. However, some databases
 * have a differently-named single-column unique constraint on user_id (e.g. from
 * an older Drizzle schema push, or a failed migration). That leftover constraint
 * causes the per-source upsert in saveUserPreferences to fail with:
 *
 *   SqliteError: UNIQUE constraint failed: user_notification_preferences.user_id
 *
 * because SQLite fires the old single-column unique BEFORE the
 * ON CONFLICT (user_id, source_id) handler can resolve the composite-key conflict.
 *
 * This migration uses PRAGMA index_info introspection to find and drop every
 * unique index on user_notification_preferences that covers only the user_id column,
 * regardless of how it was named, leaving the correct composite
 * (user_id, source_id) unique intact.
 *
 * Idempotent — safe to run repeatedly.
 */
import type Database from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

export const migration = {
  up: (db: Database.Database) => {
    // Get all named indexes on user_notification_preferences
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'user_notification_preferences'
        AND sql IS NOT NULL
    `).all() as Array<{ name: string }>;

    for (const idx of indexes) {
      // PRAGMA index_info returns one row per indexed column
      const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as Array<{ name: string }>;

      if (cols.length !== 1 || cols[0].name !== 'user_id') {
        continue; // Not a single-column index on user_id — leave it alone
      }

      // Confirm it is a UNIQUE index before dropping
      const idxList = db.prepare(`PRAGMA index_list('user_notification_preferences')`).all() as Array<{
        name: string;
        unique: number;
      }>;
      const meta = idxList.find(i => i.name === idx.name);
      if (!meta || !meta.unique) {
        continue; // Non-unique — leave it alone
      }

      try {
        db.exec(`DROP INDEX IF EXISTS "${idx.name}"`);
        logger.info(`Migration 079: dropped residual single-column unique index "${idx.name}" on user_notification_preferences`);
      } catch (e: any) {
        logger.warn(`Migration 079: could not drop index "${idx.name}": ${e.message}`);
      }
    }
  },
};

// PostgreSQL: belt-and-braces cleanup — same logic as migration 051 but also
// catches any single-column unique constraint that wasn't dropped by name earlier.
export async function runMigration079Postgres(client: any): Promise<void> {
  // Drop all known names first
  await client.query(`
    ALTER TABLE user_notification_preferences
    DROP CONSTRAINT IF EXISTS "user_notification_preferences_userId_unique"
  `);
  await client.query(`
    ALTER TABLE user_notification_preferences
    DROP CONSTRAINT IF EXISTS "user_notification_preferences_userId_key"
  `);

  // Drop any remaining single-column unique on userId via introspection
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

// MySQL: belt-and-braces cleanup — drop any single-column unique on userId.
export async function runMigration079Mysql(pool: any): Promise<void> {
  const [rows] = await pool.query(`
    SELECT INDEX_NAME
    FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'user_notification_preferences'
      AND NON_UNIQUE = 0
      AND SEQ_IN_INDEX = 1
      AND COLUMN_NAME = 'userId'
    GROUP BY INDEX_NAME
    HAVING COUNT(*) = 1
  `);
  for (const row of (rows as Array<{ INDEX_NAME: string }>)) {
    if (row.INDEX_NAME === 'PRIMARY') continue;
    try {
      await pool.query(
        `ALTER TABLE user_notification_preferences DROP INDEX \`${row.INDEX_NAME}\``
      );
    } catch {
      // Ignore if already gone
    }
  }
}
