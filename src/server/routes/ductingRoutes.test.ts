/**
 * Ducting forecast route (#5734 spike): admin-only, input checks, the
 * node-derived default area, and how NOAA failures surface.
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
    expect(parseBBox(TAMPA)).toEqual({ minLat: 27, maxLat: 28, minLon: -83, maxLon: -82 });
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

  beforeEach(async () => {
    resetDuctingForecastForTests();
    harness = await createRouteTestApp({ mount: (app) => app.use('/ducting', ductingRoutes) });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await harness.cleanup();
  });

  it('is admin-only', async () => {
    const fetchMock = stubNoaa(200, FIXTURE);
    await harness.grant(harness.limited.id, 'sources', 'write', harness.sourceA);
    const user = await harness.loginAs(harness.limited);
    expect((await user.get(`/ducting/forecast?bbox=${TAMPA}`)).status).toBe(403);
    const anon = await harness.loginAs(null);
    expect((await anon.get(`/ducting/forecast?bbox=${TAMPA}`)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the indexed grid for an admin', async () => {
    stubNoaa(200, FIXTURE);
    const admin = await harness.loginAs(harness.admin);
    const res = await admin.get(`/ducting/forecast?bbox=${TAMPA}&hoursAhead=24`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.bbox).toEqual({ minLat: 27, maxLat: 28, minLon: -83, maxLon: -82 });
    expect(res.body.data.grid).toMatchObject({ ni: 5, nj: 5 });
    expect(res.body.data.class).toHaveLength(25);
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

  it('defaults the area to recently heard nodes, and asks for a box when there are none', async () => {
    stubNoaa(200, FIXTURE);
    const admin = await harness.loginAs(harness.admin);
    const none = await admin.get('/ducting/forecast');
    expect(none.status).toBe(400);
    expect(none.body.code).toBe('NO_AREA');

    const now = Math.floor(Date.now() / 1000);
    await harness.db.nodes.upsertNode(
      { nodeNum: 0x5734a, nodeId: '!0005734a', latitude: 27.5, longitude: -82.5, lastHeard: now },
      harness.sourceA,
    );
    // Heard too long ago to count.
    await harness.db.nodes.upsertNode(
      { nodeNum: 0x5734b, nodeId: '!0005734b', latitude: 45, longitude: -100, lastHeard: now - 30 * 86400 },
      harness.sourceA,
    );
    const res = await admin.get('/ducting/forecast');
    expect(res.status).toBe(200);
    expect(res.body.data.bbox).toEqual({ minLat: 27, maxLat: 28, minLon: -83, maxLon: -82 });
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
