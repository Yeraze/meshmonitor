/**
 * migration 240 — creates `script_secrets` on SQLite and is idempotent.
 * PG/MySQL coverage lives in the `.pgmysql.test.ts` sibling (runs in CI
 * against service containers).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './240_add_script_secrets.js';

describe('migration 240 — SQLite', () => {
  it('creates the table with the expected columns and is idempotent', () => {
    const db = new Database(':memory:');
    migration.up(db);
    migration.up(db); // idempotent: CREATE TABLE IF NOT EXISTS

    const cols = (db.prepare(`PRAGMA table_info(script_secrets)`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['name', 'encryptedValue', 'createdAt', 'updatedAt']);
    db.close();
  });

  it('name is the primary key', () => {
    const db = new Database(':memory:');
    migration.up(db);
    db.prepare(`INSERT INTO script_secrets (name, encryptedValue, createdAt, updatedAt) VALUES ('A', '{}', 1, 1)`).run();
    expect(() =>
      db.prepare(`INSERT INTO script_secrets (name, encryptedValue, createdAt, updatedAt) VALUES ('A', '{}', 2, 2)`).run(),
    ).toThrow(/UNIQUE|PRIMARY/);
    db.close();
  });
});
