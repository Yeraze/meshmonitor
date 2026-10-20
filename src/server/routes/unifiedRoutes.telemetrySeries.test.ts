/**
 * The cross-source Telemetry Dashboard reads (#5896):
 *
 *   GET /api/unified/telemetry/series: every favorited series across the
 *   sources the caller may read (the union of their favorites lists), one
 *   chart per (node, type), one line per source.
 *   GET /api/unified/telemetry: the "Latest" snapshot, now one query per source.
 *
 * Both apply the per-node rules of GET /api/telemetry/:nodeId: `nodes:read`
 * on the source, channel `viewOnMap` per node there, and no position rows of a
 * private-position node without `nodes_private:read` there.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';

const NODE = 0x6e000001; // channel 0 on both sources
const PRIVATE_NODE = 0x6e000002; // channel 0, private position on source A
const CH3_NODE = 0x6e000003; // channel 3 on source A
const MC_SOURCE = 'rt-source-mc-5896';
const MC_KEY = 'b'.repeat(64);

const hex = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

interface Line { sourceId: string; sourceName: string; favorited: boolean; canEditFavorite: boolean; points: Array<{ timestamp: number; value: number }> }
interface Series { subjectKey: string; nodeName: string; type: string; favoriteType: string; category: string; observerRelative: boolean; lines: Line[] }

describe('GET /api/unified/telemetry/series and the Latest snapshot', () => {
  let harness: RouteTestHarness;
  const now = Date.now();

  const insert = async (nodeId: string, nodeNum: number, telemetryType: string, value: number, ago: number, sourceId: string) =>
    harness.db.telemetry.insertTelemetry(
      { nodeId, nodeNum, telemetryType, value, timestamp: now - ago, createdAt: now },
      sourceId,
    );

  const setFavorites = (sourceId: string, list: Array<{ nodeId: string; telemetryType: string }>) =>
    harness.db.settings.setSourceSetting(sourceId, 'telemetryFavorites', JSON.stringify(list));

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
    const { sourceA, sourceB } = harness;
    for (const src of [sourceA, sourceB]) {
      await harness.db.nodes.deleteAllNodes(src);
      await harness.db.telemetry.deleteAllTelemetry(src);
    }
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.db.sources.createSource({ id: MC_SOURCE, name: 'MeshCore', type: 'meshcore', config: {}, enabled: true });

    await harness.db.nodes.upsertNode({ nodeNum: NODE, nodeId: hex(NODE), longName: 'Weather', channel: 0 }, sourceA);
    await harness.db.nodes.upsertNode({ nodeNum: NODE, nodeId: hex(NODE), longName: 'Weather', channel: 0 }, sourceB);
    await harness.db.nodes.upsertNode(
      { nodeNum: PRIVATE_NODE, nodeId: hex(PRIVATE_NODE), longName: 'Private', channel: 0, positionOverrideIsPrivate: true },
      sourceA,
    );
    await harness.db.nodes.upsertNode({ nodeNum: CH3_NODE, nodeId: hex(CH3_NODE), longName: 'Ch3', channel: 3 }, sourceA);
    await harness.db.meshcore.upsertNode({ publicKey: MC_KEY, name: 'Repeater' }, MC_SOURCE);

    for (const [ago, value] of [[3_600_000, 20], [1_800_000, 21], [60_000, 22]] as const) {
      await insert(hex(NODE), NODE, 'temperature', value, ago, sourceA);
      await insert(hex(NODE), NODE, 'temperature', value + 0.5, ago, sourceB);
      await insert(hex(NODE), NODE, 'snr_local', -5, ago, sourceA);
      await insert(hex(NODE), NODE, 'batteryLevel', 90, ago, sourceA);
    }
    await insert(hex(PRIVATE_NODE), PRIVATE_NODE, 'altitude', 12, 60_000, sourceA);
    await insert(hex(PRIVATE_NODE), PRIVATE_NODE, 'voltage', 4.1, 60_000, sourceA);
    await insert(hex(CH3_NODE), CH3_NODE, 'temperature', 30, 60_000, sourceA);
    await insert(MC_KEY, 0, 'mc_battery_volts', 3.9, 60_000, MC_SOURCE);

    // Source A favorites temperature + snr of NODE and the private node's
    // altitude/voltage and the channel-3 node; source B favorites nothing.
    await setFavorites(sourceA, [
      { nodeId: hex(NODE), telemetryType: 'temperature' },
      { nodeId: hex(NODE), telemetryType: 'snr_local' },
      { nodeId: hex(PRIVATE_NODE), telemetryType: 'altitude' },
      { nodeId: hex(PRIVATE_NODE), telemetryType: 'voltage' },
      { nodeId: hex(CH3_NODE), telemetryType: 'temperature' },
    ]);
    await setFavorites(sourceB, []);
    await setFavorites(MC_SOURCE, [{ nodeId: MC_KEY, telemetryType: 'mc_battery_volts' }]);
  });

  afterEach(async () => {
    for (const src of [harness.sourceA, harness.sourceB, MC_SOURCE]) {
      await harness.db.telemetry.deleteAllTelemetry(src);
      await harness.db.settings.deleteSetting(`source:${src}:telemetryFavorites`);
    }
    await harness.db.nodes.deleteAllNodes(harness.sourceA);
    await harness.db.nodes.deleteAllNodes(harness.sourceB);
    await harness.db.meshcore.deleteNode(MC_KEY, MC_SOURCE);
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  const series = async (user: SeededUser, query = ''): Promise<Series[]> => {
    const agent = await harness.loginAs(user);
    const res = await agent.get(`/api/unified/telemetry/series${query}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    return res.body.data.series as Series[];
  };

  const keys = (list: Series[]) =>
    list.map((s) => `${s.subjectKey}:${s.type}:${s.lines.map((l) => l.sourceId).join('+')}`).sort();

  it('an admin gets the union of favorites, with one line per source that holds the node', async () => {
    const list = await series(harness.admin);
    expect(keys(list)).toEqual([
      `${hex(CH3_NODE)}:temperature:${harness.sourceA}`,
      `${hex(NODE)}:snr_local:${harness.sourceA}`,
      `${hex(NODE)}:temperature:${harness.sourceA}+${harness.sourceB}`,
      `${hex(PRIVATE_NODE)}:altitude:${harness.sourceA}`,
      `${hex(PRIVATE_NODE)}:voltage:${harness.sourceA}`,
      `${MC_KEY}:mc_battery_volts:${MC_SOURCE}`,
    ].sort());

    const temp = list.find((s) => s.subjectKey === hex(NODE) && s.type === 'temperature')!;
    expect(temp.nodeName).toBe('Weather');
    expect(temp.category).toBe('environment');
    expect(temp.observerRelative).toBe(false);
    // Lines keep their own source's values, oldest first; no merged line.
    const [a, b] = temp.lines;
    expect(a.points.map((p) => p.value)).toEqual([20, 21, 22]);
    expect(b.points.map((p) => p.value)).toEqual([20.5, 21.5, 22.5]);
    // Only source A lists it as a favorite.
    expect(a.favorited).toBe(true);
    expect(b.favorited).toBe(false);
    expect(a.canEditFavorite).toBe(true);

    expect(list.find((s) => s.type === 'snr_local')!.observerRelative).toBe(true);
    // A non-favorited type of a favorited node is never fetched.
    expect(list.some((s) => s.type === 'batteryLevel')).toBe(false);
  });

  it('the window drops older points', async () => {
    const list = await series(harness.admin, '?hours=0.5');
    const temp = list.find((s) => s.subjectKey === hex(NODE) && s.type === 'temperature')!;
    expect(temp.lines[0].points.map((p) => p.value)).toEqual([22]);
  });

  it('a non-admin reads only sources with nodes:read and channels they can view there', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const list = await series(harness.limited);
    // No source B line (no nodes:read there), no channel-3 node, no MeshCore
    // source, and no altitude of the private node (no nodes_private:read).
    expect(keys(list)).toEqual([
      `${hex(NODE)}:snr_local:${harness.sourceA}`,
      `${hex(NODE)}:temperature:${harness.sourceA}`,
      `${hex(PRIVATE_NODE)}:voltage:${harness.sourceA}`,
    ].sort());
    // No settings:write on source A: the toggle is not offered.
    expect(list.every((s) => s.lines.every((l) => !l.canEditFavorite))).toBe(true);
  });

  it('nodes_private:read restores the private node position series', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
    const list = await series(harness.limited);
    expect(list.some((s) => s.subjectKey === hex(PRIVATE_NODE) && s.type === 'altitude')).toBe(true);
  });

  it('a favorite counts only where its node is visible: source B grants alone show nothing from A\'s list', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    // Source B has no favorites and the caller cannot read source A.
    expect(await series(harness.limited)).toEqual([]);
  });

  it('a channel grant alone reads nothing', async () => {
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    expect(await series(harness.limited)).toEqual([]);
  });

  it('settings:write on a source offers the toggle on that source only', async () => {
    for (const src of [harness.sourceA, harness.sourceB]) {
      await harness.grant(harness.limited.id, 'nodes', 'read', src);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', src);
    }
    await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceB);
    const temp = (await series(harness.limited)).find((s) => s.subjectKey === hex(NODE) && s.type === 'temperature')!;
    expect(temp.lines.map((l) => [l.sourceId, l.canEditFavorite])).toEqual([
      [harness.sourceA, false],
      [harness.sourceB, true],
    ]);
  });

  it('MeshCore needs nodes:viewOnMap on the source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', MC_SOURCE);
    expect(await series(harness.limited)).toEqual([]);
    // One row per (resource, source): replace it with read + viewOnMap.
    await harness.revokeAll(harness.limited.id);
    await harness.db.auth.createPermission({
      userId: harness.limited.id,
      resource: 'nodes',
      canRead: true,
      canWrite: false,
      canViewOnMap: true,
      sourceId: MC_SOURCE,
      grantedAt: Date.now(),
      grantedBy: null,
    });
    expect(keys(await series(harness.limited))).toEqual([`${MC_KEY}:mc_battery_volts:${MC_SOURCE}`]);
  });

  it('an anonymous caller gets nothing', async () => {
    const agent = await harness.loginAs(null);
    const res = await agent.get('/api/unified/telemetry/series');
    expect(res.status).toBe(200);
    expect(res.body.data.series).toEqual([]);
  });

  describe('Latest snapshot', () => {
    const latest = async (query = '') => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/api/unified/telemetry${query}`);
      expect(res.status).toBe(200);
      return res.body as Array<{ nodeId: string; telemetryType: string; value: number; timestamp: number; sourceId: string; nodeLongName: string | null; favorited: boolean; canEditFavorite: boolean }>;
    };

    it('returns the newest reading per node, type and source, newest first', async () => {
      const rows = await latest();
      const temp = rows.filter((r) => r.nodeId === hex(NODE) && r.telemetryType === 'temperature');
      expect(temp.map((r) => [r.sourceId, r.value]).sort()).toEqual([[harness.sourceA, 22], [harness.sourceB, 22.5]]);
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1].timestamp).toBeGreaterThanOrEqual(rows[i].timestamp);
      expect(temp.find((r) => r.sourceId === harness.sourceA)!.favorited).toBe(true);
      expect(temp.find((r) => r.sourceId === harness.sourceB)!.favorited).toBe(false);
      expect(temp[0].canEditFavorite).toBe(true);
      expect(temp[0].nodeLongName).toBe('Weather');
    });

    it('keys MeshCore rows by public key with the MeshCore node name (#4700)', async () => {
      const mc = (await latest()).filter((r) => r.sourceId === MC_SOURCE);
      expect(mc.map((r) => [r.nodeId, r.telemetryType, r.nodeLongName])).toEqual([[MC_KEY, 'mc_battery_volts', 'Repeater']]);
    });

    it('drops readings older than the window, and caps the window at 168 hours', async () => {
      const rows = await latest('?hours=0.01');
      expect(rows.length).toBe(0);
      const capped = await latest('?hours=9999');
      expect(capped.length).toBeGreaterThan(0);
    });
  });
});
