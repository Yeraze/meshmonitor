/**
 * embedPublicRoutes — MeshCore nodes on GET /:profileId/nodes (#5999).
 *
 * Public/anonymous route (profile-ID-as-token, no session), so this follows
 * embedPublicRoutes.test.ts: a bare express() app over the live singleton
 * `:memory:` SQLite `databaseService`, seeded directly. Every test makes its
 * own sources, so no test sees another's rows except the "All sources"
 * case, which checks membership rather than an exact list.
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

async function makeSource(type: string): Promise<string> {
  const id = `mc-embed-${type}-${next()}`;
  await databaseService.sources.createSource({ id, name: id, type: type as never, config: {} as never });
  return id;
}

/** A 64-hex public key unique to this test file. */
function pubKey(): string {
  return next().toString(16).padStart(8, '0').repeat(8);
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function seedMeshCore(sourceId: string, opts: {
  publicKey?: string;
  name?: string;
  lat?: number | null;
  lng?: number | null;
  lastHeard?: number | null;
  advType?: number;
} = {}): Promise<string> {
  const publicKey = opts.publicKey ?? pubKey();
  await databaseService.meshcore.upsertNode({
    publicKey,
    name: opts.name ?? `MC ${publicKey.slice(0, 6)}`,
    advType: opts.advType ?? 1,
    latitude: opts.lat === undefined ? 41.5 : opts.lat,
    longitude: opts.lng === undefined ? -71.5 : opts.lng,
    lastHeard: opts.lastHeard === undefined ? Date.now() : opts.lastHeard,
  }, sourceId);
  return publicKey;
}

async function seedMeshtastic(sourceId: string, opts: { channel?: number } = {}): Promise<number> {
  const nodeNum = 0x20000000 + next();
  await databaseService.nodes.upsertNode({
    nodeNum,
    nodeId: `!${nodeNum.toString(16)}`,
    longName: `MT ${nodeNum}`,
    shortName: 'MT',
    latitude: 40.0,
    longitude: -70.0,
    lastHeard: Math.floor(Date.now() / 1000),
    channel: opts.channel ?? 0,
  }, sourceId);
  return nodeNum;
}

async function createProfile(sourceId: string | null, opts: { channels?: number[]; showMqttNodes?: boolean } = {}): Promise<string> {
  const id = `mc-embed-profile-${next()}`;
  await databaseService.embedProfiles.createAsync({
    id,
    name: id,
    enabled: true,
    channels: opts.channels ?? [],
    tileset: 'osm',
    defaultLat: 0,
    defaultLng: 0,
    defaultZoom: 10,
    showTooltips: true,
    showPopups: true,
    showLegend: true,
    showPaths: true,
    showNeighborInfo: false,
    showTraceroutes: false,
    showMqttNodes: opts.showMqttNodes ?? true,
    pollIntervalSeconds: 30,
    allowedOrigins: [],
    sourceId,
  });
  return id;
}

const mcId = (key: string) => `mc:${key.slice(0, 16)}`;

describe('GET /api/embed/:profileId/nodes — MeshCore (#5999)', () => {
  let app: Express;
  beforeAll(() => { app = createApp(); });

  async function getNodes(profileId: string): Promise<any[]> {
    const res = await request(app).get(`/api/embed/${profileId}/nodes`);
    expect(res.status).toBe(200);
    return res.body;
  }

  it('a MeshCore-source profile returns that source\'s positioned MeshCore nodes, and no Meshtastic node from another source', async () => {
    const mc = await makeSource('meshcore');
    const mt = await makeSource('meshtastic_tcp');
    const key = await seedMeshCore(mc, { name: 'Hilltop Repeater', advType: 2, lat: 41.25, lng: -71.75 });
    const mtNum = await seedMeshtastic(mt);

    const body = await getNodes(await createProfile(mc));
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({
      nodeNum: 0,
      nodeId: mcId(key),
      isMeshCore: true,
      advType: 2,
      user: { longName: 'Hilltop Repeater', shortName: 'Hill' },
      position: { latitude: 41.25, longitude: -71.75 },
      hopsAway: 999,
      viaMqtt: false,
    });
    // MeshCore last-heard is milliseconds on disk; the wire is seconds.
    expect(body[0].lastHeard).toBeLessThan(1e12);
    expect(body[0].channel).toBeUndefined();
    expect(body.some((n: any) => n.nodeNum === mtNum)).toBe(false);
  });

  it('an All-sources profile returns both Meshtastic and MeshCore nodes', async () => {
    const mc = await makeSource('meshcore');
    const mt = await makeSource('meshtastic_tcp');
    const key = await seedMeshCore(mc);
    const mtNum = await seedMeshtastic(mt);

    const body = await getNodes(await createProfile(null));
    expect(body.some((n: any) => n.nodeNum === mtNum)).toBe(true);
    expect(body.some((n: any) => n.nodeId === mcId(key))).toBe(true);
  });

  it('a Meshtastic-source profile returns no MeshCore nodes', async () => {
    const mt = await makeSource('meshtastic_tcp');
    await seedMeshtastic(mt);
    const body = await getNodes(await createProfile(mt));
    expect(body.every((n: any) => !n.isMeshCore)).toBe(true);
  });

  it('leaves out a node with no position and a node not heard in 7 days', async () => {
    const mc = await makeSource('meshcore');
    const shown = await seedMeshCore(mc);
    const noPos = await seedMeshCore(mc, { lat: null, lng: null });
    const stale = await seedMeshCore(mc, { lastHeard: Date.now() - 8 * DAY_MS });
    const neverHeard = await seedMeshCore(mc, { lastHeard: null });

    const ids = (await getNodes(await createProfile(mc))).map((n: any) => n.nodeId);
    expect(ids).toContain(mcId(shown));
    expect(ids).not.toContain(mcId(noPos));
    expect(ids).not.toContain(mcId(stale));
    expect(ids).not.toContain(mcId(neverHeard));
  });

  it('draws a public location override, and leaves out a node whose override is private', async () => {
    const mc = await makeSource('meshcore');
    const pub = await seedMeshCore(mc, { lat: 41.5, lng: -71.5 });
    const priv = await seedMeshCore(mc, { lat: 41.5, lng: -71.5 });
    await databaseService.meshcore.setNodePositionOverride(mc, pub, { enabled: true, latitude: 42.125, longitude: -72.25, isPrivate: false });
    await databaseService.meshcore.setNodePositionOverride(mc, priv, { enabled: true, latitude: 43, longitude: -73, isPrivate: true });

    const body = await getNodes(await createProfile(mc));
    const pubRow = body.find((n: any) => n.nodeId === mcId(pub));
    expect(pubRow.position).toMatchObject({ latitude: 42.125, longitude: -72.25 });
    // Neither the private coordinates nor the advert fallback: the node is gone.
    expect(body.some((n: any) => n.nodeId === mcId(priv))).toBe(false);
  });

  it('a channel filter still filters Meshtastic nodes but never hides MeshCore nodes', async () => {
    const mc = await makeSource('meshcore');
    const mt = await makeSource('meshtastic_tcp');
    const key = await seedMeshCore(mc);
    const onCh0 = await seedMeshtastic(mt, { channel: 0 });
    const onCh3 = await seedMeshtastic(mt, { channel: 3 });

    const body = await getNodes(await createProfile(null, { channels: [3] }));
    expect(body.some((n: any) => n.nodeId === mcId(key))).toBe(true);
    expect(body.some((n: any) => n.nodeNum === onCh3)).toBe(true);
    expect(body.some((n: any) => n.nodeNum === onCh0)).toBe(false);
  });

  it('nodes from a MeshCore MQTT ingest source are MQTT nodes: shown flagged, or left out when the profile hides MQTT', async () => {
    const mq = await makeSource('meshcore_mqtt');
    const key = await seedMeshCore(mq);

    const shown = await getNodes(await createProfile(mq, { showMqttNodes: true }));
    expect(shown.find((n: any) => n.nodeId === mcId(key))).toMatchObject({ viaMqtt: true });

    const hidden = await getNodes(await createProfile(mq, { showMqttNodes: false }));
    expect(hidden.some((n: any) => n.nodeId === mcId(key))).toBe(false);
  });

  it('draws a node two MeshCore sources heard once, at the copy heard last', async () => {
    const a = await makeSource('meshcore');
    const b = await makeSource('meshcore');
    const key = pubKey();
    await seedMeshCore(a, { publicKey: key, lat: 41.1, lng: -71.1, lastHeard: Date.now() - 60_000 });
    await seedMeshCore(b, { publicKey: key, lat: 41.2, lng: -71.2, lastHeard: Date.now() });

    const rows = (await getNodes(await createProfile(null))).filter((n: any) => n.nodeId === mcId(key));
    expect(rows).toHaveLength(1);
    expect(rows[0].position).toMatchObject({ latitude: 41.2, longitude: -71.2 });
  });

  it('neighbor-info and traceroute routes stay Meshtastic-only: no MeshCore node becomes a line end', async () => {
    // visibleEmbedNodes (the link routes' node set) never reads meshcore_nodes;
    // a MeshCore-only profile with traceroutes on returns an empty list.
    const mc = await makeSource('meshcore');
    await seedMeshCore(mc);
    const id = await createProfile(mc);
    await databaseService.embedProfiles.updateAsync(id, { showTraceroutes: true });
    const res = await request(app).get(`/api/embed/${id}/traceroutes`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
