/**
 * Migration 189 — packet_log(sourceId, timestamp) index (#5557), SQLite.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration, PACKET_LOG_SOURCE_TIMESTAMP_INDEX } from './189_packet_log_source_timestamp_index.js';

function createPacketLog(db: Database.Database): void {
  db.exec(`
    CREATE TABLE packet_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packet_id INTEGER,
      timestamp INTEGER NOT NULL,
      from_node INTEGER NOT NULL,
      portnum INTEGER NOT NULL,
      encrypted INTEGER NOT NULL,
      created_at INTEGER,
      sourceId TEXT
    )
  `);
}

describe('Migration 189 — packet_log source/timestamp index (SQLite)', () => {
  it('creates the index on (sourceId, timestamp) and is idempotent', () => {
    const db = new Database(':memory:');
    createPacketLog(db);

    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();

    const cols = (db.prepare(`PRAGMA index_info(${PACKET_LOG_SOURCE_TIMESTAMP_INDEX})`).all() as Array<{ name: string; seqno: number }>)
      .sort((a, b) => a.seqno - b.seqno)
      .map((c) => c.name);
    expect(cols).toEqual(['sourceId', 'timestamp']);
    db.close();
  });

  it('the planner uses it for the node-activity window filter', () => {
    const db = new Database(':memory:');
    createPacketLog(db);
    migration.up(db);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN SELECT from_node FROM packet_log WHERE sourceId = ? AND timestamp >= ?`).all('a', 0) as Array<{ detail: string }>)
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toContain(PACKET_LOG_SOURCE_TIMESTAMP_INDEX);
    db.close();
  });
});
