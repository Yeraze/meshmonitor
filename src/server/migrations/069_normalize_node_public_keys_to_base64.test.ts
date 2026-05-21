/**
 * Tests for migration 069 (SQLite path) — convert hex-encoded
 * nodes.publicKey rows to base64.
 *
 * The migration's predicate is `length(publicKey) = 64` + JS-side regex
 * `^[0-9a-f]{64}$`, so rows that already store base64 (44 chars, mixed
 * case + `+/=`) are left alone and the migration is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './069_normalize_node_public_keys_to_base64.js';

describe('Migration 069 — normalize nodes.publicKey to base64', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Minimal table — only the columns the migration touches.
    db.exec(`
      CREATE TABLE nodes (
        nodeNum INTEGER PRIMARY KEY,
        publicKey TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('converts a hex publicKey to base64', () => {
    // 32 bytes: 0x1e c4 c0 f2 39 09 ... (rest zero)
    const hex = '1ec4c0f23909' + '00'.repeat(26);
    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(1, hex);

    migration.up(db);

    const row = db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 1`).get() as { publicKey: string };
    const expected = Buffer.from(hex, 'hex').toString('base64');
    expect(row.publicKey).toBe(expected);
    // Sanity: round-trip back to hex must match.
    expect(Buffer.from(row.publicKey, 'base64').toString('hex')).toBe(hex);
  });

  it('leaves existing base64 publicKey values alone (idempotent)', () => {
    const hex = 'deadbeef' + '00'.repeat(28);
    const base64 = Buffer.from(hex, 'hex').toString('base64');
    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(2, base64);

    migration.up(db);

    const row = db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 2`).get() as { publicKey: string };
    expect(row.publicKey).toBe(base64);
  });

  it('is idempotent when run twice', () => {
    const hex = 'aabbccdd' + '00'.repeat(28);
    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(3, hex);

    migration.up(db);
    const firstPass = (db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 3`).get() as { publicKey: string }).publicKey;
    migration.up(db);
    const secondPass = (db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 3`).get() as { publicKey: string }).publicKey;

    expect(secondPass).toBe(firstPass);
    expect(secondPass).toBe(Buffer.from(hex, 'hex').toString('base64'));
  });

  it('skips NULL publicKey rows', () => {
    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(4, null);
    expect(() => migration.up(db)).not.toThrow();
    const row = db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 4`).get() as { publicKey: string | null };
    expect(row.publicKey).toBeNull();
  });

  it('skips strings that are 64 chars but contain non-hex characters', () => {
    // Length matches the predicate but it's not actually hex — must not be
    // converted (Buffer.from(garbage, 'hex') silently truncates and would
    // produce a wrong base64 value).
    const garbage = 'g'.repeat(64);
    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(5, garbage);

    migration.up(db);

    const row = db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 5`).get() as { publicKey: string };
    expect(row.publicKey).toBe(garbage);
  });

  it('converts only the matching rows when a mix is present', () => {
    const hex = 'cafebabe' + '00'.repeat(28);
    const alreadyB64 = Buffer.from(hex, 'hex').toString('base64');

    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(10, hex);
    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(11, alreadyB64);
    db.prepare(`INSERT INTO nodes (nodeNum, publicKey) VALUES (?, ?)`).run(12, null);

    migration.up(db);

    const r10 = (db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 10`).get() as { publicKey: string }).publicKey;
    const r11 = (db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 11`).get() as { publicKey: string }).publicKey;
    const r12 = (db.prepare(`SELECT publicKey FROM nodes WHERE nodeNum = 12`).get() as { publicKey: string | null }).publicKey;

    expect(r10).toBe(alreadyB64);
    expect(r11).toBe(alreadyB64);
    expect(r12).toBeNull();
  });
});
