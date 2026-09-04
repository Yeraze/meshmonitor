/**
 * Per-source isolation for `NodesRepository.getIdentityRows` — the query
 * behind Meshtastic 2.8 identity-change detection (issue #5032).
 *
 * This one matters more than most: the detector pairs nodes purely on name and
 * key similarity, so a query that leaked rows from a second source would happily
 * report "node X on mesh A is really node Y on mesh B" and invite an operator
 * to merge two unrelated histories. The method therefore uses a hard
 * `eq(sourceId)` rather than `withSourceScope` — there is no "all sources"
 * mode to fall into.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NodesRepository } from './nodes.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';

describe('NodesRepository.getIdentityRows — per-source isolation', () => {
  let t: TestDb;
  let repo: NodesRepository;

  beforeEach(async () => {
    t = createTestDb();
    for (const id of [SRC_A, SRC_B]) {
      t.sqlite
        .prepare(
          `INSERT OR IGNORE INTO sources (id, name, type, config, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 0, 0)`,
        )
        .run(id, id);
    }
    repo = new NodesRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    t.close();
  });

  it('returns only the requested source\'s rows, even for the same nodeNum', async () => {
    await repo.upsertNode(
      { nodeNum: 111, nodeId: '!0000006f', longName: 'On A', shortName: 'AAAA', publicKey: 'key-a', lastHeard: 1000 },
      SRC_A,
    );
    await repo.upsertNode(
      { nodeNum: 111, nodeId: '!0000006f', longName: 'On B', shortName: 'BBBB', publicKey: 'key-b', lastHeard: 2000 },
      SRC_B,
    );
    await repo.upsertNode(
      { nodeNum: 222, nodeId: '!000000de', longName: 'Only B', shortName: 'ONLY', lastHeard: 3000 },
      SRC_B,
    );

    const onA = await repo.getIdentityRows(SRC_A);
    const onB = await repo.getIdentityRows(SRC_B);

    expect(onA).toHaveLength(1);
    expect(onA[0].nodeNum).toBe(111);
    expect(onA[0].longName).toBe('On A');
    expect(onA[0].publicKey).toBe('key-a');

    expect(onB.map(r => r.nodeNum).sort()).toEqual([111, 222]);
    expect(onB.find(r => r.nodeNum === 111)?.longName).toBe('On B');
  });

  it('does not surface a name/key twin that lives on another source', async () => {
    // The pair that WOULD look like a 2.8 handover if the query leaked: same
    // name, same key, one quiet and one live — but split across two meshes.
    const shared = { longName: 'Base Station', shortName: 'BASE', publicKey: 'shared-key' };
    await repo.upsertNode({ nodeNum: 111, nodeId: '!0000006f', ...shared, lastHeard: 1000 }, SRC_A);
    await repo.upsertNode({ nodeNum: 999, nodeId: '!000003e7', ...shared, lastHeard: 9000 }, SRC_B);

    const onA = await repo.getIdentityRows(SRC_A);
    expect(onA).toHaveLength(1);
    expect(onA.some(r => r.nodeNum === 999)).toBe(false);
  });

  it('returns an empty list for a source with no nodes', async () => {
    await repo.upsertNode({ nodeNum: 111, nodeId: '!0000006f', lastHeard: 1000 }, SRC_A);
    expect(await repo.getIdentityRows(SRC_B)).toEqual([]);
  });

  it('projects the identity columns the detector needs', async () => {
    await repo.upsertNode(
      {
        nodeNum: 111,
        nodeId: '!0000006f',
        longName: 'Base Station',
        shortName: 'BASE',
        publicKey: 'a-key',
        hwModel: 43,
        role: 2,
        firmwareVersion: '2.8.0.47db0e3',
        lastHeard: 1234,
      },
      SRC_A,
    );

    const [r] = await repo.getIdentityRows(SRC_A);
    expect(r).toMatchObject({
      nodeNum: 111,
      nodeId: '!0000006f',
      longName: 'Base Station',
      shortName: 'BASE',
      publicKey: 'a-key',
      hwModel: 43,
      firmwareVersion: '2.8.0.47db0e3',
      lastHeard: 1234,
    });
    // createdAt is stamped by the repository in milliseconds (Date.now()).
    expect(r.createdAt).toBeGreaterThan(1e11);
  });
});
