/**
 * MessagesRepository.getMessages — excludePortnums filter.
 *
 * Regression coverage for issue #2741: traceroute responses (portnum 70) were
 * stored in the `messages` table alongside text DMs and consumed slots in the
 * capped fetch window, so a successful traceroute would evict a real DM from
 * the 100-row window the UI pulls from. The fix adds an `excludePortnums`
 * argument; UI-facing callers pass `[70]` so traceroutes do not displace DMs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import { ALL_SOURCES } from './base.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('MessagesRepository.getMessages excludePortnums', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const LOCAL_NUM = 0x12345678;
  const LOCAL_ID = '!12345678';
  const PEER_NUM = 0x87654321;
  const PEER_ID = '!87654321';

  beforeEach(() => {
    // Full production schema from the migration registry — see testDb.ts.
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;

    // Seed referenced nodes (full schema NOT NULL/PK columns: sourceId, timestamps).
    const now = Date.now();
    const insertNode = db.prepare(
      "INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, 'default', ?, ?)",
    );
    insertNode.run(LOCAL_NUM, LOCAL_ID, now, now);
    insertNode.run(PEER_NUM, PEER_ID, now, now);

    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => {
    db.close();
  });

  const insert = (id: string, portnum: number | null, rxTime: number, text = 'x') => {
    // Use rxTime as createdAt so each insert has a deterministic, distinct
    // arrival time. Ordering moved from device rxTime to createdAt in #3122.
    db.prepare(
      `INSERT INTO messages (id, fromNodeNum, toNodeNum, fromNodeId, toNodeId, text, channel, portnum, timestamp, rxTime, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, -1, ?, ?, ?, ?)`
    ).run(id, LOCAL_NUM, PEER_NUM, LOCAL_ID, PEER_ID, text, portnum, rxTime, rxTime, rxTime);
  };

  it('drops traceroute rows (portnum 70) when excluded', async () => {
    insert('text-1', 1, 1000);
    insert('trace-1', 70, 2000);
    insert('text-2', 1, 3000);

    const all = await repo.getMessages(100, 0, ALL_SOURCES);
    expect(all).toHaveLength(3);

    const filtered = await repo.getMessages(100, 0, ALL_SOURCES, [70]);
    expect(filtered.map(m => m.id).sort()).toEqual(['text-1', 'text-2']);
  });

  it('keeps rows whose portnum is NULL (legacy data predates the column)', async () => {
    insert('legacy', null, 1000);
    insert('trace', 70, 2000);

    const filtered = await repo.getMessages(100, 0, ALL_SOURCES, [70]);
    expect(filtered.map(m => m.id)).toEqual(['legacy']);
  });

  it('does not evict real DMs when a traceroute is inserted (issue #2741)', async () => {
    // Simulate a tight cap: 3 DMs in the table, then a traceroute arrives.
    insert('dm-old', 1, 1000);
    insert('dm-mid', 1, 2000);
    insert('dm-recent', 1, 3000);
    insert('trace', 70, 4000);

    // Without the filter, limit=3 returns the 3 newest — which now includes
    // the traceroute and drops dm-old. This is the bug.
    const unfiltered = await repo.getMessages(3, 0, ALL_SOURCES);
    expect(unfiltered.map(m => m.id)).toContain('trace');
    expect(unfiltered.map(m => m.id)).not.toContain('dm-old');

    // With the filter, all 3 DMs survive the same capped window.
    const filtered = await repo.getMessages(3, 0, ALL_SOURCES, [70]);
    expect(filtered.map(m => m.id).sort()).toEqual(['dm-mid', 'dm-old', 'dm-recent']);
  });

  it('is a no-op when excludePortnums is empty or omitted', async () => {
    insert('a', 1, 1000);
    insert('b', 70, 2000);

    const omitted = await repo.getMessages(100, 0, ALL_SOURCES);
    const empty = await repo.getMessages(100, 0, ALL_SOURCES, []);

    expect(omitted.map(m => m.id).sort()).toEqual(['a', 'b']);
    expect(empty.map(m => m.id).sort()).toEqual(['a', 'b']);
  });
});
