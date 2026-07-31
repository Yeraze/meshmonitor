import { describe, it, expect, beforeEach } from 'vitest';
import DatabaseConstructor from 'better-sqlite3';
import type { Database } from 'better-sqlite3';
import { migration } from './134_clear_null_island_estimates.js';
import { NULL_ISLAND_EPSILON } from '../../utils/nullIsland.js';

/**
 * Migration 134 (#4432 follow-up): estimated positions solved onto Null Island
 * are not positions. Migration 107 swept `nodes` / `meshcore_nodes` / `telemetry`
 * but never this table, so bogus rows survived and were re-substituted onto the
 * very nodes whose real (0,0) fix 107 had just cleared.
 */
describe('migration 134: clear Null Island estimated positions', () => {
  let db: Database;

  const insert = (nodeNum: number, lat: number | null, lon: number | null) =>
    db
      .prepare(
        `INSERT INTO estimated_positions (nodeNum, nodeId, latitude, longitude, uncertaintyKm, observationCount, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(nodeNum, `!${nodeNum.toString(16).padStart(8, '0')}`, lat, lon, 0.05, 2, Date.now());

  const remaining = () =>
    db.prepare('SELECT nodeNum FROM estimated_positions ORDER BY nodeNum').all().map((r: any) => r.nodeNum);

  beforeEach(() => {
    db = new DatabaseConstructor(':memory:');
    db.exec(`
      CREATE TABLE estimated_positions (
        nodeNum INTEGER PRIMARY KEY,
        nodeId TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        uncertaintyKm REAL,
        observationCount INTEGER,
        updatedAt INTEGER
      )
    `);
  });

  it('deletes rows at exactly (0,0)', () => {
    insert(1, 0, 0);
    insert(2, 35.1, -80.6);

    migration.up(db);

    expect(remaining()).toEqual([2]);
  });

  it('deletes rows within the shared Null Island epsilon', () => {
    // The firmware "garbage default" fixes migration 107 documents: 2^15 and
    // 2^16 in 1e-7 degrees land just inside the 0.01 radius.
    insert(1, 0.0032768, 0.0032768);
    insert(2, 0.0065536, 0.0065536);

    migration.up(db);

    expect(remaining()).toEqual([]);
  });

  // The radius only rejects a coordinate near BOTH axes, so a genuine node on
  // the equator or the prime meridian must survive — that distinction is the
  // whole reason Null Island filtering is a two-axis test.
  it('keeps a real equator or prime-meridian estimate', () => {
    insert(1, 0, 37.5);           // equator, Kenya
    insert(2, 51.48, 0);          // prime meridian, Greenwich
    insert(3, 0, -0.5);           // on the equator, just outside the radius

    migration.up(db);

    expect(remaining()).toEqual([1, 2, 3]);
  });

  it('keeps a coordinate just outside the epsilon on both axes', () => {
    const outside = NULL_ISLAND_EPSILON * 1.5;
    insert(1, outside, outside);

    migration.up(db);

    expect(remaining()).toEqual([1]);
  });

  it('leaves rows with NULL coordinates alone', () => {
    insert(1, null, null);

    migration.up(db);

    expect(remaining()).toEqual([1]);
  });

  it('is idempotent', () => {
    insert(1, 0, 0);
    insert(2, 35.1, -80.6);

    migration.up(db);
    migration.up(db);
    migration.up(db);

    expect(remaining()).toEqual([2]);
  });
});
