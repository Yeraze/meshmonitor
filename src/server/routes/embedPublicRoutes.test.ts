/**
 * embedPublicRoutes — GET /:profileId/traceroutes (#4047 Phase 6 WP1)
 *
 * This is a public/anonymous route (profile-ID-as-token, no session, no
 * requirePermission) so the `createRouteTestApp` harness — which targets
 * requirePermission/optionalAuth-protected routes — does not apply
 * (docs/internal/dev-notes/MAP_CONSOLIDATION_P6_SPEC.md §5.1). Instead this
 * mounts the router on a bare express() app and seeds the live singleton
 * `:memory:` SQLite `databaseService` directly, following the DB-seeding
 * style of embedProfileRoutes.test.ts (minus the auth/session wiring).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import embedPublicRoutes from './embedPublicRoutes.js';
import databaseService from '../../services/database.js';
import type { DbTraceroute } from '../../db/types.js';

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use('/api/embed', embedPublicRoutes);
  return app;
};

let seq = 0;
/** Unique-ish node number per test so parallel `it` blocks never collide. */
const nextNodeNum = () => 0x10000000 + (seq += 1);
/**
 * Each `it` block gets its OWN sourceId. The DB singleton persists for the
 * whole test file (isolate mode resets it only between files), so without
 * per-test source scoping a later test's `getAllTraceroutes`/`getActiveNodes`
 * calls would also see nodes/traceroutes seeded by earlier tests — this
 * mirrors real multi-source isolation (CLAUDE.md "per-source scoping is
 * mandatory") rather than fighting cross-test contamination with sleeps or
 * DB resets.
 */
const nextSourceId = () => `rt-embed-src-${(seq += 1)}`;

async function seedNode(sourceId: string, overrides: {
  nodeNum: number;
  lat?: number | null;
  lng?: number | null;
  channel?: number;
  viaMqtt?: boolean;
  hideFromMap?: boolean;
  name?: string;
}) {
  await databaseService.nodes.upsertNode(
    {
      nodeNum: overrides.nodeNum,
      nodeId: `!${overrides.nodeNum.toString(16)}`,
      longName: overrides.name ?? `Node ${overrides.nodeNum}`,
      shortName: 'ND',
      latitude: overrides.lat === undefined ? 40.0 : overrides.lat,
      longitude: overrides.lng === undefined ? -70.0 : overrides.lng,
      lastHeard: Math.floor(Date.now() / 1000),
      channel: overrides.channel ?? 0,
      viaMqtt: overrides.viaMqtt ?? false,
      hideFromMap: overrides.hideFromMap ?? false,
    },
    sourceId,
  );
}

async function seedTraceroute(sourceId: string, overrides: Partial<DbTraceroute> & { fromNodeNum: number; toNodeNum: number }) {
  const now = Date.now();
  const row: DbTraceroute = {
    fromNodeNum: overrides.fromNodeNum,
    toNodeNum: overrides.toNodeNum,
    fromNodeId: `!${overrides.fromNodeNum.toString(16)}`,
    toNodeId: `!${overrides.toNodeNum.toString(16)}`,
    route: overrides.route ?? '[]',
    routeBack: overrides.routeBack ?? null,
    snrTowards: overrides.snrTowards ?? null,
    snrBack: overrides.snrBack ?? null,
    timestamp: overrides.timestamp ?? now,
    createdAt: overrides.createdAt ?? now,
  };
  await databaseService.traceroutes.insertTraceroute(row, sourceId);
}

async function createProfile(overrides: {
  id: string;
  showTraceroutes?: boolean;
  channels?: number[];
  showMqttNodes?: boolean;
  sourceId: string | null;
}) {
  await databaseService.embedProfiles.createAsync({
    id: overrides.id,
    name: overrides.id,
    enabled: true,
    channels: overrides.channels ?? [],
    tileset: 'osm',
    defaultLat: 0,
    defaultLng: 0,
    defaultZoom: 10,
    showTooltips: true,
    showPopups: true,
    showLegend: true,
    showPaths: true,
    showNeighborInfo: false,
    showTraceroutes: overrides.showTraceroutes ?? true,
    showMqttNodes: overrides.showMqttNodes ?? true,
    pollIntervalSeconds: 30,
    allowedOrigins: [],
    sourceId: overrides.sourceId,
  });
}

