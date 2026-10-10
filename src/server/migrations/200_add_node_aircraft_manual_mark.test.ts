/**
 * Tests for migration 200 — manual aircraft mark columns on `nodes` (#5715).
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './200_add_node_aircraft_manual_mark.js';

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

const COLS = ['aircraftManualMark', 'aircraftManualMarkAt', 'aircraftManualMarkBy'];

describe('Migration 200 — nodes aircraft manual-mark columns', () => {
  it('adds all three columns and is idempotent', () => {
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
    db.prepare(`UPDATE nodes SET aircraftManualMark = 'not_aircraft', aircraftManualMarkAt = ?, aircraftManualMarkBy = 3 WHERE nodeNum = 100`).run(now);
    const after = db.prepare(`SELECT ${COLS.join(', ')} FROM nodes WHERE nodeNum = 100`).get() as Record<string, unknown>;
    expect(after).toEqual({ aircraftManualMark: 'not_aircraft', aircraftManualMarkAt: now, aircraftManualMarkBy: 3 });
    db.close();
  });
});
