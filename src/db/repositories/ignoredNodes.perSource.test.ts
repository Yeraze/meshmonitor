/**
 * Per-source isolation tests for IgnoredNodesRepository's geo-ignore surface
 * (MQTT Geo-Ignore epic, Phase 1 / WP1).
 *
 * The table is per-source (migration 048), keyed on composite
 * (nodeNum, sourceId). Asserts that `addGeoIgnoreAsync` / `liftGeoIgnoreAsync`
 * — and the in-memory cache mirror they maintain — never leak across sources
 * for the same physical nodeNum.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { IgnoredNodesRepository } from './ignoredNodes.js';
import { createTestDb, type TestDb } from '../../server/test-helpers/testDb.js';

const SRC_A = 'source-a';
const SRC_B = 'source-b';
const NODE_NUM = 12345;

describe('IgnoredNodesRepository — geo-ignore per-source isolation', () => {
  let t: TestDb;
  let repo: IgnoredNodesRepository;

  beforeEach(() => {
    t = createTestDb();
    // Seed the sources referenced by SRC_A / SRC_B so the FK from
    // ignored_nodes.sourceId → sources.id (migration 048) is satisfied.
    t.sqlite.prepare(
      `INSERT OR IGNORE INTO sources (id, name, type, config, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 0, 0)`,
    ).run(SRC_A, SRC_A);
    t.sqlite.prepare(
      `INSERT OR IGNORE INTO sources (id, name, type, config, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 0, 0)`,
    ).run(SRC_B, SRC_B);
    repo = new IgnoredNodesRepository(t.db, 'sqlite');
  });

  afterEach(() => {
    t.close();
  });

  it('addGeoIgnoreAsync on source A does not create/affect a row on source B for the same nodeNum', async () => {
    await repo.addGeoIgnoreAsync(NODE_NUM, SRC_A, '!abcd1234', 'On A', 'A');

    expect(await repo.isNodeIgnoredAsync(NODE_NUM, SRC_A)).toBe(true);
    expect(await repo.isNodeIgnoredAsync(NODE_NUM, SRC_B)).toBe(false);

    const all = await repo.getIgnoredNodesAsync();
    expect(all).toHaveLength(1);
    expect(all[0].sourceId).toBe(SRC_A);
    expect(all[0].reason).toBe('geo');
  });

  it('liftGeoIgnoreAsync on source A leaves source B\'s geo-ignore row for the same nodeNum intact', async () => {
    await repo.addGeoIgnoreAsync(NODE_NUM, SRC_A, '!abcd1234', 'On A', 'A');
    await repo.addGeoIgnoreAsync(NODE_NUM, SRC_B, '!abcd1234', 'On B', 'B');

    const lifted = await repo.liftGeoIgnoreAsync(NODE_NUM, SRC_A);
    expect(lifted).toBe(true);

    expect(await repo.isNodeIgnoredAsync(NODE_NUM, SRC_A)).toBe(false);
    expect(await repo.isNodeIgnoredAsync(NODE_NUM, SRC_B)).toBe(true);

    const remaining = await repo.getIgnoredNodesAsync();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].sourceId).toBe(SRC_B);
    expect(remaining[0].reason).toBe('geo');
  });

  it('a manual ignore on source B does not block a geo-ignore of the same nodeNum on source A', async () => {
    await repo.addIgnoredNodeAsync(NODE_NUM, SRC_B, '!abcd1234', 'Manual on B', 'MB', 'admin');
    await repo.addGeoIgnoreAsync(NODE_NUM, SRC_A, '!abcd1234', 'Geo on A', 'GA');

    const onA = await repo.getIgnoredNodesAsync(SRC_A);
    const onB = await repo.getIgnoredNodesAsync(SRC_B);
    expect(onA[0].reason).toBe('geo');
    expect(onB[0].reason).toBe('manual');

    // Lifting the geo-ignore on A must not touch B's manual entry.
    expect(await repo.liftGeoIgnoreAsync(NODE_NUM, SRC_A)).toBe(true);
    expect(await repo.isNodeIgnoredAsync(NODE_NUM, SRC_A)).toBe(false);
    expect(await repo.isNodeIgnoredAsync(NODE_NUM, SRC_B)).toBe(true);
  });

  it('in-memory cache mirror is isolated per source', async () => {
    await repo.addGeoIgnoreAsync(NODE_NUM, SRC_A, '!abcd1234', 'On A', 'A');

    expect(repo.isIgnoredCached(NODE_NUM, SRC_A)).toBe(true);
    expect(repo.isIgnoredCached(NODE_NUM, SRC_B)).toBe(false);

    await repo.addGeoIgnoreAsync(NODE_NUM, SRC_B, '!abcd1234', 'On B', 'B');
    expect(repo.isIgnoredCached(NODE_NUM, SRC_B)).toBe(true);

    await repo.liftGeoIgnoreAsync(NODE_NUM, SRC_A);
    expect(repo.isIgnoredCached(NODE_NUM, SRC_A)).toBe(false);
    // B's cache entry survives A's lift.
    expect(repo.isIgnoredCached(NODE_NUM, SRC_B)).toBe(true);
  });
});