describe('GET /api/embed/:profileId/traceroutes', () => {
  let app: Express;

  beforeAll(() => {
    app = createApp();
  });

  it('returns a bare JSON array, not the {success,data} envelope', async () => {
    const profileId = 'p-bare-array';
    const sourceId = nextSourceId();
    const a = nextNodeNum();
    const b = nextNodeNum();
    await seedNode(sourceId, { nodeNum: a });
    await seedNode(sourceId, { nodeNum: b, lat: 40.01, lng: -70.01 });
    await seedTraceroute(sourceId, { fromNodeNum: a, toNodeNum: b, snrTowards: '[20]' });
    await createProfile({ id: profileId, sourceId });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).not.toHaveProperty('success');
    expect(res.body).not.toHaveProperty('data');
  });

  it('preserves every legacy field and adds the additive fields', async () => {
    const profileId = 'p-legacy-and-additive';
    const sourceId = nextSourceId();
    const a = nextNodeNum();
    const b = nextNodeNum();
    await seedNode(sourceId, { nodeNum: a, lat: 41.0, lng: -71.0, name: 'Alpha' });
    await seedNode(sourceId, { nodeNum: b, lat: 41.01, lng: -71.01, name: 'Bravo' });
    await seedTraceroute(sourceId, { fromNodeNum: a, toNodeNum: b, snrTowards: '[20]' });
    await createProfile({ id: profileId, sourceId });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const seg = res.body[0];

    // Legacy fields (backward-compat contract — old cached clients read these)
    expect(seg).toMatchObject({
      fromNum: a,
      toNum: b,
      fromLat: 41.0,
      fromLng: -71.0,
      fromName: 'Alpha',
      toLat: 41.01,
      toLng: -71.01,
      toName: 'Bravo',
    });
    expect(typeof seg.snr).toBe('number');
    expect(typeof seg.timestamp).toBe('number');

    // Additive fields (new — ignored by old clients)
    expect(seg).toHaveProperty('leg', 'forward');
    expect(seg).toHaveProperty('avgSnr');
    expect(seg).toHaveProperty('isMqtt', false);
  });

  it('scales legacy snr to match avgSnr (/4 correction — §2.3)', async () => {
    const profileId = 'p-snr-scaling';
    const sourceId = nextSourceId();
    const a = nextNodeNum();
    const b = nextNodeNum();
    await seedNode(sourceId, { nodeNum: a });
    await seedNode(sourceId, { nodeNum: b, lat: 40.01, lng: -70.01 });
    // Raw firmware int (dB x4) = 20 -> scaled avgSnr = 5
    await seedTraceroute(sourceId, { fromNodeNum: a, toNodeNum: b, snrTowards: '[20]' });
    await createProfile({ id: profileId, sourceId });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].avgSnr).toBe(5);
    expect(res.body[0].snr).toBe(5);
    expect(res.body[0].snr).toBe(res.body[0].avgSnr);
  });

  it('yields both forward and return legs when route and routeBack/snrBack are populated (#2051)', async () => {
    const profileId = 'p-forward-return';
    const sourceId = nextSourceId();
    const a = nextNodeNum();
    const b = nextNodeNum();
    await seedNode(sourceId, { nodeNum: a });
    await seedNode(sourceId, { nodeNum: b, lat: 40.01, lng: -70.01 });
    await seedTraceroute(sourceId, {
      fromNodeNum: a,
      toNodeNum: b,
      route: '[]',
      snrTowards: '[20]',
      routeBack: '[]',
      snrBack: '[16]',
    });
    await createProfile({ id: profileId, sourceId });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(200);
    const legs = res.body.map((s: { leg: string }) => s.leg).sort();
    expect(legs).toEqual(['forward', 'return']);

    const forward = res.body.find((s: { leg: string }) => s.leg === 'forward');
    const back = res.body.find((s: { leg: string }) => s.leg === 'return');
    expect(forward).toMatchObject({ fromNum: a, toNum: b, avgSnr: 5 });
    expect(back).toMatchObject({ fromNum: b, toNum: a, avgSnr: 4 });
  });

  it('marks a sentinel-SNR hop as isMqtt with a null avgSnr (#2931)', async () => {
    const profileId = 'p-mqtt-sentinel';
    const sourceId = nextSourceId();
    const a = nextNodeNum();
    const b = nextNodeNum();
    await seedNode(sourceId, { nodeNum: a });
    await seedNode(sourceId, { nodeNum: b, lat: 40.01, lng: -70.01 });
    // Raw sentinel INT8_MIN = -128 -> scaled -32 (UNKNOWN_SNR_SENTINEL)
    await seedTraceroute(sourceId, { fromNodeNum: a, toNodeNum: b, snrTowards: '[-128]' });
    await createProfile({ id: profileId, sourceId });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ isMqtt: true, avgSnr: null, snr: null });
  });

  describe('leak boundary — hidden/filtered nodes never appear', () => {
    it('drops a segment whose endpoint has hideFromMap set (#3549)', async () => {
      const profileId = 'p-leak-hidefrommap';
      const sourceId = nextSourceId();
      const visible = nextNodeNum();
      const hidden = nextNodeNum();
      await seedNode(sourceId, { nodeNum: visible });
      await seedNode(sourceId, { nodeNum: hidden, lat: 40.01, lng: -70.01, hideFromMap: true });
      await seedTraceroute(sourceId, { fromNodeNum: visible, toNodeNum: hidden, snrTowards: '[20]' });
      await createProfile({ id: profileId, sourceId });

      const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('drops a segment whose endpoint is off the profile channel list', async () => {
      const profileId = 'p-leak-channel';
      const sourceId = nextSourceId();
      const inChannel = nextNodeNum();
      const offChannel = nextNodeNum();
      await seedNode(sourceId, { nodeNum: inChannel, channel: 0 });
      await seedNode(sourceId, { nodeNum: offChannel, lat: 40.01, lng: -70.01, channel: 5 });
      await seedTraceroute(sourceId, { fromNodeNum: inChannel, toNodeNum: offChannel, snrTowards: '[20]' });
      await createProfile({ id: profileId, sourceId, channels: [0] });

      const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('drops a segment whose endpoint is MQTT-bridged when showMqttNodes is off', async () => {
      const profileId = 'p-leak-mqtt';
      const sourceId = nextSourceId();
      const direct = nextNodeNum();
      const viaMqtt = nextNodeNum();
      await seedNode(sourceId, { nodeNum: direct });
      await seedNode(sourceId, { nodeNum: viaMqtt, lat: 40.01, lng: -70.01, viaMqtt: true });
      await seedTraceroute(sourceId, { fromNodeNum: direct, toNodeNum: viaMqtt, snrTowards: '[20]' });
      await createProfile({ id: profileId, sourceId, showMqttNodes: false });

      const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('drops a segment whose endpoint has no resolvable position', async () => {
      const profileId = 'p-leak-positionless';
      const sourceId = nextSourceId();
      const withPos = nextNodeNum();
      const noPos = nextNodeNum();
      await seedNode(sourceId, { nodeNum: withPos });
      await seedNode(sourceId, { nodeNum: noPos, lat: null, lng: null });
      await seedTraceroute(sourceId, { fromNodeNum: withPos, toNodeNum: noPos, snrTowards: '[20]' });
      await createProfile({ id: profileId, sourceId });

      const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });

    it('control: a fully-visible pair on the same setup DOES appear', async () => {
      const profileId = 'p-leak-control';
      const sourceId = nextSourceId();
      const a = nextNodeNum();
      const b = nextNodeNum();
      await seedNode(sourceId, { nodeNum: a, channel: 0 });
      await seedNode(sourceId, { nodeNum: b, lat: 40.01, lng: -70.01, channel: 0 });
      await seedTraceroute(sourceId, { fromNodeNum: a, toNodeNum: b, snrTowards: '[20]' });
      await createProfile({ id: profileId, sourceId, channels: [0] });

      const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });
  });

  it('404s when showTraceroutes is disabled for the profile', async () => {
    const profileId = 'p-gate-disabled';
    const sourceId = nextSourceId();
    await createProfile({ id: profileId, sourceId, showTraceroutes: false });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Traceroutes not enabled for this profile' });
  });

  it('404s for an unknown profile id', async () => {
    const res = await request(app).get('/api/embed/does-not-exist/traceroutes');
    expect(res.status).toBe(404);
  });

  it('spans all sources without throwing when the profile has no sourceId (ALL_SOURCES)', async () => {
    const profileId = 'p-cross-source';
    const sourceId = nextSourceId();
    const a = nextNodeNum();
    const b = nextNodeNum();
    await seedNode(sourceId, { nodeNum: a });
    await seedNode(sourceId, { nodeNum: b, lat: 40.01, lng: -70.01 });
    await seedTraceroute(sourceId, { fromNodeNum: a, toNodeNum: b, snrTowards: '[20]' });
    await createProfile({ id: profileId, sourceId: null });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it('caps the response at 500 segments', async () => {
    const profileId = 'p-cap-500';
    const sourceId = nextSourceId();
    // 24 nodes -> 24*23 = 552 unique ordered pairs, well over the 500 cap,
    // each traceroute (no intermediate hops) yields exactly one forward
    // segment on a distinct key so none collapse via dedup.
    const nodeCount = 24;
    const nums: number[] = [];
    for (let i = 0; i < nodeCount; i++) {
      const n = nextNodeNum();
      nums.push(n);
      await seedNode(sourceId, { nodeNum: n, lat: 42 + i * 0.001, lng: -72 + i * 0.001 });
    }

    const pairs: Array<[number, number]> = [];
    for (const from of nums) {
      for (const to of nums) {
        if (from === to) continue;
        pairs.push([from, to]);
        if (pairs.length >= 501) break;
      }
      if (pairs.length >= 501) break;
    }
    expect(pairs.length).toBeGreaterThanOrEqual(501);

    let ts = Date.now();
    for (const [from, to] of pairs) {
      await seedTraceroute(sourceId, { fromNodeNum: from, toNodeNum: to, snrTowards: '[20]', timestamp: ts, createdAt: ts });
      ts -= 1;
    }
    await createProfile({ id: profileId, sourceId });

    const res = await request(app).get(`/api/embed/${profileId}/traceroutes`);

    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(500);
  }, 30000);
});
