/**
 * Migration 122 — Clean up orphaned `nodes` rows (SQLite path, issue #4137).
 *
 * Verifies the one-shot sweep deletes node rows whose sourceId no longer
 * matches any row in `sources`, leaves rows for live sources untouched, and
 * is idempotent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { migration } from './122_cleanup_orphaned_source_nodes.js';

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE sources (
      id TEXT PRIMARY KEY,
      name TEXT
    );
    CREATE TABLE nodes (
      nodeNum INTEGER NOT NULL,
      sourceId TEXT NOT NULL,
      longName TEXT,
      hideFromMap INTEGER DEFAULT 0,
      PRIMARY KEY (nodeNum, sourceId)
    );
  `);
}

function insertNode(db: Database.Database, nodeNum: number, sourceId: string, hideFromMap = 0) {
  db.prepare('INSERT INTO nodes (nodeNum, sourceId, longName, hideFromMap) VALUES (?, ?, ?, ?)')
    .run(nodeNum, sourceId, `Node ${nodeNum}`, hideFromMap);
}

function nodeCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
}

function nodeExists(db: Database.Database, nodeNum: number, sourceId: string): boolean {
  return db.prepare('SELECT 1 FROM nodes WHERE nodeNum = ? AND sourceId = ?').get(nodeNum, sourceId) != null;
}

describe('Migration 122: cleanup orphaned source nodes (SQLite)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createTables(db);
    db.prepare('INSERT INTO sources (id, name) VALUES (?, ?)').run('live-source', 'Live Source');

    // Live rows — sourceId matches a real `sources` row.
    insertNode(db, 1, 'live-source');
    insertNode(db, 2, 'live-source', 1);

    // Orphaned rows — sourceId points at a source that no longer exists
    // (the exact scenario from #4137: a deleted source's stale hideFromMap
    // leaking into the unified merge forever).
    insertNode(db, 3, 'deleted-source-a', 1);
    insertNode(db, 4, 'deleted-source-b');
  });

  it('deletes every node row whose sourceId has no matching sources row', () => {
    migration.up(db);
    expect(nodeExists(db, 3, 'deleted-source-a')).toBe(false);
    expect(nodeExists(db, 4, 'deleted-source-b')).toBe(false);
  });

  it('leaves rows for live sources untouched', () => {
    migration.up(db);
    expect(nodeExists(db, 1, 'live-source')).toBe(true);
    expect(nodeExists(db, 2, 'live-source')).toBe(true);
  });

  it('is idempotent — a second run changes nothing further', () => {
    migration.up(db);
    const countAfterFirst = nodeCount(db);
    migration.up(db);
    expect(nodeCount(db)).toBe(countAfterFirst);
    expect(countAfterFirst).toBe(2);
  });
});
