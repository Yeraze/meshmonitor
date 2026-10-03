/**
 * Coverage Report cross-source flags (#5560): `senderIsOwnSource` on
 * /receptions and /senders, and the `crossSourceOnly` filter.
 *
 * Real-middleware harness. The rule under test: a fix is flagged only when
 * the caller can read BOTH the receiving source and the sender's own source;
 * a caller limited to one source sees no flag and no trace of the other.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import coverageRoutes from './coverageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { localNodeNumSettingKey } from '../../db/repositories/settings.js';

const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;
const nowSec = (): number => Math.floor(Date.now() / 1000);

describe('Coverage routes — cross-source flags (#5560)', () => {
  let harness: RouteTestHarness;
  const NUM_A = 0x6a000001; // source A's own radio
  const NUM_B = 0x6b000002; // source B's own radio
  const THIRD = 0x6c000003;
  const GATEWAY = 0x6d000004;

  const seed = (overrides: Record<string, unknown> = {}) =>
    databaseService.coverageReceptions.recordReception({
      sourceId: harness.sourceB,
      protocol: 'meshtastic',
      receiverKind: 'local',
      receiverId: nodeIdFor(NUM_B),
      receiverNodeNum: NUM_B,
      receiverLatitude: 10,
      receiverLongitude: 20,
      senderId: nodeIdFor(NUM_A),
      senderNodeNum: NUM_A,
      packetKey: 'pkt',
      pathKey: 'r0:h0',
      latitude: 11,
      longitude: 21,
      transportMechanism: 1,
      receivedAt: Date.now(),
      ...overrides,
    } as Parameters<typeof databaseService.coverageReceptions.recordReception>[0]);

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', coverageRoutes) });
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceA), String(NUM_A));
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceB), String(NUM_B));

    for (const [num, name] of [[NUM_A, 'Radio A'], [NUM_B, 'Radio B'], [THIRD, 'Third'], [GATEWAY, 'Gateway']] as const) {
      await harness.db.nodes.upsertNode({
        nodeNum: num, nodeId: nodeIdFor(num), longName: name, shortName: 'N', channel: 0, lastHeard: nowSec(),
      } as any, harness.sourceB);
    }

    await seed({ packetKey: 'from-a' });
    await seed({ packetKey: 'from-third', senderId: nodeIdFor(THIRD), senderNodeNum: THIRD });
    await seed({
      packetKey: 'from-a-gw', receiverKind: 'mqtt_gateway', receiverId: nodeIdFor(GATEWAY), receiverNodeNum: GATEWAY,
      transportMechanism: 5,
    });
    // A reporting its own packet as a gateway: not a hearing.
    await seed({
      packetKey: 'from-a-self-gw', receiverKind: 'mqtt_gateway', receiverId: nodeIdFor(NUM_A), receiverNodeNum: NUM_A,
      transportMechanism: 5,
    });
  });

  afterEach(async () => {
    await databaseService.coverageReceptions.deleteForSource(harness.sourceA).catch(() => {});
    await databaseService.coverageReceptions.deleteForSource(harness.sourceB).catch(() => {});
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceA), '').catch(() => {});
    await harness.db.settings.setSetting(localNodeNumSettingKey(harness.sourceB), '').catch(() => {});
    await harness.cleanup();
  });

  const byKey = (items: any[], key: string) => items.find((r) => r.packetKey === key);

  it('admin: flags fixes from A heard by B, with transport', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/receptions');
    expect(res.status).toBe(200);
    const items = res.body.data.items;
    expect(byKey(items, 'from-a')).toMatchObject({
      senderIsOwnSource: true, senderSourceId: harness.sourceA, crossSourceTransport: 'rf',
    });
    expect(byKey(items, 'from-a-gw')).toMatchObject({
      senderIsOwnSource: true, senderSourceId: harness.sourceA, crossSourceTransport: 'mqtt_gateway',
    });
    expect(byKey(items, 'from-third')).toMatchObject({
      senderIsOwnSource: false, senderSourceId: null, crossSourceTransport: null,
    });
    expect(byKey(items, 'from-a-self-gw')).toMatchObject({ senderIsOwnSource: false, senderSourceId: null });
  });

  it('crossSourceOnly keeps only cross-source fixes', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/receptions?crossSourceOnly=true');
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((r: any) => r.packetKey).sort()).toEqual(['from-a', 'from-a-gw']);
  });

  it('rejects a malformed crossSourceOnly', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/receptions?crossSourceOnly=yes');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_CROSS_SOURCE');
  });

  it('/senders flags the sender that is our own source, with its name', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/senders');
    const senders = res.body.data.senders;
    const a = senders.find((s: any) => s.senderId === nodeIdFor(NUM_A));
    expect(a).toMatchObject({ senderIsOwnSource: true, ownSourceId: harness.sourceA, ownSourceName: expect.any(String) });
    const third = senders.find((s: any) => s.senderId === nodeIdFor(THIRD));
    expect(third).toMatchObject({ senderIsOwnSource: false, ownSourceId: null, ownSourceName: null });
  });

  it('a user who can read only B sees the rows but no flags, and no trace of A', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get('/receptions');
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(4);
    for (const item of res.body.data.items) {
      expect(item.senderIsOwnSource).toBe(false);
      expect(item.senderSourceId).toBeNull();
      expect(item.crossSourceTransport).toBeNull();
    }
    expect(JSON.stringify(res.body)).not.toContain(harness.sourceA);

    const only = await agent.get('/receptions?crossSourceOnly=true');
    expect(only.body.data.items).toEqual([]);

    const senders = await agent.get('/senders');
    for (const s of senders.body.data.senders) {
      expect(s.senderIsOwnSource).toBe(false);
      expect(s.ownSourceId).toBeNull();
    }
    expect(JSON.stringify(senders.body)).not.toContain(harness.sourceA);
  });

  it('a user who can read both A and B sees the flags', async () => {
    await harness.db.auth.createPermission({
      userId: harness.limited.id, resource: 'nodes', sourceId: harness.sourceA,
      canRead: true, canViewOnMap: true, grantedAt: Date.now(), grantedBy: null,
    });
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/receptions?crossSourceOnly=true');
    expect(res.body.data.items.map((r: any) => r.packetKey).sort()).toEqual(['from-a', 'from-a-gw']);
    expect(res.body.data.items[0].senderSourceId).toBe(harness.sourceA);
  });

  it('?sources=B still names readable source A', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/receptions?sources=${harness.sourceB}`);
    expect(byKey(res.body.data.items, 'from-a').senderSourceId).toBe(harness.sourceA);
  });
});
