/**
 * GET /api/sources/:id/meshcore/hop-candidates (#5909) against the real auth
 * middleware and the singleton's :memory: SQLite DB.
 *
 *   - toggle off ⇒ enabled:false, no candidates, for everyone (admins too)
 *   - nodes:read on the requesting source opens the route
 *   - names only from OTHER MeshCore sources the viewer can read
 *   - meshcore_mqtt nodes only with a verified advert signature
 *   - positions only with nodes:viewOnMap on the candidate's source; a
 *     private override needs nodes_private:read, else no position at all
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import hopCandidatesRoutes from './meshcoreHopCandidatesRoutes.js';

const OWN = 'rt-hop-own';
const OTHER = 'rt-hop-other';
const MQTT = 'rt-hop-mqtt';
const SECRET = 'rt-hop-secret';
const SETTING = 'meshcoreCrossSourceHopResolution';

const key = (prefix: string, fill: string) => prefix + fill.repeat(64 - prefix.length);

let harness: RouteTestHarness;

/** One permission row granting read AND viewOnMap (the harness grants one action per row). */
async function grantReadAndMap(userId: number, resource: string, sourceId: string): Promise<void> {
  await harness.db.auth.createPermission({
    userId, resource, canRead: true, canWrite: false, canViewOnMap: true,
    sourceId, grantedAt: Date.now(), grantedBy: null,
  });
}

async function seed(): Promise<void> {
  const db = harness.db;
  for (const [id, name, type] of [
    [OWN, 'Own Companion', 'meshcore'],
    [OTHER, 'Other Companion', 'meshcore'],
    [MQTT, 'DutchMeshcore', 'meshcore_mqtt'],
    [SECRET, 'Secret Source', 'meshcore'],
  ] as const) {
    await db.sources.deleteSource(id).catch(() => {});
    await db.sources.createSource({ id, name, type, config: {}, enabled: true });
  }
  await db.meshcore.deleteAllNodes();
  // OTHER: positioned repeater on 7f, plus a companion (advType 1) that must never match.
  await db.meshcore.upsertNode({ publicKey: key('7f', 'a'), name: 'Other Rpt', advType: 2, latitude: 52.1, longitude: 4.3 }, OTHER);
  await db.meshcore.upsertNode({ publicKey: key('7f', 'e'), name: 'Other Chat', advType: 1 }, OTHER);
  // MQTT: one verified, one unverified, one never checked — all on 7f.
  await db.meshcore.upsertNode({ publicKey: key('7f', 'b'), name: 'MQTT Verified', advType: 2, latitude: 51.9, longitude: 4.4, advertSignatureVerified: true }, MQTT);
  await db.meshcore.upsertNode({ publicKey: key('7f', 'c'), name: 'MQTT Forged', advType: 2, advertSignatureVerified: false }, MQTT);
  await db.meshcore.upsertNode({ publicKey: key('7f', 'd'), name: 'MQTT Unchecked', advType: 2 }, MQTT);
  // SECRET: a source the limited user cannot read.
  await db.meshcore.upsertNode({ publicKey: key('7f', '1'), name: 'Secret Rpt', advType: 2, latitude: 50, longitude: 5 }, SECRET);
  // OWN: must never be offered back to itself.
  await db.meshcore.upsertNode({ publicKey: key('7f', '2'), name: 'Own Rpt', advType: 2 }, OWN);
}

beforeEach(async () => {
  harness = await createRouteTestApp({
    mount: (app) => app.use('/api/sources/:id/meshcore', hopCandidatesRoutes),
  });
  await seed();
  await harness.db.settings.setSetting(SETTING, 'true');
});

afterEach(async () => {
  await harness.db.settings.setSetting(SETTING, 'false');
  await harness.db.meshcore.deleteAllNodes();
  for (const id of [OWN, OTHER, MQTT, SECRET]) await harness.db.sources.deleteSource(id).catch(() => {});
  await harness.cleanup();
});

const path = (prefixes = '7f') => `/api/sources/${OWN}/meshcore/hop-candidates?prefixes=${prefixes}`;

describe('GET /hop-candidates', () => {
  it('returns enabled:false and nothing when the toggle is off, even for an admin', async () => {
    await harness.db.settings.setSetting(SETTING, 'false');
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(path());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: { enabled: false, candidates: {} } });
  });

  it('refuses a viewer without nodes:read on the requesting source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', OTHER);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path());
    expect(res.status).toBe(403);
  });

  it('admin: every other source, only relays, only verified MQTT nodes, never the own source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(path());
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    const names = res.body.data.candidates['7f'].map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['MQTT Verified', 'Other Rpt', 'Secret Rpt']);
    const mqtt = res.body.data.candidates['7f'].find((c: { name: string }) => c.name === 'MQTT Verified');
    expect(mqtt).toMatchObject({ sourceId: MQTT, sourceName: 'DutchMeshcore', latitude: 51.9, longitude: 4.4 });
  });

  it('never leaks a name from a source the viewer cannot read', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', OWN);
    await harness.grant(harness.limited.id, 'nodes', 'read', OTHER);
    await harness.grant(harness.limited.id, 'nodes', 'read', MQTT);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path());
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Secret Rpt');
    expect(body).not.toContain(SECRET);
    const names = res.body.data.candidates['7f'].map((c: { name: string }) => c.name).sort();
    expect(names).toEqual(['MQTT Verified', 'Other Rpt']);
  });

  it('a viewer who can read only the own source gets nothing', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', OWN);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path());
    expect(res.body.data).toEqual({ enabled: true, candidates: {} });
  });

  it('strips positions without nodes:viewOnMap on the candidate source', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', OWN);
    await harness.grant(harness.limited.id, 'nodes', 'read', OTHER);
    await grantReadAndMap(harness.limited.id, 'nodes', MQTT);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path());
    const byName = Object.fromEntries(res.body.data.candidates['7f'].map((c: { name: string }) => [c.name, c]));
    expect(byName['Other Rpt'].latitude).toBeUndefined();
    expect(byName['Other Rpt'].longitude).toBeUndefined();
    expect(byName['MQTT Verified']).toMatchObject({ latitude: 51.9, longitude: 4.4 });
  });

  it('strips a private override position without nodes_private:read', async () => {
    await harness.db.meshcore.setNodePositionOverride(OTHER, key('7f', 'a'), {
      enabled: true, latitude: 53, longitude: 6, isPrivate: true,
    });
    await harness.grant(harness.limited.id, 'nodes', 'read', OWN);
    await grantReadAndMap(harness.limited.id, 'nodes', OTHER);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(path());
    const rpt = res.body.data.candidates['7f'].find((c: { name: string }) => c.name === 'Other Rpt');
    expect(rpt).toBeDefined();
    expect(rpt.latitude).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('53');

    // With nodes_private:read the override is the position shown.
    await harness.grant(harness.limited.id, 'nodes_private', 'read', OTHER);
    const res2 = await agent.get(path());
    const rpt2 = res2.body.data.candidates['7f'].find((c: { name: string }) => c.name === 'Other Rpt');
    expect(rpt2).toMatchObject({ latitude: 53, longitude: 6 });
  });

  it('answers only the requested, well-formed hashes', async () => {
    await harness.db.meshcore.upsertNode({ publicKey: key('7fa1', 'f'), name: 'Wide Rpt', advType: 3 }, OTHER);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(path('7fa1,zz,abc,0123456789'));
    expect(Object.keys(res.body.data.candidates)).toEqual(['7fa1']);
    expect(res.body.data.candidates['7fa1'].map((c: { name: string }) => c.name)).toEqual(['Wide Rpt']);
  });
});
