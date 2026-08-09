/**
 * Regression tests for `replaceAnchors` (#4614, follow-ups from #4613's review).
 *
 * Two properties, both of which were unproven when the method shipped:
 *
 *  1. **Atomicity.** The delete and the inserts must be one transaction. Without
 *     it, a reader landing between them sees zero anchors for a node whose
 *     estimate still exists, and the API reports "no rationale" for a pin that
 *     has one. A concurrency race is flaky to test directly, so the test below
 *     forces the INSERT half to fail and asserts the DELETE half rolled back —
 *     which only holds if the two share a transaction.
 *
 *  2. **The empty-`nodeNums` contract.** Passing no nodeNums with a non-empty
 *     anchors array means "replace exactly the nodes these anchors belong to",
 *     NOT "clear everything". Today's single caller never does it; the test is
 *     here to protect the next one.
 *
 * SQLite only. The transaction is a per-backend branch mirroring
 * `meshcorePathfindingTargets.setTargets`, and the migration suite already
 * covers the table on all three backends.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EstimatedPositionsRepository } from './estimatedPositions.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

describe('replaceAnchors (#4614)', () => {
  let testDb: TestDb;
  let repo: EstimatedPositionsRepository;

  const anchor = (nodeNum: number, anchorNodeNum: number, weight: number) => ({
    nodeNum,
    anchorNodeNum,
    anchorNodeId: `!${anchorNodeNum.toString(16).padStart(8, '0')}`,
    anchorLat: 37.4 + anchorNodeNum / 1000,
    anchorLon: -122.1,
    kind: 'traceroute' as const,
    snrDb: 5.5,
    observedAt: 1_700_000_000_000,
    weight,
    createdAt: 1_700_000_100_000,
  });

  beforeEach(() => {
    testDb = createTestDb();
    repo = new EstimatedPositionsRepository(testDb.db, 'sqlite');
  });

  afterEach(() => {
    testDb.close?.();
  });

  it('replaces only the targeted nodes, leaving others untouched', async () => {
    await repo.replaceAnchors([1, 2], [anchor(1, 10, 0.9), anchor(2, 20, 0.8)]);
    await repo.replaceAnchors([1], [anchor(1, 11, 0.7)]);

    const forOne = await repo.getAnchorsByNodeNum(1);
    const forTwo = await repo.getAnchorsByNodeNum(2);

    expect(forOne.map((a) => a.anchorNodeNum)).toEqual([11]);
    // Node 2 was not in the second call's target set.
    expect(forTwo.map((a) => a.anchorNodeNum)).toEqual([20]);
  });

  it('clears a node that solved with no retained anchors', async () => {
    await repo.replaceAnchors([1], [anchor(1, 10, 0.9)]);
    // nodeNums without anchors is the "solved, nothing worth keeping" case.
    await repo.replaceAnchors([1], []);
    expect(await repo.getAnchorsByNodeNum(1)).toEqual([]);
  });

  it('derives targets from anchors when nodeNums is empty, and clears nothing else', async () => {
    // The contract #4614 asked to pin: empty nodeNums does NOT mean "wipe all".
    await repo.replaceAnchors([1, 2], [anchor(1, 10, 0.9), anchor(2, 20, 0.8)]);
    await repo.replaceAnchors([], [anchor(1, 12, 0.6)]);

    expect((await repo.getAnchorsByNodeNum(1)).map((a) => a.anchorNodeNum)).toEqual([12]);
    expect((await repo.getAnchorsByNodeNum(2)).map((a) => a.anchorNodeNum)).toEqual([20]);
  });

  it('is a no-op when both arguments are empty', async () => {
    await repo.replaceAnchors([1], [anchor(1, 10, 0.9)]);
    await repo.replaceAnchors([], []);
    expect((await repo.getAnchorsByNodeNum(1)).map((a) => a.anchorNodeNum)).toEqual([10]);
  });

  it('rolls the delete back when the insert fails — proving the two are atomic', async () => {
    await repo.replaceAnchors([1], [anchor(1, 10, 0.9), anchor(1, 11, 0.8)]);
    expect(await repo.getAnchorsByNodeNum(1)).toHaveLength(2);

    // `kind` is NOT NULL. Passing null makes the INSERT half throw *after* the
    // DELETE half has run. Pre-transaction, this wiped the node's anchors and
    // left it with none; with the transaction the delete is rolled back.
    const bad = { ...anchor(1, 12, 0.7), kind: null as unknown as 'traceroute' };
    await expect(repo.replaceAnchors([1], [bad])).rejects.toThrow();

    const surviving = await repo.getAnchorsByNodeNum(1);
    expect(surviving.map((a) => a.anchorNodeNum).sort()).toEqual([10, 11]);
  });
});
