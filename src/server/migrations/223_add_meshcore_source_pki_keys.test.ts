/**
 * migration 223 (#6195) — creates `meshcore_source_pki_keys` on SQLite and is
 * idempotent. PG/MySQL coverage lives in the `.pgmysql.test.ts` sibling (runs
 * in CI against service containers).
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './223_add_meshcore_source_pki_keys.js';

describe('migration 223 — SQLite', () => {
  it('creates the table with the expected columns and is idempotent', () => {
    const db = new Database(':memory:');
    migration.up(db);
    migration.up(db); // idempotent: CREATE TABLE IF NOT EXISTS

    const cols = (db.prepare(`PRAGMA table_info(meshcore_source_pki_keys)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual(['sourceId', 'encryptedPrivateKey', 'publicKey', 'keyMismatch', 'createdAt', 'updatedAt']);
    db.close();
  });

  it('keyMismatch defaults to 0 and sourceId is the primary key', () => {
    const db = new Database(':memory:');
    migration.up(db);
    db.prepare(
      `INSERT INTO meshcore_source_pki_keys (sourceId, encryptedPrivateKey, createdAt, updatedAt) VALUES ('s1', '{}', 1, 1)`,
    ).run();
    const row = db.prepare(`SELECT keyMismatch FROM meshcore_source_pki_keys WHERE sourceId = 's1'`).get() as {
      keyMismatch: number;
    };
    expect(row.keyMismatch).toBe(0);
    expect(() =>
      db.prepare(
        `INSERT INTO meshcore_source_pki_keys (sourceId, encryptedPrivateKey, createdAt, updatedAt) VALUES ('s1', '{}', 2, 2)`,
      ).run(),
    ).toThrow(/UNIQUE|PRIMARY/);
    db.close();
  });
});
