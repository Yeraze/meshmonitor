/**
 * Regression tests for issue #3186: `NodesRepository` must guard against
 * out-of-range nodeNum inputs instead of forwarding them to the database
 * (which crashes with `invalid input syntax for type bigint` on PG and
 * silently mis-stores on SQLite). Repository methods return `null` /
 * filter out invalid values without ever issuing the broken query.
 *
 * Stand-alone SQLite scaffold — keeps the test focused on the guard
 * behavior rather than the full multi-backend integration matrix already
 * covered by `nodes.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { NodesRepository } from './nodes.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('NodesRepository — out-of-range nodeNum guards (#3186)', () => {
  let repo: NodesRepository;
  let raw: Database.Database;

  beforeEach(() => {
    const t = createTestDb();
    raw = t.sqlite;
    repo = new NodesRepository(t.db as never, 'sqlite');
  });

  afterEach(() => {
    raw.close();
  });

  const insert = (nodeNum: number, sourceId = 'src-A', publicKey: string | null = null) => {
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO nodes (nodeNum, nodeId, sourceId, publicKey, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(nodeNum, `!${nodeNum.toString(16).padStart(8, '0')}`, sourceId, publicKey, now, now);
  };

  it('getNode returns null for an out-of-range float without querying', async () => {
    insert(123, 'src-A');
    const result = await repo.getNode(2.7130620829267897e+76, 'src-A');
    expect(result).toBeNull();
    // Sanity: known-good lookups still work after a bad call.
    const good = await repo.getNode(123, 'src-A');
    expect(good?.nodeNum).toBe(123);
  });

  it('getNode returns null for negative, fractional, and >uint32 values', async () => {
    expect(await repo.getNode(-1, 'src-A')).toBeNull();
    expect(await repo.getNode(1.5, 'src-A')).toBeNull();
    expect(await repo.getNode(0x100000000, 'src-A')).toBeNull(); // uint32 max + 1
  });

  it('getNode allows the broadcast address (uint32 max)', async () => {
    insert(0xFFFFFFFF, 'src-A');
    const result = await repo.getNode(0xFFFFFFFF, 'src-A');
    expect(result?.nodeNum).toBe(0xFFFFFFFF);
  });

  it('getNodesByNums filters out invalid entries and returns matches for the rest', async () => {
    insert(100, 'src-A');
    insert(200, 'src-A');
    const map = await repo.getNodesByNums([100, 2.7e+76, -5, 200]);
    expect(map.size).toBe(2);
    expect(map.get(100)?.nodeNum).toBe(100);
    expect(map.get(200)?.nodeNum).toBe(200);
  });

  it('getNodesByNums returns an empty map when every nodeNum is invalid', async () => {
    const map = await repo.getNodesByNums([2.7e+76, -1, NaN as unknown as number]);
    expect(map.size).toBe(0);
  });

  it('getNodeByPublicKey returns the matching node', async () => {
    insert(555, 'src-A', 'base64-pubkey-xxx');
    const node = await repo.getNodeByPublicKey('base64-pubkey-xxx', 'src-A');
    expect(node?.nodeNum).toBe(555);
  });

  it('getNodeByPublicKey returns null for unknown publicKey', async () => {
    expect(await repo.getNodeByPublicKey('no-such-key', 'src-A')).toBeNull();
  });

  it('getNodeByPublicKey returns null for empty input', async () => {
    expect(await repo.getNodeByPublicKey('', 'src-A')).toBeNull();
  });
});
