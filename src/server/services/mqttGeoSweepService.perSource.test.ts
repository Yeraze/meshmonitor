/**
 * Per-source isolation tests for mqttGeoSweepService (MQTT Geo-Ignore epic,
 * Phase 3, WP1).
 *
 * Unlike `mqttGeoSweepService.test.ts` (which mocks `../../services/
 * database.js` wholesale to pin the sweep's branching logic), this file
 * exercises the REAL singleton `databaseService` against its `:memory:`
 * SQLite backend — the same rationale as `mqttIngestion.perSource.test.ts`:
 * per-source isolation is exactly the kind of thing a database mock can't
 * prove. Every assertion here demonstrates that a sweep run against source A
 * never reads, ignores, purges, or lifts anything belonging to source B.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mqttGeoSweepService } from './mqttGeoSweepService.js';
import databaseService from '../../services/database.js';

// Matches the ON_BBOX convention used across the geo-ignore test suite.
const ON_BBOX = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };

function seedNode(nodeNum: number, sourceId: string, overrides: Record<string, unknown> = {}) {
  const nodeId = `!${nodeNum.toString(16).padStart(8, '0')}`;
  return databaseService.upsertNodeAsync({
    nodeNum,
    nodeId,
    longName: `Node ${nodeNum}`,
    shortName: `N${nodeNum}`,
    hwModel: 1,
    lastHeard: Math.floor(Date.now() / 1000),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as any, sourceId);
}

describe('mqttGeoSweepService — per-source isolation', () => {
  // Each test gets its own fresh source pair (rather than one shared pair
  // reused across the whole file) so a prior test's geo-ignore rows can
  // never leak into a later test's lift-pass count — the lift pass sweeps
  // EVERY reason='geo' row on a source, so a shared source would make
  // `stats.lifted` depend on test execution order.
  let SRC_A: string;
  let SRC_B: string;
  let testCounter = 0;

  beforeEach(async () => {
    await databaseService.waitForReady();
    const suffix = ++testCounter;
    SRC_A = `geo-sweep-ps-a-${suffix}`;
    SRC_B = `geo-sweep-ps-b-${suffix}`;
    await databaseService.sources.createSource({ id: SRC_A, name: 'Source A', type: 'meshtastic_tcp', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: SRC_B, name: 'Source B', type: 'meshtastic_tcp', config: {}, enabled: true });
  });

  afterEach(async () => {
    // FK ON DELETE CASCADE (migration 048) takes ignored_nodes/nodes rows
    // scoped to these sources with them.
    await databaseService.sources.deleteSource(SRC_A).catch(() => {});
    await databaseService.sources.deleteSource(SRC_B).catch(() => {});
  });

  it('a sweep on source A ignores + purges only A; source B keeps its node for the same nodeNum', async () => {
    const NODE = 0x20000001;

    // Both sources have the SAME nodeNum sitting outside ON_BBOX.
    await seedNode(NODE, SRC_A, { latitude: 49.2, longitude: -123 });
    await seedNode(NODE, SRC_B, { latitude: 49.2, longitude: -123 });

    expect(await databaseService.nodes.getNode(NODE, SRC_A)).not.toBeNull();
    expect(await databaseService.nodes.getNode(NODE, SRC_B)).not.toBeNull();

    const stats = await mqttGeoSweepService.runSweep(SRC_A, ON_BBOX, { lift: false });

    expect(stats).toMatchObject({ sourceId: SRC_A, scanned: 1, ignored: 1, purged: 1, lifted: 0 });

    // Source A: geo-ignored + purged.
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_A)).toBe(true);
    const ignoredOnA = await databaseService.ignoredNodes.getIgnoredNodesAsync(SRC_A);
    expect(ignoredOnA.find((r) => r.nodeNum === NODE)?.reason).toBe('geo');
    expect(await databaseService.nodes.getNode(NODE, SRC_A)).toBeNull();

    // Source B: completely untouched by the A-scoped sweep.
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_B)).toBe(false);
    const ignoredOnB = await databaseService.ignoredNodes.getIgnoredNodesAsync(SRC_B);
    expect(ignoredOnB.find((r) => r.nodeNum === NODE)).toBeUndefined();
    const nodeB = await databaseService.nodes.getNode(NODE, SRC_B);
    expect(nodeB).not.toBeNull();
    expect(nodeB?.longName).toBe(`Node ${NODE}`);
  });

  it('a lift sweep on source A lifts only A\'s geo entry; B\'s geo entry for the same nodeNum survives', async () => {
    const NODE = 0x20000002;
    const NODE_ID = `!${NODE.toString(16).padStart(8, '0')}`;

    // Manually seed geo-ignore rows on BOTH sources for the same nodeNum.
    await databaseService.ignoredNodes.addGeoIgnoreAsync(NODE, SRC_A, NODE_ID, 'Geo A', 'GA');
    await databaseService.ignoredNodes.addGeoIgnoreAsync(NODE, SRC_B, NODE_ID, 'Geo B', 'GB');
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_A)).toBe(true);
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_B)).toBe(true);

    // No node rows exist for this nodeNum, so the add pass is a no-op; only
    // the lift pass is exercised here.
    const stats = await mqttGeoSweepService.runSweep(SRC_A, ON_BBOX, { lift: true });

    expect(stats.lifted).toBe(1);
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_A)).toBe(false);

    // Source B's geo-ignore entry for the same nodeNum must survive untouched.
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_B)).toBe(true);
    const ignoredOnB = await databaseService.ignoredNodes.getIgnoredNodesAsync(SRC_B);
    expect(ignoredOnB.find((r) => r.nodeNum === NODE)?.reason).toBe('geo');
  });

  it('an in-bbox node on source B is never scanned/ignored by a sweep run against source A', async () => {
    const NODE = 0x20000003;
    // Only seed the node on source B, inside the bbox.
    await seedNode(NODE, SRC_B, { latitude: 44, longitude: -78 });

    const stats = await mqttGeoSweepService.runSweep(SRC_A, ON_BBOX, { lift: false });

    // Source A has nothing to scan for this nodeNum.
    expect(stats.ignored).toBe(0);
    expect(stats.purged).toBe(0);

    // Source B's node is completely unaffected.
    const nodeB = await databaseService.nodes.getNode(NODE, SRC_B);
    expect(nodeB).not.toBeNull();
    expect(await databaseService.ignoredNodes.isNodeIgnoredAsync(NODE, SRC_B)).toBe(false);
  });
});
