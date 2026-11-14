/**
 * Migration 233 tests — direct_rf_contacts table creation (#6210).
 * PostgreSQL / MySQL run in `233_create_direct_rf_contacts.pgmysql.test.ts`
 * and through the repository suite `directRfContacts.multiBackend.test.ts`.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migration } from './233_create_direct_rf_contacts.js';

const ROW = {
  sourceId: 'src-a', protocol: 'meshtastic', nodeKey: '!aaaaaaaa', nodeNum: 0xaaaaaaaa,
  dayBucket: 86_400_000, firstHeardAt: 86_400_500, lastHeardAt: 86_400_900,
};
const INSERT = `
  INSERT INTO direct_rf_contacts (sourceId, protocol, nodeKey, nodeNum, dayBucket, firstHeardAt, lastHeardAt)
  VALUES (@sourceId, @protocol, @nodeKey, @nodeNum, @dayBucket, @firstHeardAt, @lastHeardAt)
`;

describe('Migration 233 — direct_rf_contacts (SQLite)', () => {
  it('creates the table and indexes, and is idempotent', () => {
    const db = new Database(':memory:');
    migration.up(db);
    expect(() => migration.up(db)).not.toThrow();
    const names = (db.prepare(`SELECT name FROM sqlite_master WHERE tbl_name = 'direct_rf_contacts'`).all() as Array<{ name: string }>)
      .map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining([
      'direct_rf_contacts',
      'direct_rf_contacts_day_uniq',
      'direct_rf_contacts_source_day_idx',
      'direct_rf_contacts_day_idx',
    ]));
    db.close();
  });

  it('defaults the counters and sums to 0 and leaves best SNR/RSSI null', () => {
    const db = new Database(':memory:');
    migration.up(db);
    db.prepare(INSERT).run(ROW);
    const row = db.prepare(`SELECT * FROM direct_rf_contacts`).get() as Record<string, unknown>;
    expect(row).toMatchObject({
      receptionCount: 0, snrSum: 0, snrCount: 0, rssiSum: 0, rssiCount: 0, bestSnr: null, bestRssi: null,
    });
    db.close();
  });

  it('one row per (source, node, day): a duplicate is rejected, another day/source/node is not', () => {
    const db = new Database(':memory:');
    migration.up(db);
    const insert = db.prepare(INSERT);
    insert.run(ROW);
    expect(() => insert.run(ROW)).toThrow();
    expect(() => insert.run({ ...ROW, dayBucket: 2 * 86_400_000 })).not.toThrow();
    expect(() => insert.run({ ...ROW, sourceId: 'src-b' })).not.toThrow();
    expect(() => insert.run({ ...ROW, nodeKey: '!bbbbbbbb' })).not.toThrow();
    db.close();
  });

  it('down drops the table', () => {
    const db = new Database(':memory:');
    migration.up(db);
    migration.down(db);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'direct_rf_contacts'`).get()).toBeUndefined();
    db.close();
  });
});
