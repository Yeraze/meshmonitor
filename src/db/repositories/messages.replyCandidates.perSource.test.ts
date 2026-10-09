/**
 * MessagesRepository.getReplyCandidates — the candidate query behind the
 * Auto-Acknowledge response cap.
 *
 * Two things are pinned here:
 *  - isolation: only rows on the asked source and channel come back;
 *  - no drift: over a table of cases, "the query returned it AND the shared
 *    predicate accepts it" equals what the message views would show under the
 *    parent (utils/messageReplies — the views call the same functions).
 *
 * SQLite only, by choice: the query is three Drizzle `eq`s with no dialect
 * branch, and the PostgreSQL/MySQL BIGINT columns (`fromNodeNum`, `replyId`)
 * are passed through `Number()` in the method's row mapper.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { MessagesRepository } from './messages.js';
import * as schema from '../schema/index.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';
import { PortNum } from '../../server/constants/meshtastic.js';
import { countDistinctResponders, isResponseTo } from '../../utils/messageReplies.js';

describe('MessagesRepository.getReplyCandidates', () => {
  let db: Database.Database;
  let drizzleDb: BetterSQLite3Database<typeof schema>;
  let repo: MessagesRepository;

  const AUTHOR = 0x100;
  const NODES = [AUTHOR, 0x201, 0x202, 0x203, 0x204, 0x205, 0x206];
  const TRIGGER_PACKET = 5555;
  const CHANNEL = 2;

  beforeEach(() => {
    const t = createTestDb();
    db = t.sqlite;
    drizzleDb = t.db;
    const now = Date.now();
    for (const src of ['src-a', 'src-b']) {
      for (const n of NODES) {
        db.prepare(
          'INSERT INTO nodes (nodeNum, nodeId, sourceId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)',
        ).run(n, `!${n.toString(16).padStart(8, '0')}`, src, now, now);
      }
    }
    repo = new MessagesRepository(drizzleDb, 'sqlite');
  });

  afterEach(() => db.close());

  let seq = 1;
  const insert = (sourceId: string, from: number, over: Record<string, unknown> = {}) => {
    const packet = 9000 + seq++;
    return repo.insertMessage(
      {
        id: `${sourceId}_${from}_${packet}`,
        fromNodeNum: from,
        toNodeNum: 0xffffffff,
        fromNodeId: `!${from.toString(16).padStart(8, '0')}`,
        toNodeId: '!ffffffff',
        text: 'hi',
        channel: CHANNEL,
        portnum: PortNum.TEXT_MESSAGE_APP,
        timestamp: Date.now(),
        createdAt: Date.now(),
        ...over,
      } as any,
      sourceId,
    );
  };

  it('returns only rows on the asked source and channel that point at the packet', async () => {
    await insert('src-a', 0x201, { text: '👍', emoji: 1, replyId: TRIGGER_PACKET });           // tapback
    await insert('src-a', 0x202, { text: 'Copy', replyId: TRIGGER_PACKET });                    // reply
    await insert('src-a', 0x203, { text: 'hello' });                                            // plain
    await insert('src-a', 0x204, { text: '👍', emoji: 1, replyId: TRIGGER_PACKET + 1 });       // other parent
    await insert('src-a', 0x205, { text: 'Copy', replyId: TRIGGER_PACKET, channel: CHANNEL + 1 }); // other channel
    await insert('src-b', 0x206, { text: 'Copy', replyId: TRIGGER_PACKET });                    // other source

    const rows = await repo.getReplyCandidates('src-a', TRIGGER_PACKET, CHANNEL);
    expect(rows.map((r) => r.fromNodeNum).sort()).toEqual([0x201, 0x202]);
    expect(rows.every((r) => r.replyId === TRIGGER_PACKET)).toBe(true);

    const onB = await repo.getReplyCandidates('src-b', TRIGGER_PACKET, CHANNEL);
    expect(onB.map((r) => r.fromNodeNum)).toEqual([0x206]);
  });

  it('refuses an empty source id rather than reading every source', async () => {
    await expect(repo.getReplyCandidates('', TRIGGER_PACKET, CHANNEL)).rejects.toThrow(/sourceId is required/);
  });

  it('query + shared predicate agree with the rule the views render with', async () => {
    const parent = { id: `src-a_${AUTHOR}_${TRIGGER_PACKET}` };
    const cases: Array<{ from: number; over: Record<string, unknown> }> = [
      { from: 0x201, over: { text: '👍', emoji: 1, replyId: TRIGGER_PACKET } },
      { from: 0x201, over: { text: 'Copy, 1 hops', replyId: TRIGGER_PACKET } },  // same node again
      { from: 0x202, over: { text: '🎉', replyId: TRIGGER_PACKET } },             // unflagged emoji
      { from: 0x203, over: { text: 'unrelated' } },
      { from: 0x204, over: { text: '👍' } },                                       // emoji, answers nothing
      { from: 0x205, over: { text: 'late', replyId: TRIGGER_PACKET + 7 } },
      { from: AUTHOR, over: { text: 'anyone?', replyId: TRIGGER_PACKET } },        // author follow-up
    ];
    for (const c of cases) await insert('src-a', c.from, c.over);

    // What the views would hang under the parent: every row of the conversation
    // run through the shared predicate.
    const expected = cases.filter((c) => isResponseTo(c.over as any, parent)).map((c) => c.from).sort();

    const rows = await repo.getReplyCandidates('src-a', TRIGGER_PACKET, CHANNEL);
    const viaQuery = rows.filter((r) => isResponseTo(r, parent)).map((r) => r.fromNodeNum).sort();
    expect(viaQuery).toEqual(expected);
    // The query selects no row the predicate then throws away, and misses none.
    expect(rows).toHaveLength(expected.length);

    // Distinct other nodes: 0x201 (twice) and 0x202; the author is left out.
    expect(countDistinctResponders(parent, rows, [AUTHOR])).toBe(2);
  });

  it('honours the limit', async () => {
    for (const n of [0x201, 0x202, 0x203]) await insert('src-a', n, { text: 'x', replyId: TRIGGER_PACKET });
    expect(await repo.getReplyCandidates('src-a', TRIGGER_PACKET, CHANNEL, 2)).toHaveLength(2);
  });
});
