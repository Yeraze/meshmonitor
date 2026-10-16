/**
 * Migration 207 (SQLite) — passkey storage (#5841).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './207_create_user_passkeys.js';

/** `users` as earlier migrations leave it: no passkey columns. */
function createUsers(db: Database.Database): void {
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      mfa_backup_codes TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.prepare(`INSERT INTO users (username, created_at) VALUES ('alice', 1), ('bob', 1)`).run();
}

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  createUsers(db);
  return db;
}

function insertPasskey(db: Database.Database, userId: number, credentialId: string): void {
  db.prepare(
    `INSERT INTO user_passkeys (user_id, credential_id, public_key, rp_id, created_at)
     VALUES (?, ?, 'pk', 'mesh.example.com', 1)`,
  ).run(userId, credentialId);
}

describe('Migration 207 — user_passkeys + users passkey columns (SQLite)', () => {
  it('adds both users columns, existing rows default to password login on', () => {
    const db = freshDb();
    migration.up(db);

    const row = db
      .prepare('SELECT password_login_disabled, passkey_recovery_codes FROM users WHERE username = ?')
      .get('alice') as Record<string, unknown>;
    expect(row.password_login_disabled).toBe(0);
    expect(row.passkey_recovery_codes).toBeNull();
    db.close();
  });

  it('creates user_passkeys with every spec column and the user index', () => {
    const db = freshDb();
    migration.up(db);

    const cols = (db.prepare('PRAGMA table_info(user_passkeys)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols.sort()).toEqual(
      [
        'id', 'user_id', 'credential_id', 'public_key', 'counter', 'transports', 'device_type',
        'backed_up', 'rp_id', 'nickname', 'created_at', 'last_used_at',
      ].sort(),
    );
    const indexes = (db.prepare('PRAGMA index_list(user_passkeys)').all() as Array<{ name: string }>).map((i) => i.name);
    expect(indexes).toContain('idx_user_passkeys_user');
    db.close();
  });

  it('is idempotent (second up() does not throw)', () => {
    const db = freshDb();
    migration.up(db);
    insertPasskey(db, 1, 'cred-a');
    expect(() => migration.up(db)).not.toThrow();
    expect((db.prepare('SELECT COUNT(*) AS n FROM user_passkeys').get() as { n: number }).n).toBe(1);
    db.close();
  });

  it('rejects a duplicate credential id', () => {
    const db = freshDb();
    migration.up(db);
    insertPasskey(db, 1, 'cred-a');
    expect(() => insertPasskey(db, 2, 'cred-a')).toThrow(/UNIQUE/);
    db.close();
  });

  it('deleting a user cascades to their passkeys only', () => {
    const db = freshDb();
    migration.up(db);
    insertPasskey(db, 1, 'cred-a');
    insertPasskey(db, 2, 'cred-b');

    db.prepare('DELETE FROM users WHERE id = 1').run();

    const left = db.prepare('SELECT credential_id FROM user_passkeys').all() as Array<{ credential_id: string }>;
    expect(left.map((r) => r.credential_id)).toEqual(['cred-b']);
    db.close();
  });
});
