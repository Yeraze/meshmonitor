/**
 * Migration 118: Drop the legacy `CHECK (auth_provider IN ('local', 'oidc'))`
 * constraint from `users` on SQLite installs that pre-date the v3.7 baseline.
 *
 * Proxy auth (`PROXY_AUTH_ENABLED=true`, issue #4119) auto-provisions/migrates
 * users with `authMethod: 'proxy'`, which Drizzle writes to the `auth_provider`
 * column. On databases created before the v3.7 baseline (migration 001), the
 * `users` table carries an old CHECK constraint that only permits `local` or
 * `oidc`, so the insert/update fails:
 *
 *   SqliteError: CHECK constraint failed: auth_provider IN ('local', 'oidc')
 *
 * The v3.7 baseline `CREATE TABLE IF NOT EXISTS users` (migration 001) has no
 * such constraint, but `IF NOT EXISTS` leaves pre-existing tables untouched,
 * so upgraded installs keep the legacy constraint forever without an explicit
 * rebuild.
 *
 * This migration:
 *   - SQLite: detects the legacy CHECK by inspecting `sqlite_master.sql`,
 *     and if present rebuilds the table without it (preserves rows + ids).
 *   - PostgreSQL / MySQL: no-op. The constraint only ever lived in SQLite.
 */
import type { Database } from 'better-sqlite3';
import { logger } from '../../utils/logger.js';

const LABEL = 'Migration 118';
const TABLE = 'users';

// ============ SQLite ============

export const migration = {
  up: (db: Database): void => {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(TABLE) as { sql?: string } | undefined;
    const sql = row?.sql ?? '';

    const hasLegacyCheck = /CHECK\s*\([^)]*auth_provider[^)]*\)/i.test(sql);
    if (!hasLegacyCheck) {
      logger.debug(`${LABEL} (SQLite): no legacy auth_provider CHECK on ${TABLE}, skipping`);
      return;
    }

    logger.info(`${LABEL} (SQLite): rebuilding ${TABLE} to drop legacy auth_provider CHECK constraint`);

    // SQLite cannot drop a CHECK constraint in place. Standard table-rebuild
    // dance: create a new table with the desired schema, copy rows, drop the
    // old table, rename. FK enforcement is toggled off so dropping the table
    // doesn't trip references from permissions/audit_log/etc, then re-enabled.
    const fkOn = (db.pragma('foreign_keys', { simple: true }) as 0 | 1) === 1;
    if (fkOn) db.pragma('foreign_keys = OFF');

    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT,
          email TEXT,
          display_name TEXT,
          auth_provider TEXT NOT NULL DEFAULT 'local',
          oidc_subject TEXT,
          is_admin INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          password_locked INTEGER DEFAULT 0,
          mfa_enabled INTEGER NOT NULL DEFAULT 0,
          mfa_secret TEXT,
          mfa_backup_codes TEXT,
          created_at INTEGER NOT NULL,
          last_login_at INTEGER,
          created_by INTEGER,
          updated_at INTEGER
        )
      `);

      // Build the column list from the legacy table's actual columns so the
      // copy works against any historical shape (some very old schemas may
      // be missing later-added columns like updated_at or created_by).
      const legacyCols = (
        db.prepare(`PRAGMA table_info(${TABLE})`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      const newCols = [
        'id',
        'username',
        'password_hash',
        'email',
        'display_name',
        'auth_provider',
        'oidc_subject',
        'is_admin',
        'is_active',
        'password_locked',
        'mfa_enabled',
        'mfa_secret',
        'mfa_backup_codes',
        'created_at',
        'last_login_at',
        'created_by',
        'updated_at',
      ];
      const shared = newCols.filter((c) => legacyCols.includes(c));
      const colList = shared.join(', ');
      db.exec(`INSERT INTO users_new (${colList}) SELECT ${colList} FROM ${TABLE}`);

      db.exec(`DROP TABLE ${TABLE}`);
      db.exec(`ALTER TABLE users_new RENAME TO ${TABLE}`);

      logger.debug(`${LABEL} (SQLite): rebuild complete`);
    } finally {
      if (fkOn) db.pragma('foreign_keys = ON');
    }
  },

  down: (_db: Database): void => {
    logger.debug(`${LABEL} down: not implemented (re-adding the legacy CHECK would re-break proxy auth)`);
  },
};

// ============ PostgreSQL ============

export async function runMigration118Postgres(_client: import('pg').PoolClient): Promise<void> {
  logger.debug(`${LABEL} (PostgreSQL): no-op (auth_provider CHECK constraint never existed in PG schema)`);
}

// ============ MySQL ============

export async function runMigration118Mysql(_pool: import('mysql2/promise').Pool): Promise<void> {
  logger.debug(`${LABEL} (MySQL): no-op (auth_provider CHECK constraint never existed in MySQL schema)`);
}
