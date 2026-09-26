/**
 * Tests for migration 177 — aircraft age-out + fixed-mark columns on `nodes`
 * (#5364/#5365 Phase 2).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './177_add_node_aircraft_ageout.js';

function createParentTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      nodeNum INTEGER NOT NULL,
      nodeId TEXT NOT NULL,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      sourceId TEXT NOT NULL DEFAULT 'default',
      PRIMARY KEY (nodeNum, sourceId)
    )
  `);
}

const COLS = ['aircraftAgedOutAt', 'aircraftFixedAt', 'aircraftFixedLatitude', 'aircraftFixedLongitude'];

describe('Migration 177 — nodes aircraft age-out columns', () => {
  it('adds all four columns and is idempotent', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of COLS) expect(cols).toContain(c);
    db.close();
  });

  it('existing rows read null, and a write round-trips', () => {
    const db = new Database(':memory:');
    createParentTable(db);
    db.prepare(`INSERT INTO nodes (nodeNum, nodeId, createdAt, updatedAt) VALUES (100, '!00000064', 1, 1)`).run();
    migration.up(db);
    const before = db.prepare(`SELECT ${COLS.join(', ')} FROM nodes WHERE nodeNum = 100`).get() as Record<string, unknown>;
    for (const c of COLS) expect(before[c]).toBeNull();
    const now = Date.now();
    db.prepare(`UPDATE nodes SET aircraftAgedOutAt = ?, aircraftFixedAt = ?, aircraftFixedLatitude = 40.5, aircraftFixedLongitude = -105.25 WHERE nodeNum = 100`).run(now, now);
    const after = db.prepare(`SELECT ${COLS.join(', ')} FROM nodes WHERE nodeNum = 100`).get() as Record<string, unknown>;
    expect(after).toEqual({ aircraftAgedOutAt: now, aircraftFixedAt: now, aircraftFixedLatitude: 40.5, aircraftFixedLongitude: -105.25 });
    db.close();
  });
});
