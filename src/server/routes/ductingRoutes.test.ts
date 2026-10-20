/**
 * Ducting forecast route (#5734): the admin switch, the map read gate, input
 * checks, the caller-scoped default area, and how NOAA failures surface.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ductingRoutes, { bboxFromPositions, parseBBox, resetDuctingForecastForTests } from './ductingRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn().mockReturnValue(null), getAllManagers: vi.fn().mockReturnValue([]) },
}));

const FIXTURE = readFileSync(
  fileURLToPath(new URL('../services/ducting/__fixtures__/gfs-2026101812-f003-tampa.grb2', import.meta.url)),
);
const TAMPA = '-83,27,-82,28';
const TAMPA_BOX = { minLat: 27, maxLat: 28, minLon: -83, maxLon: -82 };

function stubNoaa(status: number, body: Buffer | string) {
  const fetchMock = vi.fn(async () => {
    const b = typeof body === 'string' ? Buffer.from(body) : body;
    return {
      ok: status === 200,
      status,
      arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('parseBBox / bboxFromPositions', () => {
  it('parses a valid box and names what is wrong with a bad one', () => {
    expect(parseBBox(TAMPA)).toEqual(TAMPA_BOX);
    expect(parseBBox('1,2,3')).toMatch(/minLon,minLat,maxLon,maxLat/);
    expect(parseBBox('-83,28,-82,27')).toMatch(/min must be below max/);
    expect(parseBBox('-100,20,-70,30')).toMatch(/at most 20/);
    expect(parseBBox('-190,20,-170,30')).toMatch(/outside/);
  });

  it('pads, snaps to the 0.25 degree grid, and ignores a far-off outlier', () => {
    const florida = Array.from({ length: 40 }, (_, i) => ({ lat: 27.1 + (i % 5) * 0.2, lon: -82.6 + (i % 4) * 0.2 }));
    const box = bboxFromPositions([...florida, { lat: 51.5, lon: -0.1 }])!;
    expect(box).toEqual({ minLat: 26.5, maxLat: 28.5, minLon: -83.25, maxLon: -81.5 });
  });

  it('caps the span around the centre', () => {
    const box = bboxFromPositions([
      ...Array.from({ length: 10 }, () => ({ lat: 0, lon: -120 })),
      ...Array.from({ length: 10 }, () => ({ lat: 40, lon: -60 })),
    ])!;
    expect(box.maxLat - box.minLat).toBe(20);
    expect(box.maxLon - box.minLon).toBe(20);
  });

  it('returns null with no points', () => {
    expect(bboxFromPositions([])).toBeNull();
  });
});

describe('GET /ducting/forecast', () => {
  let harness: RouteTestHarness;
  const now = () => Math.floor(Date.now() / 1000);

  /** A Tampa node on source A, and a Texas node on source B. */
  async function seedTwoSources() {
    await harness.db.nodes.upsertNode(
      { nodeNum: 0x5734a, nodeId: '!0005734a', latitude: 27.5, longitude: -82.5, lastHeard: now(), channel: 0 },
      harness.sourceA,
    );
    await harness.db.nodes.upsertNode(
      { nodeNum: 0x5734c, nodeId: '!0005734c', latitude: 30.5, longitude: -97.5, lastHeard: now(), channel: 0 },
      harness.sourceB,
    );
  }

  /** A map viewer on source A only: nodes:read plus channel 0 on the map. */
  async function grantMapViewerA() {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
  }

  beforeEach(async () => {
    resetDuctingForecastForTests();
    harness = await createRouteTestApp({ mount: (app) => app.use('/ducting', ductingRoutes) });
    await harness.db.settings.setSetting('ductingOverlayEnabled', 'true');
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await harness.db.settings.deleteSetting('ductingOverlayEnabled').catch(() => {});
    await harness.db.nodes.deleteAllNodes(harness.sourceA);
    await harness.db.nodes.deleteAllNodes(harness.sourceB);
    await harness.cleanup();
  });

  describe('while the setting is off', () => {
    it.each([['absent'], ['false']])('refuses everyone, admins included, and fetches nothing (setting %s)', async (state) => {
      if (state === 'absent') await harness.db.settings.deleteSetting('ductingOverlayEnabled');
      else await harness.db.settings.setSetting('ductingOverlayEnabled', 'false');
      const fetchMock = stubNoaa(200, FIXTURE);
      await seedTwoSources();
      await grantMapViewerA();

      for (const who of [harness.admin, harness.limited, null]) {
        const agent = await harness.loginAs(who);
        for (const q of ['', `?bbox=${TAMPA}`]) {
          const res = await agent.get(`/ducting/forecast${q}`);
          expect(res.status).toBe(403);
          expect(res.body.code).toBe('DUCTING_DISABLED');
        }
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('while the setting is on', () => {
    it('lets a map viewer fetch the default area', async () => {
      const fetchMock = stubNoaa(200, FIXTURE);
      await seedTwoSources();
      await grantMapViewerA();
      const user = await harness.loginAs(harness.limited);
      const res = await user.get('/ducting/forecast?hoursAhead=24');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.grid).toMatchObject({ ni: 5, nj: 5 });
      expect(res.body.data.class).toHaveLength(25);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('denies a caller without map access, and fetches nothing', async () => {
      const fetchMock = stubNoaa(200, FIXTURE);
      await seedTwoSources();
      // A grant that is not map access.
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      const user = await harness.loginAs(harness.limited);
      const res = await user.get('/ducting/forecast');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');

      await harness.revokeAll(harness.anonymous.id);
      const anon = await harness.loginAs(null);
      expect((await anon.get('/ducting/forecast')).status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('builds the default area only from nodes the caller can see', async () => {
      const fetchMock = stubNoaa(200, FIXTURE);
      await seedTwoSources();
      await grantMapViewerA();
      const user = await harness.loginAs(harness.limited);
      const res = await user.get('/ducting/forecast');
      expect(res.status).toBe(200);
      // Source B's Texas node would stretch the box west if it leaked in.
      expect(res.body.data.bbox).toEqual(TAMPA_BOX);

      // An admin sees both sources, so the box spans Tampa to Texas.
      const admin = await harness.loginAs(harness.admin);
      const wide = await admin.get('/ducting/forecast');
      expect(wide.status).toBe(200);
      expect(wide.body.data.bbox.minLon).toBeLessThan(-97);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('leaves out a node whose channel the caller may not see on the map', async () => {
      stubNoaa(200, FIXTURE);
      await seedTwoSources();
      await harness.db.nodes.upsertNode(
        { nodeNum: 0x5734d, nodeId: '!0005734d', latitude: 35.5, longitude: -80.5, lastHeard: now(), channel: 1 },
        harness.sourceA,
      );
      await grantMapViewerA();
      const user = await harness.loginAs(harness.limited);
      const res = await user.get('/ducting/forecast');
      expect(res.status).toBe(200);
      expect(res.body.data.bbox).toEqual(TAMPA_BOX);
    });

    it('ignores nodes heard too long ago, and asks for nodes when there are none', async () => {
      stubNoaa(200, FIXTURE);
      await grantMapViewerA();
      const user = await harness.loginAs(harness.limited);
      await harness.db.nodes.upsertNode(
        { nodeNum: 0x5734b, nodeId: '!0005734b', latitude: 45, longitude: -100, lastHeard: now() - 30 * 86400, channel: 0 },
        harness.sourceA,
      );
      const none = await user.get('/ducting/forecast');
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('NO_AREA');
    });

    it('lets only an admin pick the area with bbox', async () => {
      const fetchMock = stubNoaa(200, FIXTURE);
      await seedTwoSources();
      await grantMapViewerA();
      const user = await harness.loginAs(harness.limited);
      const refused = await user.get(`/ducting/forecast?bbox=${TAMPA}`);
      expect(refused.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();

      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get(`/ducting/forecast?bbox=${TAMPA}`);
      expect(res.status).toBe(200);
      expect(res.body.data.bbox).toEqual(TAMPA_BOX);
    });

    it.each([['hoursAhead=73'], ['hoursAhead=-1'], ['hoursAhead=1.5'], ['bbox=nope']])(
      'rejects %s',
      async (query) => {
        const fetchMock = stubNoaa(200, FIXTURE);
        const admin = await harness.loginAs(harness.admin);
        const res = await admin.get(`/ducting/forecast?${query}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_INPUT');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('serves a repeat request from the cache', async () => {
      const fetchMock = stubNoaa(200, FIXTURE);
      await seedTwoSources();
      await grantMapViewerA();
      const user = await harness.loginAs(harness.limited);
      expect((await user.get('/ducting/forecast?hoursAhead=6')).status).toBe(200);
      expect((await user.get('/ducting/forecast?hoursAhead=6')).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('answers 503 when NOAA has no recent cycle', async () => {
      stubNoaa(403, '<html>This data is not yet available.</html>');
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get(`/ducting/forecast?bbox=${TAMPA}`);
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('GFS_UNAVAILABLE');
    });

    it('answers 502 when NOAA sends GRIB it cannot read', async () => {
      const bad = Buffer.from(FIXTURE);
      let p = 16;
      while (bad[p + 4] !== 5) p += bad.readUInt32BE(p);
      bad.writeUInt16BE(40, p + 9); // data template 5.40 (JPEG 2000)
      stubNoaa(200, bad);
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get(`/ducting/forecast?bbox=${TAMPA}`);
      expect(res.status).toBe(502);
      expect(res.body.code).toBe('GFS_UNREADABLE');
    });
  });
});
