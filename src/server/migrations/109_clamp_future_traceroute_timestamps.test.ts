/**
 * Migration 109 — Clamp future-dated traceroute timestamps (SQLite, #2768).
 *
 * The PostgreSQL/MySQL paths run the same UPDATE with backend-quoted column
 * names and are exercised by integration tests; only the SQLite path is
 * covered here.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './109_clamp_future_traceroute_timestamps.js';

interface TraceRow {
  id: number;
  timestamp: number;
  createdAt: number;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE traceroutes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    createdAt INTEGER NOT NULL
  );`);
  return db;
}

function insert(db: Database.Database, timestamp: number, createdAt: number): void {
  db.prepare('INSERT INTO traceroutes (timestamp, createdAt) VALUES (?, ?)').run(timestamp, createdAt);
}

function rows(db: Database.Database): TraceRow[] {
  return db.prepare('SELECT id, timestamp, createdAt FROM traceroutes ORDER BY id').all() as TraceRow[];
}

describe('Migration 109 — clamp future-dated traceroute timestamps (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
  });

  it('clamps a future timestamp (timestamp > createdAt) down to createdAt', () => {
    const created = 1_700_000_000_000;
    // Device clock ~28h ahead → timestamp well past createdAt (the #2768 case).
    insert(db, created + 1676 * 60_000, created);

    migration.up(db);

    expect(rows(db)[0]).toMatchObject({ timestamp: created, createdAt: created });
  });

  it('leaves legitimate rows (timestamp <= createdAt) untouched', () => {
    const created = 1_700_000_000_000;
    insert(db, created - 5_000, created); // rxTime slightly before insert — normal
    insert(db, created, created); // exactly equal — normal

    migration.up(db);

    const r = rows(db);
    expect(r[0]).toMatchObject({ timestamp: created - 5_000, createdAt: created });
    expect(r[1]).toMatchObject({ timestamp: created, createdAt: created });
  });

  it('repairs only the future rows in a mixed set', () => {
    const created = 1_700_000_000_000;
    insert(db, created + 99_000_000, created); // future → clamp
    insert(db, created - 1_000, created); // past → keep
    insert(db, created + 1, created); // 1ms future → clamp

    migration.up(db);

    const r = rows(db);
    expect(r[0].timestamp).toBe(created);
    expect(r[1].timestamp).toBe(created - 1_000);
    expect(r[2].timestamp).toBe(created);
  });

  it('is idempotent — a second run changes nothing', () => {
    const created = 1_700_000_000_000;
    insert(db, created + 100_000, created);
    migration.up(db);
    const after = rows(db);
    expect(() => migration.up(db)).not.toThrow();
    expect(rows(db)).toEqual(after);
  });
});
