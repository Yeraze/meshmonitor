/**
 * MeshCoreFiltersRepository — per-source isolation and CRUD on SQLite (#5408).
 * The PG/MySQL twin is `meshcoreFilters.multiBackend.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MeshCoreFiltersRepository } from './meshcoreFilters.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const KEY = 'ab'.repeat(32);

function seedSources(t: TestDb): void {
  const insert = t.sqlite.prepare(
    `INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt) VALUES (?, ?, 'meshcore', '{}', 1, 0, 0)`,
  );
  insert.run('src-a', 'A');
  insert.run('src-b', 'B');
}

const RULE = {
  mode: 'ignore' as const,
  matchType: 'wildcard' as const,
  pattern: '*spam*',
  caseSensitive: false,
  fields: 'body' as const,
  enabled: true,
};

describe('MeshCoreFiltersRepository — per-source isolation', () => {
  let t: TestDb;
  let repo: MeshCoreFiltersRepository;

  beforeEach(() => {
    t = createTestDb();
    seedSources(t);
    repo = new MeshCoreFiltersRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    t.close();
  });

  it('ignored nodes are scoped per source', async () => {
    await repo.upsertIgnoredNode({ sourceId: 'src-a', publicKey: KEY, name: 'Spammer', mode: 'block', createdBy: 1 });
    expect(await repo.listIgnoredNodes('src-a')).toEqual([
      expect.objectContaining({ sourceId: 'src-a', publicKey: KEY, name: 'Spammer', mode: 'block', createdBy: 1, hitCount: 0, lastHitAt: null }),
    ]);
    expect(await repo.listIgnoredNodes('src-b')).toEqual([]);
    expect(await repo.removeIgnoredNode('src-b', KEY)).toBe(0);
    expect(await repo.listIgnoredNodes('src-a')).toHaveLength(1);
  });

  it('upsert changes mode/name but keeps createdAt and hits', async () => {
    const first = await repo.upsertIgnoredNode({ sourceId: 'src-a', publicKey: KEY, name: 'A', mode: 'ignore', createdBy: null });
    await repo.addIgnoredNodeHits('src-a', KEY, 3, 5000);
    const second = await repo.upsertIgnoredNode({ sourceId: 'src-a', publicKey: KEY, name: 'B', mode: 'block', createdBy: null });
    expect(second).toMatchObject({ name: 'B', mode: 'block', createdAt: first.createdAt, hitCount: 3, lastHitAt: 5000 });
  });

  it('hit increments and name refresh touch only their own source', async () => {
    await repo.upsertIgnoredNode({ sourceId: 'src-a', publicKey: KEY, name: 'A', mode: 'ignore', createdBy: null });
    await repo.upsertIgnoredNode({ sourceId: 'src-b', publicKey: KEY, name: 'A', mode: 'ignore', createdBy: null });
    await repo.addIgnoredNodeHits('src-a', KEY, 2, 100);
    await repo.addIgnoredNodeHits('src-a', KEY, 1, 200);
    await repo.updateIgnoredNodeName('src-a', KEY, 'Renamed');
    expect(await repo.getIgnoredNode('src-a', KEY)).toMatchObject({ hitCount: 3, lastHitAt: 200, name: 'Renamed' });
    expect(await repo.getIgnoredNode('src-b', KEY)).toMatchObject({ hitCount: 0, lastHitAt: null, name: 'A' });
  });

  it('message filters: create, update, delete are scoped per source', async () => {
    const rule = await repo.createMessageFilter('src-a', RULE, 7);
    expect(rule).toMatchObject({ ...RULE, sourceId: 'src-a', createdBy: 7, hitCount: 0 });
    expect(await repo.listMessageFilters('src-b')).toEqual([]);
    expect(await repo.getMessageFilter('src-b', rule.id)).toBeNull();
    expect(await repo.updateMessageFilter('src-b', rule.id, { enabled: false })).toBeNull();
    expect(await repo.deleteMessageFilter('src-b', rule.id)).toBe(0);

    const updated = await repo.updateMessageFilter('src-a', rule.id, { enabled: false, caseSensitive: true, mode: 'block' });
    expect(updated).toMatchObject({ enabled: false, caseSensitive: true, mode: 'block', pattern: '*spam*' });

    await repo.addMessageFilterHits('src-a', rule.id, 4, 900);
    expect(await repo.getMessageFilter('src-a', rule.id)).toMatchObject({ hitCount: 4, lastHitAt: 900 });

    expect(await repo.deleteMessageFilter('src-a', rule.id)).toBe(1);
    expect(await repo.listMessageFilters('src-a')).toEqual([]);
  });

  it('a missing sourceId fails closed', async () => {
    await expect(repo.listIgnoredNodes('')).rejects.toThrow(/sourceId is required/);
    await expect(repo.listMessageFilters('')).rejects.toThrow(/sourceId is required/);
  });
});
