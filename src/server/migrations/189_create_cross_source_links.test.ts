/**
 * Migration 189 tests — cross_source_links table creation (#5561).
 * PostgreSQL / MySQL run the same runners against live containers in
 * `src/db/repositories/crossSourceLinks.multiBackend.test.ts`.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './189_create_cross_source_links.js';

const ROW = {
  txSourceId: 'a', txNodeId: '!aaaaaaaa', rxSourceId: 'b', rxNodeId: '!bbbbbbbb',
  protocol: 'meshtastic', kind: 'origin', transportClass: 'rf', hourBucket: 3_600_000, lastHeardAt: 3_600_500,
};
const INSERT = `
  INSERT INTO cross_source_links (txSourceId, txNodeId, rxSourceId, rxNodeId, protocol, kind, transportClass, hourBucket, lastHeardAt)
  VALUES (@txSourceId, @txNodeId, @rxSourceId, @rxNodeId, @protocol, @kind, @transportClass, @hourBucket, @lastHeardAt)
`;

describe('Migration 189 — cross_source_links (SQLite)', () => {
  it('creates the table and indexes, and is idempotent', () => {
    const db = new Database(':memory:');
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'cross_source_links'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['cross_source_links', 'xs_links_bucket_uniq', 'xs_links_bucket_idx']));
    db.close();
  });

  it('defaults the counters to 0 and leaves the stats null', () => {
    const db = new Database(':memory:');
    migration.up(db);
    db.prepare(INSERT).run(ROW);
    const row = db.prepare(`SELECT * FROM cross_source_links`).get() as Record<string, unknown>;
    expect(row).toMatchObject({ count: 0, snrCount: 0, rssiCount: 0, snrMin: null, snrAvg: null, snrMax: null, rssiAvg: null });
    db.close();
  });

  it('one row per (edge, kind, transport, hour): a duplicate bucket is rejected, another hour is not', () => {
    const db = new Database(':memory:');
    migration.up(db);
    const insert = db.prepare(INSERT);
    insert.run(ROW);
    expect(() => insert.run(ROW)).toThrow();
    expect(() => insert.run({ ...ROW, hourBucket: 7_200_000 })).not.toThrow();
    expect(() => insert.run({ ...ROW, kind: 'relay' })).not.toThrow();
    db.close();
  });

  it('down drops the table', () => {
    const db = new Database(':memory:');
    migration.up(db);
    migration.down(db);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'cross_source_links'`).get()).toBeUndefined();
    db.close();
  });
});
