/**
 * Tests for migration 214 — re-check columns on `aircraft_flight_matches` (#5876).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './214_add_aircraft_flight_match_rechecks.js';

function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS aircraft_flight_matches (
      sourceId TEXT NOT NULL,
      nodeNum INTEGER NOT NULL,
      episodeStartedAt INTEGER NOT NULL,
      lookups INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'none',
      PRIMARY KEY (sourceId, nodeNum)
    )
  `);
}

const COLS = ['lastLookupAt', 'lastLookupLat', 'lastLookupLon', 'rechecks', 'misses'];

describe('Migration 214 — aircraft_flight_matches re-check columns', () => {
  it('adds all five columns and is idempotent', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(aircraft_flight_matches)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of COLS) expect(cols).toContain(c);
    db.close();
  });

  it('existing rows read null position/time and zero counters; a write round-trips', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`INSERT INTO aircraft_flight_matches (sourceId, nodeNum, episodeStartedAt, lookups) VALUES ('src-a', 100, 1, 2)`).run();
    migration.up(db);
    const before = db.prepare(`SELECT ${COLS.join(', ')} FROM aircraft_flight_matches WHERE nodeNum = 100`).get();
    expect(before).toEqual({ lastLookupAt: null, lastLookupLat: null, lastLookupLon: null, rechecks: 0, misses: 0 });
    const now = Date.now();
    db.prepare(
      `UPDATE aircraft_flight_matches SET lastLookupAt = ?, lastLookupLat = 25.8, lastLookupLon = -80.3, rechecks = 3, misses = 1 WHERE nodeNum = 100`,
    ).run(now);
    const after = db.prepare(`SELECT ${COLS.join(', ')} FROM aircraft_flight_matches WHERE nodeNum = 100`).get();
    expect(after).toEqual({ lastLookupAt: now, lastLookupLat: 25.8, lastLookupLon: -80.3, rechecks: 3, misses: 1 });
    db.close();
  });
});
