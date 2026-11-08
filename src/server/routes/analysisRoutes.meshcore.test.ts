/**
 * Map Analysis routes with MeshCore data (#6260 P5 WP1).
 *
 * Real-middleware harness (createRouteTestApp). MeshCore sources are created
 * here because the harness seeds Meshtastic sources only.
 *
 *  - positions / coverage: a MeshCore row needs `nodes:viewOnMap` on ITS
 *    source, and a private location override needs `nodes_private:read`;
 *  - an unpermitted MeshCore source contributes nothing anywhere;
 *  - solar: MeshCore telemetry + names appear for permitted sources only, and
 *    overrides on a synthetic nodeNum work like any other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import analysisRoutes from './analysisRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';

const MC_A = 'rt-mc-a';
const MC_B = 'rt-mc-b';
const PK_1 = '11'.repeat(32);
const PK_2 = '22'.repeat(32);
const PK_B = 'bb'.repeat(32);

describe('analysisRoutes — MeshCore (#6260)', () => {
  let harness: RouteTestHarness;
  const now = () => Date.now();

  async function seedMeshCore(): Promise<void> {
    for (const [id, name] of [[MC_A, 'MC A'], [MC_B, 'MC B']] as const) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name, type: 'meshcore', config: {}, enabled: true });
    }
    const t = now();
    await harness.db.meshcore.upsertNode(
      { publicKey: PK_1, name: 'Hilltop', advType: 2, latitude: 40, longitude: -100, lastHeard: t - 1000, pathLen: 2 },
      MC_A,
    );
    await harness.db.meshcore.upsertNode(
      { publicKey: PK_2, name: 'Valley', advType: 1, latitude: 41, longitude: -101, lastHeard: t - 2000, pathLen: 0 },
      MC_A,
    );
    // The harness DB outlives a test, and upsertNode never touches overrides.
    await harness.db.meshcore.clearNodePositionOverride(MC_A, PK_1);
    await harness.db.meshcore.upsertNode(
      { publicKey: PK_B, name: 'Other Source', advType: 2, latitude: 42, longitude: -102, lastHeard: t - 1000, pathLen: 1 },
      MC_B,
    );
  }

  /** One permission row per (user, resource, source): read + viewOnMap share a row. */
  async function grantNodes(
    resource: string,
    sourceId: string,
    flags: { read?: boolean; viewOnMap?: boolean },
  ): Promise<void> {
    await harness.db.auth.createPermission({
      userId: harness.limited.id,
      resource,
      canRead: flags.read === true,
      canWrite: false,
      canViewOnMap: flags.viewOnMap === true,
      sourceId,
      grantedAt: Date.now(),
      grantedBy: null,
    });
  }

  async function mcTelemetry(sourceId: string, publicKey: string, type: string, value: number) {
    const nodeNum = nodeNumFromPubkey(publicKey);
    // telemetry.nodeNum references nodes; give the synthetic number a row.
    await harness.db.nodes
      .upsertNode({ nodeNum, nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`, longName: null as never }, sourceId)
      .catch(() => {});
    await harness.db.telemetry.insertTelemetry(
      {
        nodeId: publicKey, nodeNum, telemetryType: type, timestamp: now() - 60_000, value, createdAt: now(),
      } as never,
      sourceId,
    );
  }

  /** All positions, following the phase cursor to the end. */
  async function allPositions(agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>) {
    const items: any[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res: any = await agent.get('/positions').query({ since: String(now() - 3_600_000), ...(cursor ? { cursor } : {}) });
      expect(res.status).toBe(200);
      items.push(...res.body.items);
      if (!res.body.hasMore) break;
      cursor = res.body.nextCursor;
    }
    return items;
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', analysisRoutes) });
    await seedMeshCore();
  });

  afterEach(async () => {
    await harness.db.sources.deleteSource(MC_A).catch(() => {});
    await harness.db.sources.deleteSource(MC_B).catch(() => {});
    for (const o of await harness.db.solarNodeOverrides.getAllAsync()) {
      await harness.db.solarNodeOverrides.clearAsync(o.nodeNum);
    }
    await harness.cleanup();
  });

  describe('positions', () => {
    it('shows MeshCore current fixes to an admin, keyed by nodeKey', async () => {
      const items = await allPositions(await harness.loginAs(harness.admin));
      // Current fixes plus any history rows the upserts logged: dedupe by key.
      const keys = [...new Set(items.filter((i) => i.publicKey).map((i) => i.nodeKey))].sort();
      expect(keys).toEqual([`mc:${PK_1}`, `mc:${PK_2}`, `mc:${PK_B}`].sort());
    });

    it('returns no MeshCore positions without nodes:viewOnMap', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', MC_A);
      const items = await allPositions(await harness.loginAs(harness.limited));
      expect(items.filter((i) => i.publicKey)).toEqual([]);
    });

    it('returns MeshCore positions with viewOnMap, only for the granted source', async () => {
      await grantNodes('nodes', MC_A, { read: true, viewOnMap: true });
      const items = await allPositions(await harness.loginAs(harness.limited));
      expect([...new Set(items.map((i) => i.nodeKey))].sort()).toEqual([`mc:${PK_1}`, `mc:${PK_2}`].sort());
    });

    it('drops a private override unless the viewer holds nodes_private:read', async () => {
      await harness.db.meshcore.setNodePositionOverride(MC_A, PK_1, {
        enabled: true, latitude: 40.5, longitude: -100.5, isPrivate: true,
      });
      await grantNodes('nodes', MC_A, { read: true, viewOnMap: true });

      let items = await allPositions(await harness.loginAs(harness.limited));
      expect([...new Set(items.map((i) => i.nodeKey))]).toEqual([`mc:${PK_2}`]);

      await grantNodes('nodes_private', MC_A, { read: true });
      items = await allPositions(await harness.loginAs(harness.limited));
      expect([...new Set(items.map((i) => i.nodeKey))].sort()).toEqual([`mc:${PK_1}`, `mc:${PK_2}`].sort());
    });

    it('returns nothing for a MeshCore source the viewer cannot read', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await grantNodes('nodes', MC_B, { viewOnMap: true });
      const items = await allPositions(await harness.loginAs(harness.limited));
      expect(items.filter((i) => i.publicKey)).toEqual([]);
    });

    it('applies the same filter to the coverage grid', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', MC_A);
      const denied = await (await harness.loginAs(harness.limited)).get('/coverage-grid').query({ since: String(now() - 3_600_000), zoom: '3' });
      expect(denied.status).toBe(200);
      expect(denied.body.cells).toEqual([]);

      await harness.revokeAll(harness.limited.id);
      await grantNodes('nodes', MC_A, { read: true, viewOnMap: true });
      const allowed = await (await harness.loginAs(harness.limited)).get('/coverage-grid').query({ since: String(now() - 3_600_000), zoom: '3' });
      expect(allowed.body.cells.reduce((n: number, c: any) => n + c.count, 0)).toBe(2);
    });
  });

  describe('hop-counts', () => {
    it('includes MeshCore path_len entries for permitted sources only', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', MC_A);
      const res = await (await harness.loginAs(harness.limited)).get('/hop-counts');
      expect(res.status).toBe(200);
      const byKey = new Map(res.body.entries.map((e: any) => [e.nodeKey, e]));
      expect([...byKey.keys()].sort()).toEqual([`mc:${PK_1}`, `mc:${PK_2}`].sort());
      expect((byKey.get(`mc:${PK_1}`) as any).hops).toBe(2);
      expect((byKey.get(`mc:${PK_2}`) as any).hops).toBe(0);
    });
  });

  describe('solar', () => {
    it('names MeshCore nodes and honours an override on the synthetic nodeNum', async () => {
      await mcTelemetry(MC_A, PK_1, 'mc_battery_volts', 3.9);
      const num = nodeNumFromPubkey(PK_1);

      const admin = await harness.loginAs(harness.admin);
      const put = await admin.put(`/solar-overrides/${num}`).send({ isSolar: true });
      expect(put.status).toBe(200);

      const res = await admin.get('/solar-nodes');
      expect(res.status).toBe(200);
      expect(res.body.analyzed_nodes).toContainEqual({ node_num: num, node_name: 'Hilltop' });
      expect(res.body.solar_nodes.map((n: any) => [n.node_num, n.node_name])).toContainEqual([num, 'Hilltop']);
      expect(res.body.manual_overrides).toContainEqual({ node_num: num, node_name: 'Hilltop', is_solar: true });
    });

    it('leaks neither telemetry, names nor overrides from an unpermitted source', async () => {
      await mcTelemetry(MC_B, PK_B, 'mc_battery_volts', 3.8);
      const numB = nodeNumFromPubkey(PK_B);
      await (await harness.loginAs(harness.admin)).put(`/solar-overrides/${numB}`).send({ isSolar: true });

      await harness.grant(harness.limited.id, 'nodes', 'read', MC_A);
      const res = await (await harness.loginAs(harness.limited)).get('/solar-nodes');
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain('Other Source');
      expect(res.body.analyzed_nodes.map((n: any) => n.node_num)).not.toContain(numB);
      expect(res.body.manual_overrides.map((o: any) => o.node_num)).not.toContain(numB);

      const forecast = await (await harness.loginAs(harness.limited)).get('/solar-forecast');
      expect(forecast.status).toBe(200);
      expect(JSON.stringify(forecast.body)).not.toContain('Other Source');
    });

    it('lets a settings:write user PUT an override on a synthetic nodeNum', async () => {
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const num = nodeNumFromPubkey(PK_2);
      const res = await (await harness.loginAs(harness.limited)).put(`/solar-overrides/${num}`).send({ isSolar: false });
      expect(res.status).toBe(200);
      expect((await harness.db.solarNodeOverrides.getMapAsync()).get(num)).toBe(false);
    });
  });
});
