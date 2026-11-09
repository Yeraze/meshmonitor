/**
 * GET /api/traceroutes/explorer with MeshCore sources (#6276 P14 WP2).
 *
 * Real-middleware harness. MeshCore sources (`meshcore`, `meshcore_mqtt`) are
 * created per test; the harness does not reset data, so keys and ids are unique
 * to this file and afterEach removes what it seeded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import tracerouteRoutes from './tracerouteRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { nodeNumFromPubkey } from '../../utils/meshcoreNodeNum.js';
import type { MeshCoreHopSnrRow } from '../../db/repositories/meshcoreHopSnr.js';

const MC = 'rt-mc-explorer';
const MC_MQTT = 'rt-mc-explorer-mqtt';
const L = '61'.repeat(32);
const R1 = '62'.repeat(32);
const T = '63'.repeat(32);
const HOUR = 3_600_000;

describe('GET /api/traceroutes/explorer — MeshCore', () => {
  let harness: RouteTestHarness;

  const hop = (o: Partial<MeshCoreHopSnrRow>): MeshCoreHopSnrRow => ({
    sourceId: MC, traceTag: 1, authCode: 1, hopIndex: 0, hopCount: 4, hashBytes: 1,
    senderPublicKey: null, senderHash: null, senderCandidates: 0,
    receiverPublicKey: null, receiverHash: null, receiverCandidates: 0,
    snrQuarterDb: 0, initiated: true, timestamp: Date.now(), ...o,
  });

  /** Repeater round trip local -> R1 -> T -> R1 -> local. */
  const seedTrace = async (tag: number, ts: number, sourceId = MC, initiated = true) => {
    const b = { sourceId, traceTag: tag, hopCount: 4, timestamp: ts, initiated };
    await harness.db.meshcoreHopSnr.insertHops(sourceId, [
      hop({ ...b, hopIndex: 0, senderPublicKey: L, receiverPublicKey: R1, receiverHash: '62', receiverCandidates: 1, snrQuarterDb: 20 }),
      hop({ ...b, hopIndex: 1, senderPublicKey: R1, senderHash: '62', senderCandidates: 1, receiverPublicKey: T, receiverHash: '63', receiverCandidates: 1, snrQuarterDb: 12 }),
      hop({ ...b, hopIndex: 2, senderPublicKey: T, senderHash: '63', senderCandidates: 1, receiverPublicKey: R1, receiverHash: '62', receiverCandidates: 1, snrQuarterDb: 8 }),
      hop({ ...b, hopIndex: 3, senderPublicKey: R1, senderHash: '62', senderCandidates: 1, receiverPublicKey: L, snrQuarterDb: -4 }),
    ]);
  };

  const seedNode = async (sourceId: string, publicKey: string, extra: Record<string, unknown> = {}) => {
    await harness.db.meshcore.upsertNode(
      { publicKey, name: `N-${publicKey.slice(0, 2)}`, advType: 2, latitude: 10, longitude: 20, lastHeard: Date.now(), ...extra } as never,
      sourceId,
    );
  };

  /** Replace the limited user's grants (one row per resource: harness.grant cannot combine actions). */
  const setGrants = async (list: Array<[string, { read?: boolean; viewOnMap?: boolean }]>, sourceId = MC) => {
    await harness.revokeAll(harness.limited.id);
    for (const [resource, a] of list) {
      await harness.db.auth.createPermission({
        userId: harness.limited.id, resource, canRead: !!a.read, canWrite: false, canViewOnMap: !!a.viewOnMap,
        sourceId, grantedAt: Date.now(), grantedBy: null,
      });
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/', tracerouteRoutes) });
    for (const [id, type] of [[MC, 'meshcore'], [MC_MQTT, 'meshcore_mqtt']] as const) {
      await harness.db.sources.deleteSource(id).catch(() => {});
      await harness.db.sources.createSource({ id, name: id, type, config: {}, enabled: true });
    }
    await seedNode(MC, L, { isLocalNode: true });
    await seedNode(MC, R1);
    await seedNode(MC, T);
  });

  afterEach(async () => {
    await harness.db.meshcoreHopSnr.deleteBySourceId(MC);
    await harness.db.meshcoreHopSnr.deleteBySourceId(MC_MQTT);
    await harness.db.sources.deleteSource(MC).catch(() => {});
    await harness.db.sources.deleteSource(MC_MQTT).catch(() => {});
    await harness.db.traceroutes.deleteAllTraceroutes(harness.sourceA);
    await harness.cleanup();
  });

  const mcRuns = (body: any) => (body.data.runs as any[]).filter(r => r.protocol === 'meshcore');

  it('admin gets initiated MeshCore runs with keys, split at the turnaround, and named nodes', async () => {
    await seedTrace(1, Date.now() - HOUR);
    await seedTrace(2, Date.now() - 2 * HOUR, MC, false); // overheard: left out
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/explorer');
    expect(res.status).toBe(200);
    const runs = mcRuns(res.body);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      sourceId: MC, protocol: 'meshcore', packetId: null, channel: null,
      fromKey: `mc:${L}`, toKey: `mc:${T}`, turnaroundKey: `mc:${T}`, reachedTarget: true,
      routeKeys: [`mc:${L}`, `mc:${R1}`, `mc:${T}`],
      routeBackKeys: [`mc:${T}`, `mc:${R1}`, `mc:${L}`],
      fromNodeNum: nodeNumFromPubkey(L), toNodeNum: nodeNumFromPubkey(T),
      route: JSON.stringify([nodeNumFromPubkey(R1)]),
      snrTowards: '[20,12]', snrBack: '[8,-4]',
    });
    const t = res.body.data.nodes.find((n: any) => n.nodeKey === `mc:${T}`);
    expect(t).toMatchObject({ protocol: 'meshcore', publicKey: T, longName: `N-63`, latitude: 10, longitude: 20, nodeId: `mc:${T}` });
    expect(res.body.data.meshcoreRetentionDays).toBe(90);
    expect(res.body.data.truncated).toBe(false);
  });

  it('mixed sources: runs sort newest first across protocols; Meshtastic gains only protocol', async () => {
    await seedTrace(1, Date.now() - 3 * HOUR);
    const ts = Date.now() - HOUR;
    await harness.db.traceroutes.insertTraceroute({
      fromNodeNum: 0x61000001, toNodeNum: 0x61000002, fromNodeId: '!61000001', toNodeId: '!61000002',
      route: '[]', routeBack: null, snrTowards: null, snrBack: null, channel: 0, packetId: 7, timestamp: ts, createdAt: ts,
    }, harness.sourceA);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/explorer');
    const ours = (res.body.data.runs as any[]).filter(r => r.sourceId === MC || r.packetId === 7);
    expect(ours.map(r => r.protocol)).toEqual(['meshtastic', 'meshcore']);
    // A reply with no pending row is stored responder-first and served requester-first.
    expect(ours[0]).toMatchObject({ protocol: 'meshtastic', fromNodeNum: 0x61000002, toNodeNum: 0x61000001, route: '[]' });
    expect('fromKey' in ours[0]).toBe(false);
    const mt = res.body.data.nodes.find((n: any) => n.nodeNum === 0x61000001);
    expect(mt).toMatchObject({ nodeKey: `mt:${0x61000001}`, protocol: 'meshtastic' });
  });

  it('ignores a meshcore_mqtt source and honours the sources filter', async () => {
    await seedTrace(1, Date.now() - HOUR, MC_MQTT);
    await seedTrace(2, Date.now() - HOUR);
    const agent = await harness.loginAs(harness.admin);
    const all = await agent.get('/explorer');
    expect(mcRuns(all.body).map(r => r.sourceId)).toEqual([MC]);
    const other = await agent.get(`/explorer?sources=${harness.sourceA}`);
    expect(mcRuns(other.body)).toHaveLength(0);
  });

  it('respects the hours window', async () => {
    await seedTrace(1, Date.now() - 5 * HOUR);
    const agent = await harness.loginAs(harness.admin);
    expect(mcRuns((await agent.get('/explorer?hours=1')).body)).toHaveLength(0);
    expect(mcRuns((await agent.get('/explorer?hours=6')).body)).toHaveLength(1);
  });

  it('traceroute:read without nodes:read shows runs but no names or positions', async () => {
    await harness.grant(harness.limited.id, 'traceroute', 'read', MC);
    await seedTrace(1, Date.now() - HOUR);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/explorer');
    expect(mcRuns(res.body)).toHaveLength(1);
    const t = res.body.data.nodes.find((n: any) => n.nodeKey === `mc:${T}`);
    expect(t).toMatchObject({ longName: null, latitude: null, longitude: null });
  });

  it('nodes:read without viewOnMap gives names but no positions; with it, positions', async () => {
    await setGrants([['traceroute', { read: true }], ['nodes', { read: true }]]);
    await seedTrace(1, Date.now() - HOUR);
    let agent = await harness.loginAs(harness.limited);
    let t = (await agent.get('/explorer')).body.data.nodes.find((n: any) => n.nodeKey === `mc:${T}`);
    expect(t).toMatchObject({ longName: 'N-63', latitude: null, longitude: null });
    await setGrants([['traceroute', { read: true }], ['nodes', { read: true, viewOnMap: true }]]);
    agent = await harness.loginAs(harness.limited);
    t = (await agent.get('/explorer')).body.data.nodes.find((n: any) => n.nodeKey === `mc:${T}`);
    expect(t).toMatchObject({ latitude: 10, longitude: 20 });
  });

  it('a private override needs nodes_private:read; without it the real position shows, never the override', async () => {
    await harness.db.meshcore.setNodePositionOverride(MC, T, { enabled: true, latitude: 55, longitude: 66, isPrivate: true });
    await setGrants([['traceroute', { read: true }], ['nodes', { read: true, viewOnMap: true }]]);
    await seedTrace(1, Date.now() - HOUR);
    const agent = await harness.loginAs(harness.limited);
    const lim = (await agent.get('/explorer')).body.data.nodes.find((n: any) => n.nodeKey === `mc:${T}`);
    // A private override hides the position from a viewer without nodes_private.
    expect(lim.latitude).toBeNull();
    const adm = await harness.loginAs(harness.admin);
    const a = (await adm.get('/explorer')).body.data.nodes.find((n: any) => n.nodeKey === `mc:${T}`);
    expect(a).toMatchObject({ latitude: 55, longitude: 66 });
  });

  it('an unpermitted MeshCore source is absent; anonymous gets nothing', async () => {
    await seedTrace(1, Date.now() - HOUR);
    await harness.grant(harness.limited.id, 'traceroute', 'read', harness.sourceA);
    const lim = await (await harness.loginAs(harness.limited)).get('/explorer');
    expect(mcRuns(lim.body)).toHaveLength(0);
    expect((lim.body.data.sources as any[]).some(s => s.id === MC)).toBe(false);
    const anon = await (await harness.loginAs(null)).get('/explorer');
    expect(mcRuns(anon.body)).toHaveLength(0);
  });
});
