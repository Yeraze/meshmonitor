/**
 * TimeSyncRepository Tests (SQLite)
 *
 * Basic coverage for addAutoTimeSyncNode, getAutoTimeSyncNodes,
 * setAutoTimeSyncNodes, removeAutoTimeSyncNode.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimeSyncRepository } from './timeSync.js';
import { createTestDb } from '../../server/test-helpers/testDb.js';

describe('TimeSyncRepository - SQLite', () => {
  let repo: TimeSyncRepository;
  let close: () => void;

  beforeEach(() => {
    const t = createTestDb();
    repo = new TimeSyncRepository(t.db, 'sqlite');
    close = t.close;
  });

  afterEach(() => {
    close();
  });

  it('getAutoTimeSyncNodes - empty initially', async () => {
    const nodes = await repo.getAutoTimeSyncNodes();
    expect(nodes).toHaveLength(0);
  });

  it('addAutoTimeSyncNode - adds a node', async () => {
    await repo.addAutoTimeSyncNode(1001);
    const nodes = await repo.getAutoTimeSyncNodes();
    expect(nodes).toContain(1001);
  });

  it('addAutoTimeSyncNode - idempotent within the same source', async () => {
    // Test idempotency with a sourceId (the UNIQUE constraint covers (nodeNum, sourceId))
    await repo.addAutoTimeSyncNode(1001, 'A');
    await repo.addAutoTimeSyncNode(1001, 'A');
    const nodes = await repo.getAutoTimeSyncNodes('A');
    expect(nodes.filter(n => n === 1001)).toHaveLength(1);
  });

  it('setAutoTimeSyncNodes - replaces all entries', async () => {
    await repo.setAutoTimeSyncNodes([100, 200, 300]);
    let nodes = await repo.getAutoTimeSyncNodes();
    expect(nodes.sort()).toEqual([100, 200, 300]);

    await repo.setAutoTimeSyncNodes([400]);
    nodes = await repo.getAutoTimeSyncNodes();
    expect(nodes).toEqual([400]);
  });

  it('setAutoTimeSyncNodes - empty array clears all', async () => {
    await repo.setAutoTimeSyncNodes([100, 200]);
    await repo.setAutoTimeSyncNodes([]);
    const nodes = await repo.getAutoTimeSyncNodes();
    expect(nodes).toHaveLength(0);
  });

  it('removeAutoTimeSyncNode - removes specific node', async () => {
    await repo.setAutoTimeSyncNodes([100, 200, 300]);
    await repo.removeAutoTimeSyncNode(200);
    const nodes = await repo.getAutoTimeSyncNodes();
    expect(nodes).not.toContain(200);
    expect(nodes).toHaveLength(2);
  });

  it('getAutoTimeSyncNodes - scoped by sourceId', async () => {
    await repo.addAutoTimeSyncNode(10, 'A');
    await repo.addAutoTimeSyncNode(20, 'B');
    expect(await repo.getAutoTimeSyncNodes('A')).toEqual([10]);
    expect(await repo.getAutoTimeSyncNodes('B')).toEqual([20]);
  });
});
