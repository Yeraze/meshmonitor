/**
 * Migration 116 — Trim out-of-range node positions (SQLite path).
 *
 * Verifies the one-shot cleanup NULLs junk coordinates (the observed MeshCore
 * advert garbage), leaves valid and already-null positions untouched, and is
 * idempotent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './116_trim_out_of_range_node_positions.js';

function createNodesTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE nodes (
      nodeId TEXT PRIMARY KEY,
      latitude REAL,
      longitude REAL,
      longName TEXT
    );
  `);
}

function insert(db: Database.Database, nodeId: string, lat: number | null, lng: number | null) {
  db.prepare('INSERT INTO nodes (nodeId, latitude, longitude, longName) VALUES (?, ?, ?, ?)')
    .run(nodeId, lat, lng, nodeId);
}

function pos(db: Database.Database, nodeId: string) {
  return db.prepare('SELECT latitude, longitude FROM nodes WHERE nodeId = ?').get(nodeId) as {
    latitude: number | null;
    longitude: number | null;
  };
}

describe('Migration 116: trim out-of-range node positions (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createNodesTable(db);
    insert(db, 'valid-fl', 26.331349, -80.268578); // real South Florida node
    insert(db, 'extreme-lat', 1853.453892, 1819.635571); // both out of range
    insert(db, 'neg-lat', -471.156916, 595.308254);
    insert(db, 'lat-just-over', 90.62051, -1598.745966); // lat barely > 90, lng far out
    insert(db, 'lng-only', 26.33, 540.16); // valid lat, out-of-range lng
    insert(db, 'edge-valid', 90, -180); // exact extremes are valid
    insert(db, 'null-island', 0, 0); // in-range (left to runtime filters)
    insert(db, 'no-position', null, null);
  });

  it('NULLs both coordinates of every out-of-range row', () => {
    migration.up(db);
    for (const id of ['extreme-lat', 'neg-lat', 'lat-just-over', 'lng-only']) {
      expect(pos(db, id)).toEqual({ latitude: null, longitude: null });
    }
  });

  it('leaves valid, edge-valid, null-island, and positionless rows untouched', () => {
    migration.up(db);
    expect(pos(db, 'valid-fl')).toEqual({ latitude: 26.331349, longitude: -80.268578 });
    expect(pos(db, 'edge-valid')).toEqual({ latitude: 90, longitude: -180 });
    expect(pos(db, 'null-island')).toEqual({ latitude: 0, longitude: 0 });
    expect(pos(db, 'no-position')).toEqual({ latitude: null, longitude: null });
  });

  it('is idempotent — a second run changes nothing', () => {
    migration.up(db);
    const snapshot = db.prepare('SELECT nodeId, latitude, longitude FROM nodes ORDER BY nodeId').all();
    migration.up(db);
    const after = db.prepare('SELECT nodeId, latitude, longitude FROM nodes ORDER BY nodeId').all();
    expect(after).toEqual(snapshot);
  });
});
