/**
 * embedPublicRoutes — MeshCore neighbour edges and trace segments (#6263 P6 S8).
 *
 * Public route (profile-ID-as-token, no session): like its siblings it mounts
 * the router on a bare express app over the live `:memory:` singleton, because
 * `createRouteTestApp` only wires session/permission middleware, which this
 * route does not use.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import embedPublicRoutes from './embedPublicRoutes.js';
import databaseService from '../../services/database.js';

const createApp = (): Express => {
  const app = express();
  app.use(express.json());
  app.use('/api/embed', embedPublicRoutes);
  return app;
};

let seq = 0;
const next = () => (seq += 1);

async function makeSource(type = 'meshcore'): Promise<string> {
  const id = `mc-links-${type}-${next()}`;
  await databaseService.sources.createSource({ id, name: id, type: type as never, config: {} as never });
  return id;
}

function pubKey(): string {
  return (0xa0000 + next()).toString(16).padStart(8, '0').repeat(8);
}

async function seedNode(sourceId: string, opts: { lat?: number; lng?: number } = {}): Promise<string> {
  const publicKey = pubKey();
  await databaseService.meshcore.upsertNode({
    publicKey,
    name: `N ${publicKey.slice(0, 6)}`,
    advType: 2,
    latitude: opts.lat ?? 41.5,
    longitude: opts.lng ?? -71.5,
    lastHeard: Date.now(),
  }, sourceId);
  return publicKey;
}

async function createProfile(sourceId: string, flags: { neighbors?: boolean; traces?: boolean } = {}): Promise<string> {
  const id = `mc-links-profile-${next()}`;
  await databaseService.embedProfiles.createAsync({
    id, name: id, enabled: true, channels: [], tileset: 'osm',
    defaultLat: 0, defaultLng: 0, defaultZoom: 10,
    showTooltips: true, showPopups: true, showLegend: true, showPaths: true,
    showNeighborInfo: flags.neighbors ?? true,
    showTraceroutes: flags.traces ?? true,
    showMqttNodes: true, pollIntervalSeconds: 30, allowedOrigins: [], sourceId,
  });
  return id;
}

const mcId = (key: string) => `mc:${key.slice(0, 16)}`;

async function hop(sourceId: string, from: string, to: string, snrQuarterDb: number, timestamp: number, tag = next()) {
  await databaseService.meshcoreHopSnr.insertHops(sourceId, [{
    sourceId, traceTag: tag, authCode: 0, hopIndex: 0, hopCount: 1, hashBytes: 1,
    senderPublicKey: from, senderHash: null, senderCandidates: 1,
    receiverPublicKey: to, receiverHash: null, receiverCandidates: 1,
    snrQuarterDb, initiated: false, timestamp,
  }]);
}

describe('embed MeshCore links (P6 S8)', () => {
  let app: Express;
  beforeAll(() => { app = createApp(); });
  const get = async (profile: string, path: string) => request(app).get(`/api/embed/${profile}/${path}`);

  it('neighbour edge appears once per pair when both ends are visible', async () => {
    const src = await makeSource();
    const a = await seedNode(src);
    const b = await seedNode(src, { lat: 41.6 });
    await databaseService.meshcore.insertNeighborsBatch(src, a, [{ neighborPublicKey: b, snr: 7, lastHeardSecs: 5 }]);
    await databaseService.meshcore.insertNeighborsBatch(src, b, [{ neighborPublicKey: a, snr: 6, lastHeardSecs: 5 }]);
    const res = await get(await createProfile(src), 'neighborinfo');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    const e = res.body[0];
    expect(e.nodeNum).toBe(0);
    expect(e.neighborNodeNum).toBe(0);
    expect([e.nodeKey, e.neighborKey].sort()).toEqual([mcId(a), mcId(b)].sort());
    expect(e.nodeLatitude).toBeTypeOf('number');
  });

  it('neighbour edge with a private-override end is dropped', async () => {
    const src = await makeSource();
    const a = await seedNode(src);
    const priv = await seedNode(src);
    await databaseService.meshcore.setNodePositionOverride(src, priv, { enabled: true, latitude: 43, longitude: -73, isPrivate: true });
    await databaseService.meshcore.insertNeighborsBatch(src, a, [{ neighborPublicKey: priv, snr: 7, lastHeardSecs: 5 }]);
    const res = await get(await createProfile(src), 'neighborinfo');
    expect(res.body).toEqual([]);
  });

  it('neighbour edge to a node that is not shown (no position) is dropped', async () => {
    const src = await makeSource();
    const a = await seedNode(src);
    const unknown = pubKey();
    await databaseService.meshcore.insertNeighborsBatch(src, a, [{ neighborPublicKey: unknown, snr: 1, lastHeardSecs: 5 }]);
    const res = await get(await createProfile(src), 'neighborinfo');
    expect(res.body).toEqual([]);
  });

  it('toggles off give 404', async () => {
    const src = await makeSource();
    const p = await createProfile(src, { neighbors: false, traces: false });
    expect((await get(p, 'neighborinfo')).status).toBe(404);
    expect((await get(p, 'traceroutes')).status).toBe(404);
  });

  it('trace segments: two MeshCore segments do not collide, fields set', async () => {
    const src = await makeSource();
    const a = await seedNode(src);
    const b = await seedNode(src, { lat: 41.6 });
    const c = await seedNode(src, { lat: 41.7 });
    const now = Date.now();
    await hop(src, a, b, 24, now - 1000);
    await hop(src, b, c, -8, now - 2000);
    const res = await get(await createProfile(src), 'traceroutes');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    const ab = res.body.find((s: any) => s.fromKey === mcId(a));
    expect(ab).toMatchObject({ fromNum: 0, toNum: 0, toKey: mcId(b), leg: 'forward', isMqtt: false, snr: 6, avgSnr: 6 });
    const bc = res.body.find((s: any) => s.fromKey === mcId(b));
    expect(bc).toMatchObject({ toKey: mcId(c), avgSnr: -2 });
  });

  it('trace segment: private-override end, stale (>24h) and missing ends are dropped; dedup keeps newest', async () => {
    const src = await makeSource();
    const a = await seedNode(src);
    const b = await seedNode(src);
    const priv = await seedNode(src);
    await databaseService.meshcore.setNodePositionOverride(src, priv, { enabled: true, latitude: 43, longitude: -73, isPrivate: true });
    const now = Date.now();
    await hop(src, a, priv, 8, now - 1000);
    await hop(src, priv, a, 8, now - 1000);
    await hop(src, a, pubKey(), 8, now - 1000);
    await hop(src, b, a, 8, now - 25 * 3600 * 1000);
    await hop(src, a, b, 4, now - 5000);
    await hop(src, a, b, 40, now - 500);
    const res = await get(await createProfile(src), 'traceroutes');
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ fromKey: mcId(a), toKey: mcId(b), avgSnr: 10 });
  });

  it('shared cap holds at 500 segments', async () => {
    const src = await makeSource();
    const hub = await seedNode(src);
    const now = Date.now();
    const rows = [];
    for (let i = 0; i < 520; i++) {
      const k = await seedNode(src, { lat: 41 + i * 0.0001 });
      rows.push({
        sourceId: src, traceTag: 100000 + i, authCode: 0, hopIndex: 0, hopCount: 1, hashBytes: 1,
        senderPublicKey: hub, senderHash: null, senderCandidates: 1,
        receiverPublicKey: k, receiverHash: null, receiverCandidates: 1,
        snrQuarterDb: 4, initiated: false, timestamp: now - i,
      });
    }
    await databaseService.meshcoreHopSnr.insertHops(src, rows);
    const res = await get(await createProfile(src), 'traceroutes');
    expect(res.body).toHaveLength(500);
  }, 60000);
});
