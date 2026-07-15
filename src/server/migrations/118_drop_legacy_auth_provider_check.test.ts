/**
 * Migration 118 — Drop legacy `CHECK (auth_provider IN ('local', 'oidc'))`
 * from SQLite `users`.
 *
 * Asserts:
 *   - on a database created with the legacy CHECK, the migration rebuilds
 *     the table and the constraint is gone (authMethod = 'proxy' now inserts).
 *   - existing rows + ids are preserved across the rebuild.
 *   - on a database without the CHECK (v3.7+ baseline), the migration is a
 *     no-op and leaves the table untouched.
 *   - re-running is idempotent (second pass is a no-op).
 *   - PG / MySQL paths are no-ops (no constraint to drop there).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  migration,
  runMigration118Postgres,
  runMigration118Mysql,
} from './118_drop_legacy_auth_provider_check.js';

// Mirrors a pre-v3.7 `users` schema, including the legacy CHECK constraint
// removed by the v3.7 baseline.
function createLegacyUsersTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
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
      updated_at INTEGER,
      CHECK (auth_provider IN ('local', 'oidc'))
    );
  `);
}

// Mirrors the v3.7 baseline shape — no CHECK constraint on auth_provider.
function createBaselineUsersTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE users (
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
    );
  `);
}

function getUsersSql(db: Database.Database): string {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='users'`)
    .get() as { sql?: string } | undefined;
  return row?.sql ?? '';
}

describe('Migration 118 — drop legacy auth_provider CHECK constraint', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  it('rebuilds a legacy table and removes the CHECK constraint', () => {
    createLegacyUsersTable(db);

    // Sanity check: legacy table rejects authProvider = 'proxy' before the migration.
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (username, auth_provider, created_at)
             VALUES ('proxyuser', 'proxy', 0)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);

    migration.up(db);

    const sql = getUsersSql(db);
    expect(sql).not.toMatch(/auth_provider IN \('local', 'oidc'\)/);
    expect(sql).not.toMatch(/CHECK\s*\([^)]*auth_provider/i);

    // Now the proxy auto-provisioning insert succeeds.
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (username, auth_provider, created_at)
             VALUES ('proxyuser', 'proxy', 0)`,
        )
        .run(),
    ).not.toThrow();

    const row = db
      .prepare(`SELECT username, auth_provider FROM users WHERE username = 'proxyuser'`)
      .get() as { username: string; auth_provider: string };
    expect(row).toEqual({ username: 'proxyuser', auth_provider: 'proxy' });
  });

  it('preserves existing rows + ids across the rebuild', () => {
    createLegacyUsersTable(db);

    db.prepare(
      `INSERT INTO users (id, username, auth_provider, created_at)
         VALUES (?, ?, ?, ?)`,
    ).run(5, 'admin', 'local', 0);
    db.prepare(
      `INSERT INTO users (id, username, auth_provider, created_at)
         VALUES (?, ?, ?, ?)`,
    ).run(8, 'ssouser', 'oidc', 0);

    migration.up(db);

    const rows = db
      .prepare(`SELECT id, username, auth_provider FROM users ORDER BY id`)
      .all() as Array<{ id: number; username: string; auth_provider: string }>;
    expect(rows).toEqual([
      { id: 5, username: 'admin', auth_provider: 'local' },
      { id: 8, username: 'ssouser', auth_provider: 'oidc' },
    ]);
  });

  it('is a no-op on a v3.7 baseline table', () => {
    createBaselineUsersTable(db);
    const before = getUsersSql(db);

    migration.up(db);

    const after = getUsersSql(db);
    expect(after).toBe(before);
  });

  it('is idempotent — second run after a rebuild is a no-op', () => {
    createLegacyUsersTable(db);
    migration.up(db);
    const afterFirst = getUsersSql(db);

    migration.up(db);
    const afterSecond = getUsersSql(db);
    expect(afterSecond).toBe(afterFirst);
  });

  it('handles legacy schemas missing later-added columns', () => {
    // Some very early pre-v3.7 schemas lacked updated_at / created_by (added
    // by later migrations whose work is now folded into the baseline).
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT,
        email TEXT,
        display_name TEXT,
        auth_provider TEXT NOT NULL DEFAULT 'local',
        oidc_subject TEXT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        mfa_enabled INTEGER NOT NULL DEFAULT 0,
        mfa_secret TEXT,
        mfa_backup_codes TEXT,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER,
        CHECK (auth_provider IN ('local', 'oidc'))
      );
    `);
    db.prepare(
      `INSERT INTO users (id, username, auth_provider, created_at)
         VALUES (?, ?, ?, ?)`,
    ).run(1, 'old', 'local', 0);

    expect(() => migration.up(db)).not.toThrow();

    const row = db
      .prepare(`SELECT id, username, auth_provider, is_active FROM users`)
      .get() as Record<string, number | string>;
    expect(row.id).toBe(1);
    expect(row.username).toBe('old');
    expect(row.auth_provider).toBe('local');
    expect(row.is_active).toBe(1);
  });

  it('PostgreSQL and MySQL paths are no-ops', async () => {
    await expect(runMigration118Postgres({} as unknown as never)).resolves.toBeUndefined();
    await expect(runMigration118Mysql({} as unknown as never)).resolves.toBeUndefined();
  });
});
