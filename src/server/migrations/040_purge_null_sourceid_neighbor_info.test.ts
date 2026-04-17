/**
 * Migration 040 — Purge NULL-sourceId neighbor_info
 *
 * Validates the SQLite migration deletes rows with sourceId IS NULL,
 * preserves rows that carry a sourceId, and is idempotent on second run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './040_purge_null_sourceid_neighbor_info.js';

function createNeighborInfoTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE neighbor_info (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nodeNum INTEGER NOT NULL,
      neighborNodeNum INTEGER NOT NULL,
      snr REAL,
      lastRxTime INTEGER,
      timestamp INTEGER NOT NULL,
      createdAt INTEGER NOT NULL,
      sourceId TEXT
    )
  `);
}

function insert(db: Database.Database, sourceId: string | null) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO neighbor_info (nodeNum, neighborNodeNum, snr, lastRxTime, timestamp, createdAt, sourceId)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(0xdeadbeef, 0xcafebabe, 5.5, now, now, now, sourceId);
}

describe('Migration 040 — purge NULL-sourceId neighbor_info', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createNeighborInfoTable(db);
  });

  it('deletes rows with NULL sourceId', () => {
    insert(db, null);
    insert(db, null);
    insert(db, null);
    expect((db.prepare(`SELECT COUNT(*) c FROM neighbor_info`).get() as any).c).toBe(3);

    migration.up(db);

    expect((db.prepare(`SELECT COUNT(*) c FROM neighbor_info`).get() as any).c).toBe(0);
  });

  it('preserves rows with a non-NULL sourceId', () => {
    insert(db, 'source-A');
    insert(db, 'source-B');
    insert(db, null);

    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM neighbor_info ORDER BY sourceId`).all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.sourceId)).toEqual(['source-A', 'source-B']);
  });

  it('is idempotent — running twice is a no-op after the first pass', () => {
    insert(db, null);
    insert(db, 'source-A');

    migration.up(db);
    migration.up(db);

    const rows = db.prepare(`SELECT sourceId FROM neighbor_info`).all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceId).toBe('source-A');
  });
});
