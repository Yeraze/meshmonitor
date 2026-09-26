/**
 * Aircraft age-out sweep and lift — per-source isolation (#5364/#5365
 * Phase 2). Wires the service to REAL repositories on an in-memory SQLite DB
 * built from the migration registry, with the same nodeNum on two sources.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { NodesRepository } from '../../db/repositories/nodes.js';
import { IgnoredNodesRepository } from '../../db/repositories/ignoredNodes.js';
import { SettingsRepository } from '../../db/repositories/settings.js';
import { createTestDb, type TestDb } from '../test-helpers/testDb.js';
import { AircraftAgeOutService } from './aircraftAgeOutService.js';

const A = 'src-a';
const B = 'src-b';
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;

describe('AircraftAgeOutService — per-source isolation', () => {
  let t: TestDb;

  afterEach(() => t?.close());

  async function setup() {
    t = createTestDb();
    // ignored_nodes.sourceId has an FK to sources.
    for (const id of [A, B]) {
      t.sqlite
        .prepare(`INSERT INTO sources (id, name, type, config, enabled, createdAt, updatedAt) VALUES (?, ?, 'meshtastic_tcp', '{}', 1, 1, 1)`)
        .run(id, id);
    }
    const nodes = new NodesRepository(t.db as any, 'sqlite');
    const ignored = new IgnoredNodesRepository(t.db as any, 'sqlite');
    const settings = new SettingsRepository(t.db as any, 'sqlite');
    const svc = new AircraftAgeOutService({
      getSourceSetting: (s, k) => settings.getSettingForSource(s, k),
      setSourceSetting: (s, k, v) => settings.setSourceSetting(s, k, v),
      getSourceType: async () => 'meshtastic_tcp',
      getLocalNodeNum: async () => null,
      listCandidates: (s) => nodes.listAircraftAgeOutCandidates(s),
      getPositionFixes: async () => [],
      setFixed: (n, s, f) => nodes.setAircraftFixed(n, s, f),
      addAircraftIgnore: (n, s, id, ln, sn) => ignored.addAircraftIgnoreAsync(n, s, id, ln, sn),
      markAgedOut: (n, s, at) => nodes.markAircraftAgedOut(n, s, at),
      deleteNode: async () => undefined,
      getAgedOutAt: (n, s) => nodes.getAircraftAgedOutAt(n, s),
      isIgnoredCached: (n, s) => ignored.isIgnoredCached(n, s),
      liftAircraftIgnore: (n, s) => ignored.liftAircraftIgnoreAsync(n, s),
      clearAgedOut: (n, s) => nodes.clearAircraftAgedOut(n, s),
      scheduleClassification: () => undefined,
    });
    const oldHeard = Math.floor((NOW - 48 * HOUR) / 1000);
    for (const src of [A, B]) {
      await nodes.upsertNode({ nodeNum: 100, nodeId: '!00000064', longName: 'Plane', shortName: 'PL', altitude: 9000, lastHeard: oldHeard }, src);
      await nodes.setAircraftClassification(100, src, {
        likelyAircraft: true, aircraftBasis: 'msl', groundElevation: null, heightAboveGround: null, aircraftClassifiedAt: NOW,
      });
    }
    return { nodes, ignored, settings, svc };
  }

  it('ages out only on the source with age-out enabled, and records the run only there', async () => {
    const { nodes, ignored, settings, svc } = await setup();
    await settings.setSourceSetting(A, 'aircraftAgeOutEnabled', 'true');

    await svc.runSweep(A, NOW);
    await svc.runSweep(B, NOW);

    const a = await nodes.getNode(100, A);
    const b = await nodes.getNode(100, B);
    expect(a?.isIgnored).toBe(true);
    expect(Number(a?.aircraftAgedOutAt)).toBe(NOW);
    expect(b?.isIgnored).toBe(false);
    expect(b?.aircraftAgedOutAt ?? null).toBeNull();
    expect(await ignored.isNodeIgnoredAsync(100, A)).toBe(true);
    expect(await ignored.isNodeIgnoredAsync(100, B)).toBe(false);
    const rows = await ignored.getIgnoredNodesAsync(A);
    expect(rows[0].reason).toBe('aircraft');

    expect(await settings.getSettingForSource(A, 'aircraftAgeOutLastRunAt')).toBe(String(NOW));
    // B ran too (detection on) but aged nothing out.
    expect(JSON.parse((await settings.getSettingForSource(B, 'aircraftAgeOutLastResult'))!).agedOut).toBe(0);
  });

  it('a live position lifts the aircraft ignore on its own source only', async () => {
    const { nodes, ignored, settings, svc } = await setup();
    await settings.setSourceSetting(A, 'aircraftAgeOutEnabled', 'true');
    await settings.setSourceSetting(B, 'aircraftAgeOutEnabled', 'true');
    await svc.runSweep(A, NOW);
    await svc.runSweep(B, NOW);

    await svc.onLivePosition(A, 100);

    expect((await nodes.getNode(100, A))?.isIgnored).toBe(false);
    expect((await nodes.getNode(100, A))?.aircraftAgedOutAt ?? null).toBeNull();
    expect(await ignored.isNodeIgnoredAsync(100, A)).toBe(false);
    expect((await nodes.getNode(100, B))?.isIgnored).toBe(true);
    expect(await ignored.isNodeIgnoredAsync(100, B)).toBe(true);
  });

  it('a manual ignore is never lifted by a live position', async () => {
    const { nodes, ignored, svc } = await setup();
    await ignored.addIgnoredNodeAsync(100, A, '!00000064', 'Plane', 'PL', 'admin');
    await nodes.markAircraftAgedOut(100, A, NOW); // stale mark over a manual row
    await svc.onLivePosition(A, 100);
    expect(await ignored.isNodeIgnoredAsync(100, A)).toBe(true);
    expect((await nodes.getNode(100, A))?.isIgnored).toBe(true);
  });
});
