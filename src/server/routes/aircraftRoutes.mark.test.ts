/**
 * POST /api/aircraft/mark (#5715): manual not-aircraft / aircraft / clear.
 *
 * Real-middleware harness (createRouteTestApp) against the live :memory:
 * singleton, so the per-source `nodes:write` check and the writes run real
 * SQL. The queued reclassify is stubbed (it would sample the DEM); each test
 * runs the silent, no-network `reclassifySource` instead to see the verdict
 * the classifier reaches with the mark in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import aircraftRoutes from './aircraftRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { aircraftClassificationService } from '../services/aircraftClassificationService.js';

const PLANE = 0x73000001; // 3000 m over ground 0 → flagged
const GROUND = 0x73000002; // 10 m over ground 0 → not flagged
const NO_POS = 0x73000003; // flagged by altitude, no lat/lon
const B_PLANE = 0x73000004;
const MC_NODE = 0x73000005;
const ALL = [PLANE, GROUND, NO_POS, B_PLANE, MC_NODE];
const MC_SOURCE = 'rt-mc-5715';

const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;

describe('POST /api/aircraft/mark', () => {
  let harness: RouteTestHarness;
  let scheduleSpy: ReturnType<typeof vi.spyOn>;

  const seedNode = async (
    nodeNum: number,
    sourceId: string,
    opts: { altitude: number; lat?: number | null; lon?: number | null },
  ) => {
    await harness.db.nodes.upsertNode(
      {
        nodeNum,
        nodeId: nodeIdFor(nodeNum),
        longName: `Node ${nodeNum.toString(16)}`,
        shortName: 'N',
        channel: 0,
        latitude: opts.lat === undefined ? 30.0 : opts.lat,
        longitude: opts.lon === undefined ? -80.0 : opts.lon,
        altitude: opts.altitude,
        lastHeard: Math.floor(Date.now() / 1000),
      } as any,
      sourceId,
    );
    await harness.db.nodes.setAircraftClassification(nodeNum, sourceId, {
      likelyAircraft: opts.altitude > 500,
      aircraftBasis: 'agl',
      groundElevation: 0,
      heightAboveGround: opts.altitude,
      aircraftClassifiedAt: Date.now(),
    });
  };

  const row = (nodeNum: number, sourceId: string) => harness.db.nodes.getNode(nodeNum, sourceId);
  const post = async (agent: Awaited<ReturnType<RouteTestHarness['loginAs']>>, body: Record<string, unknown>) =>
    agent.post('/mark').send(body);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', aircraftRoutes) });
    scheduleSpy = vi.spyOn(aircraftClassificationService, 'schedule').mockImplementation(() => {});
    await seedNode(PLANE, harness.sourceA, { altitude: 3000 });
    await seedNode(GROUND, harness.sourceA, { altitude: 10 });
    await seedNode(NO_POS, harness.sourceA, { altitude: 3000, lat: null, lon: null });
    await seedNode(B_PLANE, harness.sourceB, { altitude: 3000 });
  });

  afterEach(async () => {
    scheduleSpy.mockRestore();
    for (const sourceId of [harness.sourceA, harness.sourceB, MC_SOURCE]) {
      for (const n of ALL) {
        await harness.db.nodes.deleteNodeRecord(n, sourceId).catch(() => {});
      }
    }
    await harness.db.settings.setSourceSetting(harness.sourceA, 'aircraftDetectionEnabled', 'true');
    await harness.db.sources.deleteSource(MC_SOURCE).catch(() => {});
    await harness.cleanup();
  });

  describe('not_aircraft', () => {
    it('anchors at the current position, clears the flag, and queues a silent reclassify', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' } });
      const n = await row(PLANE, harness.sourceA);
      expect(n?.aircraftManualMark).toBe('not_aircraft');
      expect(Number(n?.aircraftManualMarkBy)).toBe(harness.admin.id);
      expect(n?.aircraftManualMarkAt).toBeTypeOf('number');
      expect(n?.aircraftFixedAt).toBe(n?.aircraftManualMarkAt);
      expect(Number(n?.aircraftFixedLatitude)).toBeCloseTo(30.0);
      expect(Number(n?.aircraftFixedLongitude)).toBeCloseTo(-80.0);
      expect(Boolean(n?.likelyAircraft)).toBe(false);
      expect(scheduleSpy).toHaveBeenCalledWith(harness.sourceA, PLANE, 'manual');
    });

    it('holds within 1 km of the anchor and releases beyond it', async () => {
      const agent = await harness.loginAs(harness.admin);
      await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' });

      // ~500 m north: still forced false.
      await harness.db.nodes.upsertNode({ nodeNum: PLANE, nodeId: nodeIdFor(PLANE), latitude: 30.0045 } as any, harness.sourceA);
      await aircraftClassificationService.reclassifySource(harness.sourceA);
      let n = await row(PLANE, harness.sourceA);
      expect(Boolean(n?.likelyAircraft)).toBe(false);
      expect(n?.aircraftManualMark).toBe('not_aircraft');

      // ~2 km north: the mark and anchor go, and the altitude rule flags it again.
      await harness.db.nodes.upsertNode({ nodeNum: PLANE, nodeId: nodeIdFor(PLANE), latitude: 30.018 } as any, harness.sourceA);
      await aircraftClassificationService.reclassifySource(harness.sourceA);
      n = await row(PLANE, harness.sourceA);
      expect(Boolean(n?.likelyAircraft)).toBe(true);
      expect(n?.aircraftManualMark ?? null).toBeNull();
      expect(n?.aircraftFixedAt ?? null).toBeNull();
    });

    it('refuses a node with no position: 400 AIRCRAFT_NO_POSITION, nothing written', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: NO_POS, mode: 'not_aircraft' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'AIRCRAFT_NO_POSITION' });
      const n = await row(NO_POS, harness.sourceA);
      expect(n?.aircraftManualMark ?? null).toBeNull();
      expect(Boolean(n?.likelyAircraft)).toBe(true);
      expect(scheduleSpy).not.toHaveBeenCalled();
    });
  });

  describe('aircraft', () => {
    it('flags a ground node and survives reclassification', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: GROUND, mode: 'aircraft' });
      expect(res.status).toBe(200);

      let n = await row(GROUND, harness.sourceA);
      expect(n?.aircraftManualMark).toBe('aircraft');
      expect(Boolean(n?.likelyAircraft)).toBe(true);

      await aircraftClassificationService.reclassifySource(harness.sourceA);
      await aircraftClassificationService.reclassifySource(harness.sourceA);
      n = await row(GROUND, harness.sourceA);
      expect(Boolean(n?.likelyAircraft)).toBe(true);
      expect(n?.aircraftManualMark).toBe('aircraft');
    });

    it('drops an existing fixed anchor', async () => {
      const agent = await harness.loginAs(harness.admin);
      await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' });
      await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'aircraft' });

      const n = await row(PLANE, harness.sourceA);
      expect(n?.aircraftManualMark).toBe('aircraft');
      expect(n?.aircraftFixedAt ?? null).toBeNull();
      expect(Boolean(n?.likelyAircraft)).toBe(true);
    });
  });

  describe('clear', () => {
    it('releases a manual aircraft mark and the classifier restores its own verdict', async () => {
      const agent = await harness.loginAs(harness.admin);
      await post(agent, { sourceId: harness.sourceA, nodeNum: GROUND, mode: 'aircraft' });
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: GROUND, mode: 'clear' });
      expect(res.status).toBe(200);

      await aircraftClassificationService.reclassifySource(harness.sourceA);
      const n = await row(GROUND, harness.sourceA);
      expect(n?.aircraftManualMark ?? null).toBeNull();
      expect(n?.aircraftManualMarkAt ?? null).toBeNull();
      expect(Boolean(n?.likelyAircraft)).toBe(false);
    });

    it('releases a not-aircraft mark (and its anchor) and the flag comes back', async () => {
      const agent = await harness.loginAs(harness.admin);
      await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' });
      await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'clear' });

      await aircraftClassificationService.reclassifySource(harness.sourceA);
      const n = await row(PLANE, harness.sourceA);
      expect(n?.aircraftManualMark ?? null).toBeNull();
      expect(n?.aircraftFixedAt ?? null).toBeNull();
      expect(Boolean(n?.likelyAircraft)).toBe(true);
    });

    it('recomputes at once from stored values, before the queued job runs', async () => {
      await harness.db.nodes.setAircraftFixed(PLANE, harness.sourceA, { atMs: Date.now(), lat: 30, lon: -80 });
      expect(Boolean((await row(PLANE, harness.sourceA))?.likelyAircraft)).toBe(false);
      const agent = await harness.loginAs(harness.admin);
      await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'clear' });
      // No reclassifySource here, and schedule() is stubbed.
      expect(Boolean((await row(PLANE, harness.sourceA))?.likelyAircraft)).toBe(true);
    });

    it('also releases an automatic fixed mark', async () => {
      await harness.db.nodes.setAircraftFixed(PLANE, harness.sourceA, { atMs: Date.now(), lat: 30, lon: -80 });
      const agent = await harness.loginAs(harness.admin);
      await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'clear' });

      await aircraftClassificationService.reclassifySource(harness.sourceA);
      const n = await row(PLANE, harness.sourceA);
      expect(n?.aircraftFixedAt ?? null).toBeNull();
      expect(Boolean(n?.likelyAircraft)).toBe(true);
    });
  });

  describe('permissions', () => {
    it('allows nodes:write on this source', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' });
      expect(res.status).toBe(200);
    });

    it('refuses nodes:write held only on another source', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await post(agent, { sourceId: harness.sourceB, nodeNum: B_PLANE, mode: 'not_aircraft' });
      expect(res.status).toBe(403);
      const n = await row(B_PLANE, harness.sourceB);
      expect(n?.aircraftManualMark ?? null).toBeNull();
    });

    it('refuses read-only access', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' });
      expect(res.status).toBe(403);
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'not_aircraft' });
      expect([401, 403]).toContain(res.status);
      const n = await row(PLANE, harness.sourceA);
      expect(n?.aircraftManualMark ?? null).toBeNull();
    });

    it('requires a sourceId', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await post(agent, { nodeNum: PLANE, mode: 'not_aircraft' });
      expect(res.status).toBe(400);
    });
  });

  describe('validation and gates', () => {
    it('rejects an unknown mode and a bad nodeNum', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await post(agent, { sourceId: harness.sourceA, nodeNum: PLANE, mode: 'fixed' })).body.code).toBe('INVALID_MODE');
      expect((await post(agent, { sourceId: harness.sourceA, nodeNum: '123', mode: 'clear' })).body.code).toBe('INVALID_NODE_NUM');
      expect((await post(agent, { sourceId: harness.sourceA, nodeNum: -1, mode: 'clear' })).body.code).toBe('INVALID_NODE_NUM');
    });

    it('404s an unknown node', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: 0x73fffff0, mode: 'aircraft' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NODE_NOT_FOUND');
    });

    it.each(['meshcore', 'reticulum'] as const)('refuses a %s source', async (type) => {
      await harness.db.sources.createSource({ id: MC_SOURCE, name: 'Excluded', type: type as any, config: {}, enabled: true });
      await seedNode(MC_NODE, MC_SOURCE, { altitude: 3000 });
      const agent = await harness.loginAs(harness.admin);
      const res = await post(agent, { sourceId: MC_SOURCE, nodeNum: MC_NODE, mode: 'not_aircraft' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('AIRCRAFT_SOURCE_UNSUPPORTED');
      await harness.db.nodes.deleteNodeRecord(MC_NODE, MC_SOURCE).catch(() => {});
      await harness.db.sources.deleteSource(MC_SOURCE);
    });

    it('refuses while detection is off for the source', async () => {
      await harness.db.settings.setSourceSetting(harness.sourceA, 'aircraftDetectionEnabled', 'false');
      const agent = await harness.loginAs(harness.admin);
      const res = await post(agent, { sourceId: harness.sourceA, nodeNum: GROUND, mode: 'aircraft' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('AIRCRAFT_DETECTION_DISABLED');
    });
  });

  it('writes an audit entry with who, node, source and mode', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    await post(agent, { sourceId: harness.sourceA, nodeNum: GROUND, mode: 'aircraft' });

    await vi.waitFor(async () => {
      const { logs } = await harness.db.auth.getAuditLogsFiltered({ action: 'aircraft_manual_mark', userId: harness.limited.id });
      const entry = logs.find((l) => String(l.details ?? '').includes(String(GROUND)));
      expect(entry).toBeDefined();
      expect(entry?.resource).toBe('nodes');
      expect(JSON.parse(String(entry?.details))).toEqual({
        sourceId: harness.sourceA,
        nodeNum: GROUND,
        mode: 'aircraft',
        previousMark: null,
      });
    });
  });

  it('writes no audit entry for a refused request', async () => {
    const agent = await harness.loginAs(harness.admin);
    await post(agent, { sourceId: harness.sourceA, nodeNum: NO_POS, mode: 'not_aircraft' });
    await new Promise((r) => setTimeout(r, 20));
    const { logs } = await harness.db.auth.getAuditLogsFiltered({ action: 'aircraft_manual_mark' });
    expect(logs.some((l) => String(l.details ?? '').includes(String(NO_POS)))).toBe(false);
  });
});
