/**
 * Migration 115: Drop an inline (autoindex) single-column UNIQUE constraint
 * on user_notification_preferences.user_id that migration 079 cannot see.
 *
 * Migration 079 (issue #3324) introspects `sqlite_master` for indexes with
 * `sql IS NOT NULL` to find and drop residual single-column unique indexes on
 * user_id. That query only matches indexes created via an explicit
 * `CREATE [UNIQUE] INDEX` statement — it structurally cannot see a UNIQUE
 * constraint declared inline on the column (`user_id INTEGER UNIQUE`), which
 * SQLite implements as an autoindex (`sqlite_autoindex_*`) with `sql = NULL`
 * in `sqlite_master`. Some databases carry exactly this kind of constraint
 * (e.g. from an early `drizzle-kit push` before the migration system existed),
 * so migration 079 silently left it in place and the per-source upsert in
 * `saveUserPreferences` continues to fail with:
 *
 *   SqliteError: UNIQUE constraint failed: user_notification_preferences.user_id
 *
 * on the second source a user configures notifications for (issue #4044,
 * a recurrence of #3324).
 *
 * SQLite refuses to `DROP INDEX` an autoindex directly ("index associated
 * with UNIQUE or PRIMARY KEY constraint cannot be dropped"), so removing it
 * requires the standard table-rebuild procedure: recreate the table from its
 * live column list (which never re-states the inline UNIQUE), copy the data,
 * and reinstate the composite (user_id, source_id) index.
 *
 * Idempotent — the PRAGMA index_list check is a no-op if the inline
 * constraint isn't present, which is the common case (fresh installs and any
 * database that only ever had the named indexes migrations 015/079 handled).
 *
 * PostgreSQL/MySQL: an inline UNIQUE column constraint there produces a
 * normal, introspectable constraint/index (no autoindex quirk), so migration
 * 079's PG/MySQL paths already catch it. No-op here.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
}

interface IndexInfoRow {
  name: string;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const hasTable = db
      .prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='user_notification_preferences'")
      .get() as { count: number };
    if (hasTable.count === 0) {
      logger.debug('Migration 115 (SQLite): user_notification_preferences does not exist, skipping');
      return;
    }

    const indexList = db.prepare(`PRAGMA index_list('user_notification_preferences')`).all() as IndexListRow[];
    const inlineUniqueOnUserId = indexList.find((idx) => {
      if (!idx.unique || idx.origin !== 'u') return false;
      const cols = db.prepare(`PRAGMA index_info("${idx.name}")`).all() as IndexInfoRow[];
      return cols.length === 1 && cols[0].name === 'user_id';
    });

    if (!inlineUniqueOnUserId) {
      logger.debug('Migration 115 (SQLite): no inline unique(user_id) on user_notification_preferences, skipping');
      return;
    }

    logger.info(
      `Migration 115 (SQLite): found inline autoindex unique "${inlineUniqueOnUserId.name}" on user_notification_preferences.user_id — rebuilding table to remove it`
    );

    // Column defs are read live from the table rather than hardcoded so the
    // rebuild can't drift from whatever ADD COLUMN migrations (012/018/076/080/028)
    // have already applied by the time migration 115 runs.
    const columns = db.prepare(`PRAGMA table_info('user_notification_preferences')`).all() as TableInfoRow[];
    const colDefs = columns
      .map((c) => {
        let def = `"${c.name}" ${c.type}`;
        if (c.pk) {
          def += ' PRIMARY KEY AUTOINCREMENT';
        } else {
          if (c.notnull) def += ' NOT NULL';
          if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
        }
        return def;
      })
      .join(',\n        ');
    const colNames = columns.map((c) => `"${c.name}"`).join(', ');

    // Snapshot named (non-autoindex) indexes so they can be recreated after
    // the rebuild. The inline-unique autoindex we're removing has no `sql`
    // text and is deliberately excluded — that's what drops it.
    const existingIndexes = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'user_notification_preferences' AND sql IS NOT NULL
    `).all() as Array<{ name: string; sql: string }>;

    const prevForeignKeys = db.pragma('foreign_keys', { simple: true }) as number;
    if (prevForeignKeys) db.pragma('foreign_keys = OFF');
    const prevLegacyAlter = db.pragma('legacy_alter_table', { simple: true }) as number;
    if (!prevLegacyAlter) db.pragma('legacy_alter_table = ON');

    const tx = db.transaction(() => {
      db.exec(`
        CREATE TABLE user_notification_preferences_rebuild_115 (
        ${colDefs},
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        INSERT INTO user_notification_preferences_rebuild_115 (${colNames})
        SELECT ${colNames} FROM user_notification_preferences
      `);
      db.exec(`DROP TABLE user_notification_preferences`);
      db.exec(`ALTER TABLE user_notification_preferences_rebuild_115 RENAME TO user_notification_preferences`);

      for (const idx of existingIndexes) {
        try {
          db.exec(idx.sql);
        } catch (err) {
          logger.warn(`Migration 115 (SQLite): failed to recreate index ${idx.name}:`, err);
        }
      }

      // Belt-and-suspenders: make sure the composite unique exists even if
      // the snapshot above found nothing to recreate (e.g. an even older
      // database that never had it named as expected).
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notification_preferences_user_source
        ON user_notification_preferences(user_id, source_id)
      `);
    });

    try {
      tx();
    } finally {
      if (prevForeignKeys) db.pragma('foreign_keys = ON');
      if (!prevLegacyAlter) db.pragma('legacy_alter_table = OFF');
    }

    logger.info('Migration 115 (SQLite): rebuilt user_notification_preferences without inline unique(user_id)');
  },
};

// ============ PostgreSQL ============

export async function runMigration115Postgres(_client: import('pg').PoolClient): Promise<void> {
  // An inline UNIQUE column constraint in PostgreSQL produces a regular,
  // introspectable constraint — migration 079's pg_constraint-based sweep
  // already catches it regardless of how it was declared. No-op.
  logger.debug('Migration 115 (PostgreSQL): no-op (079 already covers inline unique constraints on PG)');
}

// ============ MySQL ============

export async function runMigration115Mysql(_pool: import('mysql2/promise').Pool): Promise<void> {
  // Same reasoning as PostgreSQL: MySQL surfaces inline UNIQUE columns as
  // ordinary indexes in information_schema.STATISTICS, already handled by 079.
  logger.debug('Migration 115 (MySQL): no-op (079 already covers inline unique constraints on MySQL)');
}
