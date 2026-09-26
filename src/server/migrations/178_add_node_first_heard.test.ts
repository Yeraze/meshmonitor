/**
 * Tests for migration 178 — `firstHeard` on `nodes` (seconds) and
 * `meshcore_nodes` (ms), with backfill (#5390).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './178_add_node_first_heard.js';

const NOW_MS = Date.now();
const NOW_S = Math.floor(NOW_MS / 1000);
const DAY_S = 86_400;

function createTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      nodeId TEXT NOT NULL,
      lastHeard INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      sourceId TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (nodeNum, sourceId)
    );
    CREATE TABLE meshcore_nodes (
      publicKey TEXT NOT NULL,
      lastHeard INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      PRIMARY KEY (publicKey, sourceId)
    );
  `);
}

const fh = (db: Database.Database, sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { firstHeard: number | null }).firstHeard;

describe('Migration 178 — firstHeard', () => {
  it('adds the column to both tables and is idempotent', () => {
    const db = new Database(':memory:');
    createTables(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    for (const t of ['nodes', 'meshcore_nodes']) {
      const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('firstHeard');
    }
    db.close();
  });

  it('backfills nodes (seconds) from the earlier of createdAt and lastHeard', () => {
    const db = new Database(':memory:');
    createTables(db);
    const ins = db.prepare('INSERT INTO nodes (nodeNum, nodeId, lastHeard, createdAt, updatedAt, sourceId) VALUES (?, ?, ?, ?, ?, ?)');
    // createdAt (ms) earlier than lastHeard -> createdAt/1000
    ins.run(1, '!1', NOW_S - DAY_S, (NOW_S - 10 * DAY_S) * 1000, NOW_MS, 'a');
    // lastHeard earlier than createdAt (device NodeDB replay) -> lastHeard
    ins.run(2, '!2', NOW_S - 30 * DAY_S, (NOW_S - DAY_S) * 1000, NOW_MS, 'a');
    // never heard -> stays null
    ins.run(3, '!3', null, NOW_MS, NOW_MS, 'a');
    // bogus createdAt -> falls back to lastHeard
    ins.run(4, '!4', NOW_S - 5, 1, NOW_MS, 'a');
    // same node, other source: independent value
    ins.run(1, '!1', NOW_S - DAY_S, (NOW_S - 2 * DAY_S) * 1000, NOW_MS, 'b');
    migration.up(db);
    const q = 'SELECT firstHeard FROM nodes WHERE nodeNum = ? AND sourceId = ?';
    expect(fh(db, q, 1, 'a')).toBe(NOW_S - 10 * DAY_S);
    expect(fh(db, q, 2, 'a')).toBe(NOW_S - 30 * DAY_S);
    expect(fh(db, q, 3, 'a')).toBeNull();
    expect(fh(db, q, 4, 'a')).toBe(NOW_S - 5);
    expect(fh(db, q, 1, 'b')).toBe(NOW_S - 2 * DAY_S);
    db.close();
  });

  it('backfills meshcore_nodes (ms) and ignores a drifted lastHeard', () => {
    const db = new Database(':memory:');
    createTables(db);
    const ins = db.prepare('INSERT INTO meshcore_nodes (publicKey, lastHeard, createdAt, updatedAt, sourceId) VALUES (?, ?, ?, ?, ?)');
    ins.run('k1', NOW_MS - 1000, NOW_MS - 5 * DAY_S * 1000, NOW_MS, 'a');
    ins.run('k2', Date.UTC(2087, 0, 1), NOW_MS - 2 * DAY_S * 1000, NOW_MS, 'a');
    ins.run('k3', null, NOW_MS, NOW_MS, 'a');
    migration.up(db);
    const q = 'SELECT firstHeard FROM meshcore_nodes WHERE publicKey = ?';
    expect(fh(db, q, 'k1')).toBe(NOW_MS - 5 * DAY_S * 1000);
    expect(fh(db, q, 'k2')).toBe(NOW_MS - 2 * DAY_S * 1000);
    expect(fh(db, q, 'k3')).toBeNull();
    db.close();
  });

  it('does not overwrite an existing firstHeard on re-run', () => {
    const db = new Database(':memory:');
    createTables(db);
    migration.up(db);
    db.prepare('INSERT INTO nodes (nodeNum, nodeId, lastHeard, firstHeard, createdAt, updatedAt) VALUES (9, ?, ?, ?, ?, ?)')
      .run('!9', NOW_S, NOW_S - 100, (NOW_S - 999) * 1000, NOW_MS);
    migration.up(db);
    expect(fh(db, 'SELECT firstHeard FROM nodes WHERE nodeNum = 9')).toBe(NOW_S - 100);
    db.close();
  });
});
