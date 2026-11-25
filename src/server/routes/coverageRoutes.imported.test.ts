/**
 * Coverage Report read path for imported rows (#5891 P3, spec §2.5 / Q2).
 *
 * An imported row whose node resolves on its source keeps the per-node rules; one
 * unknown there is visible to admins and holders of the source's base map grant
 * (`channel_0:viewOnMap` on Meshtastic, `nodes:viewOnMap` on MeshCore). Imported
 * rows are never cross-source links.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import coverageImportRoutes from './coverageImportRoutes.js';
import coverageRoutes from './coverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { localNodeNumSettingKey } from '../../db/repositories/settings.js';
import { csvOf, mcDto, mtDto, nodeIdFor, uploadTo, MC_SENDER, MC_RECEIVER } from '../test-helpers/coverageImportFixtures.js';

const MC_SRC = 'rt-source-mc';
const HIDDEN = 0x71000001;
const KNOWN = 0x71000002;
const UNKNOWN = 0x71000003; // no node row on the target
const RECV_KNOWN = 0x72000001;
const RECV_UNKNOWN = 0x72000002;
const OWN_A = 0x73000001;
const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('coverage routes: imported rows (#5891 P3)', () => {
  let harness: RouteTestHarness;

  const perm = (
    userId: number,
    sourceId: string,
    resource: string,
    flags: { read?: boolean; viewOnMap?: boolean },
  ) =>
    harness.db.auth.createPermission({
      userId, resource, canRead: !!flags.read, canWrite: false, canViewOnMap: !!flags.viewOnMap,
      sourceId, grantedAt: Date.now(), grantedBy: null,
    });

  const node = (num: number, extra: Record<string, unknown> = {}) =>
    harness.db.nodes.upsertNode({
      nodeNum: num, nodeId: nodeIdFor(num), longName: `N${num.toString(16)}`, shortName: 'N',
      channel: 0, lastHeard: nowSec(), ...extra,
    } as any, harness.sourceA);

  const upload = async (items: ReturnType<typeof mtDto>[], target = harness.sourceA, name = 'f.csv') => {
    const admin = await harness.loginAs(harness.admin);
    const res = await uploadTo(admin, target, name, csvOf(items));
    expect(res.status).toBe(201);
    return res.body.data.import.id as string;
  };

  const senderIds = (body: any): string[] => body.data.items.map((r: any) => r.senderId).sort();

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/sources/:id/coverage/imports', coverageImportRoutes);
        app.use('/api/analysis/coverage', coverageRoutes);
      },
    });
    await harness.db.sources.deleteSource(MC_SRC).catch(() => {});
    await harness.db.sources.createSource({ id: MC_SRC, name: MC_SRC, type: 'meshcore', config: {}, enabled: true });
    await node(HIDDEN, { hideFromMap: true });
    await node(KNOWN);
    await node(RECV_KNOWN);
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB, MC_SRC]) {
      await databaseService.coverageImports.deleteForSource(id).catch(() => {});
      await databaseService.coverageReceptions.deleteForSource(id).catch(() => {});
    }
    await harness.db.nodes.deleteAllNodes(harness.sourceA).catch(() => {});
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceA), '').catch(() => {});
    await harness.revokeAll(harness.anonymous.id).catch(() => {});
    await harness.db.sources.deleteSource(MC_SRC).catch(() => {});
    await harness.cleanup();
  });

  const fixtures = () => [
    mtDto(0, { senderId: nodeIdFor(HIDDEN), senderNodeNum: HIDDEN }),
    mtDto(1, { senderId: nodeIdFor(KNOWN), senderNodeNum: KNOWN }),
    mtDto(2, { senderId: nodeIdFor(UNKNOWN), senderNodeNum: UNKNOWN }),
  ];
  const ids = { hidden: nodeIdFor(HIDDEN), known: nodeIdFor(KNOWN), unknown: nodeIdFor(UNKNOWN) };

  it('admin: a hidden resolved node stays hidden, an unknown node shows', async () => {
    await upload(fixtures());
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(senderIds(res.body)).toEqual([ids.known, ids.unknown].sort());
    expect(res.body.data.items.every((r: any) => r.importId)).toBe(true);
  });

  it('Meshtastic: channel_0:viewOnMap shows the unknown node, nodes:viewOnMap alone does not', async () => {
    await upload(fixtures());
    await perm(harness.limited.id, harness.sourceA, 'nodes', { read: true, viewOnMap: true });
    let agent = await harness.loginAs(harness.limited);
    let res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(res.status).toBe(200);
    // KNOWN is on channel 0, which this user cannot map; UNKNOWN needs channel_0 too.
    expect(senderIds(res.body)).toEqual([]);

    await perm(harness.limited.id, harness.sourceA, 'channel_0', { viewOnMap: true });
    agent = await harness.loginAs(harness.limited);
    res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(senderIds(res.body)).toEqual([ids.known, ids.unknown].sort()); // hidden node still gone
  });

  it('a reader without a map grant sees no imported points; neither does anonymous', async () => {
    await upload(fixtures());
    await perm(harness.limited.id, harness.sourceA, 'nodes', { read: true });
    await perm(harness.anonymous.id, harness.sourceA, 'nodes', { read: true });
    for (const user of [harness.limited, null]) {
      const agent = await harness.loginAs(user);
      const res = await agent.get('/api/analysis/coverage/receptions?since=0');
      expect(res.status).toBe(200);
      expect(res.body.data.items).toEqual([]);
    }
  });

  it('MeshCore: nodes:viewOnMap shows an unknown sender, plain read does not', async () => {
    await upload([mcDto(0), mcDto(1)], MC_SRC);
    await perm(harness.limited.id, MC_SRC, 'nodes', { read: true });
    let agent = await harness.loginAs(harness.limited);
    let res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(res.body.data.items).toEqual([]);

    await harness.revokeAll(harness.limited.id);
    await perm(harness.limited.id, MC_SRC, 'nodes', { read: true, viewOnMap: true });
    agent = await harness.loginAs(harness.limited);
    res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0].senderId).toBe(MC_SENDER);
  });

  it('MeshCore: a resolved node keeps the per-node gate', async () => {
    await upload([mcDto(0)], MC_SRC);
    await harness.db.meshcore.upsertNode(
      { publicKey: MC_SENDER, name: 'Known MC', advType: 1, latitude: 40, longitude: -100, lastHeard: Date.now() },
      MC_SRC,
    );
    await perm(harness.limited.id, MC_SRC, 'nodes', { read: true });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(res.body.data.items).toEqual([]); // resolved, no viewOnMap
  });

  it('a live row from a pruned (unknown) node is still dropped, even for admin', async () => {
    await databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceA, protocol: 'meshtastic', receiverKind: 'local', receiverId: nodeIdFor(RECV_KNOWN),
      receiverNodeNum: RECV_KNOWN, senderId: ids.unknown, senderNodeNum: UNKNOWN, packetKey: '5',
      pathKey: 'r0:h0', latitude: 1, longitude: 2, receivedAt: Date.now(),
    });
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(res.body.data.items).toEqual([]);
  });

  it('receiver coordinates are nulled by the same rule', async () => {
    // KNOWN sender on channel 1, mappable by this user; the receivers differ.
    await node(KNOWN, { channel: 1 });
    await upload([
      mtDto(0, { senderId: ids.known, senderNodeNum: KNOWN, receiverId: nodeIdFor(RECV_KNOWN), receiverNodeNum: RECV_KNOWN }),
      mtDto(1, { senderId: ids.known, senderNodeNum: KNOWN, receiverId: nodeIdFor(RECV_UNKNOWN), receiverNodeNum: RECV_UNKNOWN }),
    ]);
    await perm(harness.limited.id, harness.sourceA, 'nodes', { read: true });
    await perm(harness.limited.id, harness.sourceA, 'channel_1', { viewOnMap: true });
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(res.body.data.items).toHaveLength(2);
    for (const item of res.body.data.items) {
      // RECV_KNOWN sits on channel 0 (no grant) and RECV_UNKNOWN is unknown without the base grant.
      expect(item.receiverLatitude).toBeNull();
      expect(item.receiverLongitude).toBeNull();
    }
    const admin = await harness.loginAs(harness.admin);
    const adminRes = await admin.get('/api/analysis/coverage/receptions?since=0');
    const byRecv = Object.fromEntries(adminRes.body.data.items.map((r: any) => [r.receiverId, r]));
    expect(byRecv[nodeIdFor(RECV_UNKNOWN)].receiverLatitude).toBe(10.5); // unknown: admin sees it
    expect(byRecv[nodeIdFor(RECV_KNOWN)].receiverLatitude).toBe(10.5);
  });

  it('imported rows are never cross-source links', async () => {
    // A's own radio is OWN_A; a live row on B from it is a cross-source fix.
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceA), String(OWN_A));
    await harness.db.nodes.upsertNode({
      nodeNum: OWN_A, nodeId: nodeIdFor(OWN_A), longName: 'Own A', shortName: 'A', channel: 0, lastHeard: nowSec(),
    } as any, harness.sourceB);
    await databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceB, protocol: 'meshtastic', receiverKind: 'local', receiverId: '!00000009',
      receiverNodeNum: 9, senderId: nodeIdFor(OWN_A), senderNodeNum: OWN_A, packetKey: '8888',
      pathKey: 'r0:h0', latitude: 1, longitude: 2, receivedAt: Date.now(), transportMechanism: 1,
    });
    await upload([mtDto(0, { senderId: nodeIdFor(OWN_A), senderNodeNum: OWN_A })], harness.sourceB);

    const agent = await harness.loginAs(harness.admin);
    const all = await agent.get(`/api/analysis/coverage/receptions?since=0&sources=${harness.sourceB}`);
    const live = all.body.data.items.find((r: any) => !r.importId);
    const imported = all.body.data.items.find((r: any) => r.importId);
    expect(live.senderIsOwnSource).toBe(true);
    expect(imported).toMatchObject({ senderIsOwnSource: false, senderSourceId: null, crossSourceTransport: null });

    const only = await agent.get(`/api/analysis/coverage/receptions?since=0&crossSourceOnly=true&sources=${harness.sourceB}`);
    expect(only.body.data.items.map((r: any) => r.importId ?? null)).toEqual([null]);
  });

  it('imported / importId filters and their validation', async () => {
    const id1 = await upload([mtDto(0, { senderId: ids.known, senderNodeNum: KNOWN })], harness.sourceA, 'one.csv');
    await upload([mtDto(1, { senderId: ids.known, senderNodeNum: KNOWN })], harness.sourceA, 'two.csv');
    await databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceA, protocol: 'meshtastic', receiverKind: 'local', receiverId: nodeIdFor(RECV_KNOWN),
      receiverNodeNum: RECV_KNOWN, senderId: ids.known, senderNodeNum: KNOWN, packetKey: '3',
      pathKey: 'r0:h0', latitude: 1, longitude: 2, receivedAt: Date.now(),
    });
    const agent = await harness.loginAs(harness.admin);
    const get = async (q: string) => (await agent.get(`/api/analysis/coverage/receptions?since=0&${q}`)).body.data.items;
    expect(await get('imported=include')).toHaveLength(3);
    expect(await get('imported=exclude')).toHaveLength(1);
    expect(await get('imported=only')).toHaveLength(2);
    const one = await get(`imported=include&importId=${id1}`);
    expect(one).toHaveLength(1);
    expect(one[0].importId).toBe(id1);

    for (const path of ['receptions', 'senders', 'receivers']) {
      const bad = await agent.get(`/api/analysis/coverage/${path}?imported=maybe`);
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('INVALID_IMPORTED');
      const badId = await agent.get(`/api/analysis/coverage/${path}?importId=nope`);
      expect(badId.status).toBe(400);
      expect(badId.body.code).toBe('INVALID_IMPORT_ID');
    }
  });

  it('/senders and /receivers set importedOnly', async () => {
    // KNOWN: live + imported. UNKNOWN: imported only.
    await databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceA, protocol: 'meshtastic', receiverKind: 'local', receiverId: nodeIdFor(RECV_KNOWN),
      receiverNodeNum: RECV_KNOWN, senderId: ids.known, senderNodeNum: KNOWN, packetKey: '3',
      pathKey: 'r0:h0', latitude: 1, longitude: 2, receivedAt: Date.now(),
    });
    await upload([
      mtDto(0, { senderId: ids.known, senderNodeNum: KNOWN }),
      mtDto(1, { senderId: ids.unknown, senderNodeNum: UNKNOWN, receiverId: nodeIdFor(RECV_UNKNOWN), receiverNodeNum: RECV_UNKNOWN }),
    ]);
    const agent = await harness.loginAs(harness.admin);
    const senders = (await agent.get('/api/analysis/coverage/senders?since=0')).body.data.senders;
    expect(senders.find((s: any) => s.senderId === ids.known).importedOnly).toBe(false);
    expect(senders.find((s: any) => s.senderId === ids.unknown).importedOnly).toBe(true);

    const receivers = (await agent.get('/api/analysis/coverage/receivers?since=0')).body.data.receivers;
    expect(receivers.find((r: any) => r.receiverId === nodeIdFor(RECV_KNOWN)).importedOnly).toBe(false);
    const unk = receivers.find((r: any) => r.receiverId === nodeIdFor(RECV_UNKNOWN));
    expect(unk.importedOnly).toBe(true);
    expect(unk.latitude).toBe(10.5); // admin sees the unknown receiver's snapshot
  });

  it('/senders hides an unknown imported sender from a reader without the base grant', async () => {
    await upload(fixtures());
    await perm(harness.limited.id, harness.sourceA, 'nodes', { read: true });
    await perm(harness.limited.id, harness.sourceA, 'channel_0', { viewOnMap: true });
    let agent = await harness.loginAs(harness.limited);
    let senders = (await agent.get('/api/analysis/coverage/senders?since=0')).body.data.senders;
    expect(senders.map((s: any) => s.senderId).sort()).toEqual([ids.known, ids.unknown].sort());

    await harness.revokeAll(harness.limited.id);
    await perm(harness.limited.id, harness.sourceA, 'nodes', { read: true });
    agent = await harness.loginAs(harness.limited);
    senders = (await agent.get('/api/analysis/coverage/senders?since=0')).body.data.senders;
    expect(senders).toEqual([]);
  });

  it('MeshCore unknown receiver ids are never confused with the sender gate', async () => {
    await upload([mcDto(0)], MC_SRC);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/api/analysis/coverage/receptions?since=0');
    expect(res.body.data.items[0]).toMatchObject({ receiverId: MC_RECEIVER, receiverLatitude: 10.5 });
  });
});
