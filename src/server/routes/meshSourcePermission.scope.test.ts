/**
 * Per-source permission scoping for the routes that act on ONE Meshtastic
 * source and are gated by a per-source permission other than `configuration`:
 * mesh requests, announcements, connection controls, channel refresh and the
 * airtime status. Sibling of `deviceSourcePermission.scope.test.ts`.
 *
 * Each route is driven through the real auth middleware with real permission
 * rows:
 *
 *   - a user granted the permission on source A only is refused for source B
 *     and allowed for source A;
 *   - a request with no sourceId is authorised against the primary source;
 *   - a read grant does not pass a write route;
 *   - an anonymous caller is refused; an admin is allowed everywhere.
 *
 * The guard block at the end enumerates the routers' registered routes and
 * fails when a per-source permission is gated without a source, or when a
 * scoped route has no row in the table here.
 *
 * Managers are fakes. Nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';

import meshRequestRoutes from './meshRequestRoutes.js';
import announceRoutes from './announceRoutes.js';
import connectionRoutes from './connectionRoutes.js';
import channelRoutes from './channelRoutes.js';
import statusRoutes from './statusRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { getPermissionGate } from '../auth/authMiddleware.js';
import { getDeviceSourceGate } from '../utils/deviceSourcePermission.js';
import { isSourceyResource, type ResourceType } from '../../types/permission.js';

type Agent = Awaited<ReturnType<RouteTestHarness['loginAs']>>;
type Action = 'read' | 'write';

/** Every manager method a route under test calls. */
const DEVICE_METHODS = [
  'sendTraceroute',
  'sendPositionRequest',
  'sendNodeInfoRequest',
  'sendNeighborInfoRequest',
  'sendTelemetryRequest',
  'sendAutoAnnouncement',
  'previewAnnouncementMessage',
  'userDisconnect',
  'userReconnect',
  'refreshNodeDatabase',
  'getAirtimeCutoffStatus',
  'getLocalNodeInfo',
  'setChannelConfig',
  'beginEditSettings',
  'commitEditSettings',
  // MeshCore's own lifecycle method. The Meshtastic connection routes must
  // never reach it.
  'disconnect',
] as const;

type FakeManager = ISourceManager & Record<(typeof DEVICE_METHODS)[number], Mock> & { localNodeNum: number };

// Each fake gets its own node number and packet ids. The neighbor-info route
// keeps a module-level per-destination cooldown, so a reused destination would
// 429 the second test that reaches the handler.
let nextNodeNum = 0x10000000;
let nextPacketId = 1;

function fakeManager(sourceId: string, sourceType = 'meshtastic_tcp'): FakeManager {
  const localNodeNum = nextNodeNum++;
  const sent = () => {
    const packetId = nextPacketId++;
    return Promise.resolve({ packetId, requestId: packetId });
  };
  const methods = Object.fromEntries(DEVICE_METHODS.map((name) => [name, vi.fn().mockResolvedValue(undefined)]));
  return {
    sourceId,
    sourceType,
    localNodeNum,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
    ...methods,
    sendPositionRequest: vi.fn(sent),
    sendNodeInfoRequest: vi.fn(sent),
    sendNeighborInfoRequest: vi.fn(sent),
    sendTelemetryRequest: vi.fn(sent),
    previewAnnouncementMessage: vi.fn().mockResolvedValue(`preview from ${sourceId}`),
    userReconnect: vi.fn().mockResolvedValue(true),
    getAirtimeCutoffStatus: vi.fn().mockResolvedValue({ active: false, source: sourceId }),
    getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: localNodeNum, nodeId: `!${localNodeNum.toString(16)}` }),
  } as unknown as FakeManager;
}

type RouterName = 'mesh' | 'announce' | 'connection' | 'channels' | 'status';

interface RouteCase {
  router: RouterName;
  method: 'get' | 'post';
  /** Path as registered on the router (the guard matches on it). */
  route: string;
  resource: ResourceType;
  action: Action;
  from: 'query' | 'body';
  /** Payload sent besides sourceId. `target` is the manager the request names
   *  (the primary when it names none). */
  payload?: (target: FakeManager) => Record<string, unknown>;
  /** Manager method the handler calls on the target, if it gets that far. */
  device?: (typeof DEVICE_METHODS)[number];
  /**
   * `device`: `requireDeviceSourcePermission()`, the source must have a live
   * Meshtastic device. `stored`: `requirePermission()` tied to the same source
   * (named, else primary); the route reads stored data and needs no device.
   */
  gate: 'device' | 'stored';
  /** Extra proof the handler ran against the source. `named` is false when the
   *  request named no source. */
  reached?: (body: Record<string, unknown>, target: FakeManager, named: boolean) => void;
}

const MOUNT: Record<RouterName, string> = {
  mesh: '',
  announce: '/announce',
  connection: '/connection',
  channels: '/channels',
  status: '',
};

const ROUTERS: Record<RouterName, Router> = {
  mesh: meshRequestRoutes,
  announce: announceRoutes,
  connection: connectionRoutes,
  channels: channelRoutes,
  status: statusRoutes,
};

const BROADCAST = 0xffffffff;
const SOME_NODE = 0x0a0b0c0d;
const LAST_ANNOUNCE: Record<string, number> = { 'rt-source-a': 111, 'rt-source-b': 222 };
const LAST_ANNOUNCE_GLOBAL = 333;

const CASES: RouteCase[] = [
  // An explicit channel keeps the handler off the channel lookup; the send
  // method is the last thing it does before answering.
  { router: 'mesh', method: 'post', route: '/traceroute', resource: 'traceroute', action: 'write', from: 'body', gate: 'device', payload: () => ({ destination: SOME_NODE, channel: 0 }), device: 'sendTraceroute' },
  { router: 'mesh', method: 'post', route: '/position/request', resource: 'messages', action: 'write', from: 'body', gate: 'device', payload: () => ({ destination: BROADCAST, channel: 1 }), device: 'sendPositionRequest' },
  { router: 'mesh', method: 'post', route: '/nodeinfo/request', resource: 'messages', action: 'write', from: 'body', gate: 'device', payload: () => ({ destination: SOME_NODE, channel: 1 }), device: 'sendNodeInfoRequest' },
  // Only the source's own node (or a 0-hop one) is eligible, so ask for it.
  { router: 'mesh', method: 'post', route: '/neighborinfo/request', resource: 'traceroute', action: 'write', from: 'body', gate: 'device', payload: (target) => ({ destination: target.localNodeNum }), device: 'sendNeighborInfoRequest' },
  { router: 'mesh', method: 'post', route: '/telemetry/request', resource: 'messages', action: 'write', from: 'body', gate: 'device', payload: () => ({ destination: SOME_NODE, telemetryType: 'device' }), device: 'sendTelemetryRequest' },
  { router: 'announce', method: 'post', route: '/send', resource: 'automation', action: 'write', from: 'body', gate: 'device', device: 'sendAutoAnnouncement' },
  {
    router: 'announce', method: 'get', route: '/last', resource: 'automation', action: 'read', from: 'query', gate: 'stored',
    reached: (body, target, named) =>
      expect(body.lastAnnouncementTime).toBe(named ? LAST_ANNOUNCE[target.sourceId] : LAST_ANNOUNCE_GLOBAL),
  },
  {
    router: 'announce', method: 'get', route: '/preview', resource: 'automation', action: 'read', from: 'query', gate: 'device',
    payload: () => ({ message: 'hello' }), device: 'previewAnnouncementMessage',
    reached: (body, target) => expect(body.preview).toBe(`preview from ${target.sourceId}`),
  },
  { router: 'connection', method: 'post', route: '/disconnect', resource: 'connection', action: 'write', from: 'body', gate: 'device', device: 'userDisconnect' },
  { router: 'connection', method: 'post', route: '/reconnect', resource: 'connection', action: 'write', from: 'body', gate: 'device', device: 'userReconnect' },
  { router: 'channels', method: 'post', route: '/refresh', resource: 'messages', action: 'write', from: 'body', gate: 'device', device: 'refreshNodeDatabase' },
  {
    router: 'status', method: 'get', route: '/automation/airtime-status', resource: 'automation', action: 'read', from: 'query', gate: 'device',
    device: 'getAirtimeCutoffStatus',
    reached: (body, target) => expect(body.source).toBe(target.sourceId),
  },
];

const label = (c: RouteCase): string => `${c.method.toUpperCase()} ${MOUNT[c.router]}${c.route}`;

describe('single-source routes: permission is checked on the target source', () => {
  let harness: RouteTestHarness;
  let managerA: FakeManager;
  let managerB: FakeManager;
  const MQTT_SOURCE = 'rt-source-mqtt';
  const MESHCORE_SOURCE = 'rt-source-meshcore';

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/', meshRequestRoutes);
        app.use('/announce', announceRoutes);
        app.use('/connection', connectionRoutes);
        app.use('/channels', channelRoutes);
        app.use('/', statusRoutes);
      },
    });
    // A is registered first, so it is the primary Meshtastic source.
    managerA = fakeManager(harness.sourceA);
    managerB = fakeManager(harness.sourceB);
    await sourceManagerRegistry.addManager(managerA);
    await sourceManagerRegistry.addManager(managerB);
    await databaseService.settings.setSourceSetting(harness.sourceA, 'lastAnnouncementTime', String(LAST_ANNOUNCE[harness.sourceA]));
    await databaseService.settings.setSourceSetting(harness.sourceB, 'lastAnnouncementTime', String(LAST_ANNOUNCE[harness.sourceB]));
    await databaseService.settings.setSetting('lastAnnouncementTime', String(LAST_ANNOUNCE_GLOBAL));
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB, MQTT_SOURCE, MESHCORE_SOURCE]) {
      await sourceManagerRegistry.removeManager(id);
    }
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  /** Send the case's request naming `sourceId` (or no source when undefined). */
  const send = (agent: Agent, c: RouteCase, sourceId?: string) => {
    const target = sourceId === harness.sourceB ? managerB : managerA;
    const url = `${MOUNT[c.router]}${c.route}`;
    const fields = { ...(c.payload?.(target) ?? {}), ...(sourceId ? { sourceId } : {}) };
    return c.method === 'get' ? agent.get(url).query(fields) : agent.post(url).send(fields);
  };

  const deviceCalls = (manager: FakeManager): number =>
    DEVICE_METHODS.reduce((sum, name) => sum + manager[name].mock.calls.length, 0);

  /** The gate let the request through and the handler ran against `manager`. */
  const expectReached = (
    c: RouteCase,
    res: { status: number; body: Record<string, unknown> },
    manager: FakeManager,
    other: FakeManager,
    named = true,
  ) => {
    expect(res.status).toBe(200);
    if (c.device) expect(manager[c.device]).toHaveBeenCalledTimes(1);
    c.reached?.(res.body, manager, named);
    expect(deviceCalls(other)).toBe(0);
  };

  /** The gate refused: nothing reached either device. */
  const expectUntouched = () => {
    expect(deviceCalls(managerA)).toBe(0);
    expect(deviceCalls(managerB)).toBe(0);
  };

  describe.each(CASES.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    it('403s for source B when the grant is on source A only', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c, harness.sourceB);
      expect(res.status).toBe(403);
      expectUntouched();
    });

    it('is allowed for source A with the grant on source A', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c, harness.sourceA);
      expectReached(c, res, managerA, managerB);
    });

    it('is allowed for source B with the grant on source B', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c, harness.sourceB);
      expectReached(c, res, managerB, managerA);
    });

    if (c.action === 'write') {
      it(`403s with only ${c.resource}:read on the source`, async () => {
        await harness.grant(harness.limited.id, c.resource, 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c, harness.sourceA);
        expect(res.status).toBe(403);
        expectUntouched();
      });
    }

    it('with no sourceId, is allowed with the grant on the primary source and acts on it', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c);
      expectReached(c, res, managerA, managerB, false);
    });

    it('with no sourceId, 403s when the grant is on a non-primary source', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c);
      expect(res.status).toBe(403);
      expectUntouched();
    });

    it('with no sourceId, an admin acts on the primary source', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await send(agent, c);
      expectReached(c, res, managerA, managerB, false);
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await send(agent, c, harness.sourceA);
      expect([401, 403]).toContain(res.status);
      expectUntouched();
    });

    it('lets an admin act on either source without a grant', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await send(agent, c, harness.sourceB);
      expectReached(c, res, managerB, managerA);
    });

    it('400s when sourceId is not a string', async () => {
      const agent = await harness.loginAs(harness.admin);
      const url = `${MOUNT[c.router]}${c.route}`;
      const res = c.method === 'get'
        ? await agent.get(`${url}?sourceId=${harness.sourceA}&sourceId=${harness.sourceB}`)
        : await agent.post(url).send({ ...(c.payload?.(managerA) ?? {}), sourceId: [harness.sourceB] });
      expect(res.status).toBe(400);
      expectUntouched();
    });

    if (c.gate === 'device') {
      it('404s for a sourceId that names no source, instead of acting on the primary', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await send(agent, c, 'no-such-source');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('SOURCE_NOT_FOUND');
        expectUntouched();
      });

      it('403s, not 400s, for a source with no Meshtastic device the caller has no grant on', async () => {
        await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c, MQTT_SOURCE);
        expect(res.status).toBe(403);
        expectUntouched();
      });

      it('400s SOURCE_NOT_MESHTASTIC for a permitted source with no Meshtastic device', async () => {
        await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
        await harness.grant(harness.limited.id, c.resource, c.action, MQTT_SOURCE);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c, MQTT_SOURCE);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
        expectUntouched();
      });

      it('409s SOURCE_NOT_CONNECTED for a permitted source whose device is offline', async () => {
        await sourceManagerRegistry.removeManager(harness.sourceB);
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceB);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c, harness.sourceB);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
        expectUntouched();
      });

      it(`400s SOURCE_ID_CONFLICT when sourceId is sent outside the request ${c.from}`, async () => {
        const agent = await harness.loginAs(harness.admin);
        const url = `${MOUNT[c.router]}${c.route}`;
        const fields = c.payload?.(managerA) ?? {};
        const res = c.method === 'get'
          ? await agent.get(url).query(fields).send({ sourceId: harness.sourceB })
          : await agent.post(`${url}?sourceId=${harness.sourceB}`).send(fields);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SOURCE_ID_CONFLICT');
        expectUntouched();
      });
    }
  });

  describe('GET /announce/last reads stored data, so it needs no live device', () => {
    it('answers for a permitted source whose device is offline', async () => {
      await sourceManagerRegistry.removeManager(harness.sourceB);
      await harness.grant(harness.limited.id, 'automation', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/announce/last').query({ sourceId: harness.sourceB });
      expect(res.status).toBe(200);
      expect(res.body.lastAnnouncementTime).toBe(LAST_ANNOUNCE[harness.sourceB]);
    });
  });

  describe('POST /announce/send stamps the last-announcement time where it did before', () => {
    const read = (sourceId: string | null) => databaseService.settings.getSettingForSource(sourceId, 'lastAnnouncementTime');

    it('stamps the named source and leaves the others alone', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/announce/send').send({ sourceId: harness.sourceB });
      expect(res.status).toBe(200);
      expect(Number(await read(harness.sourceB))).toBeGreaterThan(LAST_ANNOUNCE[harness.sourceB]);
      expect(await read(harness.sourceA)).toBe(String(LAST_ANNOUNCE[harness.sourceA]));
      expect(await read(null)).toBe(String(LAST_ANNOUNCE_GLOBAL));
    });

    it('stamps the global key when no source is named', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/announce/send').send({});
      expect(res.status).toBe(200);
      expect(Number(await read(null))).toBeGreaterThan(LAST_ANNOUNCE_GLOBAL);
      expect(await read(harness.sourceA)).toBe(String(LAST_ANNOUNCE[harness.sourceA]));
    });

    it('stamps nothing when the caller is refused', async () => {
      await harness.grant(harness.limited.id, 'automation', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/announce/send').send({ sourceId: harness.sourceB });
      expect(res.status).toBe(403);
      expect(await read(harness.sourceB)).toBe(String(LAST_ANNOUNCE[harness.sourceB]));
    });
  });

  describe('POST /channels/refresh counts the target source only', () => {
    const seed = (id: number, sourceId: string) =>
      databaseService.channels.upsertChannel({ id, name: `ch${id}`, psk: 'AQ==', role: id === 0 ? 1 : 2 }, sourceId);

    it('returns the channel count of the source it refreshed', async () => {
      await seed(0, harness.sourceA);
      await seed(0, harness.sourceB);
      await seed(1, harness.sourceB);
      const agent = await harness.loginAs(harness.admin);
      expect((await agent.post('/channels/refresh').send({ sourceId: harness.sourceB })).body.channelCount).toBe(2);
      // No source named: the primary (A), not every source.
      expect((await agent.post('/channels/refresh').send({})).body.channelCount).toBe(1);
    });
  });

  describe('POST /neighborinfo/request keeps its per-destination cooldown behind the gate', () => {
    const ask = (agent: Agent) =>
      agent.post('/neighborinfo/request').send({ destination: managerB.localNodeNum, sourceId: harness.sourceB });

    it('a refused request does not start the cooldown for a permitted caller', async () => {
      await harness.grant(harness.limited.id, 'traceroute', 'write', harness.sourceA);
      const refused = await ask(await harness.loginAs(harness.limited));
      expect(refused.status).toBe(403);
      expectUntouched();

      const admin = await harness.loginAs(harness.admin);
      expect((await ask(admin)).status).toBe(200);
      // The cooldown itself is unchanged: the second send inside 180 s is a 429.
      const again = await ask(admin);
      expect(again.status).toBe(429);
      expect(again.body.retryAfter).toBeGreaterThan(0);
      expect(managerB.sendNeighborInfoRequest).toHaveBeenCalledTimes(1);
    });
  });

  describe('MeshCore sources', () => {
    // MeshCore connects and disconnects through /api/sources/:id/(dis)connect.
    // These Meshtastic routes refused a MeshCore sourceId before this change
    // and still do; they never act on the primary radio in its place.
    const connectionCases = CASES.filter((c) => c.router === 'connection');

    it.each(connectionCases.map((c) => [label(c), c] as const))('%s 400s for a permitted MeshCore source and touches no manager', async (_name, c) => {
      const meshcore = fakeManager(MESHCORE_SOURCE, 'meshcore');
      await sourceManagerRegistry.addManager(meshcore);
      await harness.grant(harness.limited.id, 'connection', 'write', MESHCORE_SOURCE);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c, MESHCORE_SOURCE);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(deviceCalls(meshcore)).toBe(0);
      expectUntouched();
    });

    it.each(connectionCases.map((c) => [label(c), c] as const))('%s 403s for a MeshCore source the caller has no grant on', async (_name, c) => {
      const meshcore = fakeManager(MESHCORE_SOURCE, 'meshcore');
      await sourceManagerRegistry.addManager(meshcore);
      await harness.grant(harness.limited.id, 'connection', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c, MESHCORE_SOURCE);
      expect(res.status).toBe(403);
      expect(deviceCalls(meshcore)).toBe(0);
      expectUntouched();
    });
  });

  describe('a Bearer token follows the same per-source rule', () => {
    it('sends for the granted source and is refused for the other', async () => {
      await harness.grant(harness.limited.id, 'traceroute', 'write', harness.sourceA);
      const token = await harness.tokenFor(harness.limited);
      const agent = await harness.loginAs(null);
      const post = (sourceId: string) =>
        agent.post('/traceroute').set('Authorization', `Bearer ${token}`).send({ destination: SOME_NODE, channel: 0, sourceId });
      expect((await post(harness.sourceB)).status).toBe(403);
      expectUntouched();
      expect((await post(harness.sourceA)).status).toBe(200);
      expect(managerA.sendTraceroute).toHaveBeenCalledTimes(1);
      expect(deviceCalls(managerB)).toBe(0);
    });
  });

  // ── Per-channel checks made inside the channel handlers ───────────────────
  describe('channel routes: channel_N is checked on the source the request names', () => {
    const seed = (id: number, sourceId: string) =>
      databaseService.channels.upsertChannel({ id, name: `ch${id}`, psk: 'AQ==', role: id === 0 ? 1 : 2 }, sourceId);

    beforeEach(async () => {
      for (const sourceId of [harness.sourceA, harness.sourceB]) {
        await seed(0, sourceId);
        await seed(1, sourceId);
      }
    });

    interface ChannelCase {
      name: string;
      grants: Array<[ResourceType, Action]>;
      send: (agent: Agent, sourceId: string) => PromiseLike<{ status: number }>;
    }

    const channelCases: ChannelCase[] = [
      {
        name: 'GET /channels/:id/export',
        grants: [['channel_1', 'read']],
        send: (agent, sourceId) => agent.get('/channels/1/export').query({ sourceId }),
      },
      {
        name: 'PUT /channels/:id',
        grants: [['channel_1', 'write']],
        send: (agent, sourceId) => agent.put('/channels/1').send({ sourceId, name: 'renamed', psk: 'AQ==' }),
      },
      {
        name: 'DELETE /channels/:id',
        grants: [['channel_1', 'write']],
        send: (agent, sourceId) => agent.delete('/channels/1').send({ sourceId }),
      },
      {
        name: 'POST /channels/:slotId/import',
        grants: [['channel_1', 'write']],
        send: (agent, sourceId) => agent.post('/channels/1/import').send({ sourceId, channel: { name: 'imported', psk: 'AQ==' } }),
      },
      {
        name: 'POST /channels/reorder',
        grants: [['channel_0', 'write'], ['channel_1', 'write']],
        send: (agent, sourceId) => agent.post('/channels/reorder').send({ sourceId, newOrder: [1, 0, 2, 3, 4, 5, 6, 7] }),
      },
    ];

    describe.each(channelCases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
      const grantOn = async (sourceId: string) => {
        for (const [resource, action] of c.grants) {
          await harness.grant(harness.limited.id, resource, action, sourceId);
        }
      };

      it('403s for source B when the grant is on source A only', async () => {
        await grantOn(harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await c.send(agent, harness.sourceB);
        expect(res.status).toBe(403);
        expectUntouched();
        expect((await databaseService.channels.getChannelById(1, harness.sourceB))?.name).toBe('ch1');
      });

      it('passes the permission check for source A and leaves source B alone', async () => {
        await grantOn(harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await c.send(agent, harness.sourceA);
        expect(res.status).not.toBe(403);
        expect(res.status).not.toBe(401);
        expect(deviceCalls(managerB)).toBe(0);
        expect((await databaseService.channels.getChannelById(1, harness.sourceB))?.name).toBe('ch1');
      });
    });

    const listed = async (agent: Agent, path: string, sourceId?: string): Promise<Array<{ id: number; psk?: string }>> => {
      const res = await agent.get(path).query(sourceId ? { sourceId } : {});
      expect(res.status).toBe(200);
      return res.body;
    };

    it.each(['/channels', '/channels/all'])('GET %s lists a channel only on the source the read grant is for', async (path) => {
      await harness.grant(harness.limited.id, 'channel_1', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await listed(agent, path, harness.sourceA)).map((ch) => ch.id)).toEqual([1]);
      expect(await listed(agent, path, harness.sourceB)).toEqual([]);
    });

    it('GET /channels/all with no sourceId lists only rows of sources the caller may read', async () => {
      await harness.grant(harness.limited.id, 'channel_1', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const rows = await listed(agent, '/channels/all');
      expect(rows.map((ch) => ch.id)).toEqual([1]);
    });

    it('GET /channels/all with no sourceId returns the key only for rows the caller may write', async () => {
      // One row per (user, resource, source): read and write on A in one row.
      await databaseService.auth.createPermission({
        userId: harness.limited.id, resource: 'channel_1', canRead: true, canWrite: true, canViewOnMap: false,
        sourceId: harness.sourceA, grantedAt: Date.now(), grantedBy: null,
      });
      await harness.grant(harness.limited.id, 'channel_1', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const rows = await listed(agent, '/channels/all');
      expect(rows).toHaveLength(2);
      expect(rows.filter((ch) => ch.psk !== undefined)).toHaveLength(1);
    });
  });
});

// ── Guard: no per-source permission may be gated without a source ────────────

interface RegisteredRoute {
  method: string;
  path: string;
  handlers: unknown[];
}

function registeredRoutes(router: Router): RegisteredRoute[] {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> } }> }).stack;
  return stack
    .filter((layer) => layer.route)
    .flatMap((layer) => {
      const route = layer.route!;
      return Object.keys(route.methods)
        .filter((m) => route.methods[m])
        .map((method) => ({ method, path: route.path, handlers: route.stack.map((l) => l.handle) }));
    });
}

const key = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

/** Routes that gate a per-source permission with no source to check it on. */
function unscoped(router: Router): string[] {
  return registeredRoutes(router)
    .filter((r) => r.handlers.some((h) => {
      const gate = getPermissionGate(h);
      return gate !== undefined && isSourceyResource(gate.resource) && !gate.sourceScoped;
    }))
    .map((r) => key(r.method, r.path))
    .sort();
}

/** Routes whose per-source permission is tied to a source. */
function scoped(router: Router): string[] {
  return registeredRoutes(router)
    .filter((r) => r.handlers.some((h) => getDeviceSourceGate(h) !== undefined || getPermissionGate(h)?.sourceScoped === true))
    .map((r) => key(r.method, r.path))
    .sort();
}

describe('guard: single-source routes are registered with a source-scoped gate', () => {
  const tableKeys = (router: RouterName): string[] =>
    CASES.filter((c) => c.router === router).map((c) => key(c.method, c.route)).sort();

  it.each(['mesh', 'announce', 'connection', 'status'] as const)('the %s router gates no per-source permission without a source', (name) => {
    // A new route here that checks a per-source permission must tie the check
    // to a source: requireDeviceSourcePermission(), or requirePermission()
    // with `sourceIdFrom`.
    expect(unscoped(ROUTERS[name])).toEqual([]);
    // ...and must get a row in CASES above, so its scoping is tested.
    expect(scoped(ROUTERS[name])).toEqual(tableKeys(name));
  });

  it('the channel router gates no per-source permission without a source, beyond decode-url', () => {
    // decode-url parses a URL the caller supplies. It touches no source.
    expect(unscoped(channelRoutes)).toEqual(['POST /decode-url']);
    for (const k of tableKeys('channels')) expect(scoped(channelRoutes)).toContain(k);
  });

  it('every route in the table is gated on the resource, action and place the table says', () => {
    for (const c of CASES) {
      const route = registeredRoutes(ROUTERS[c.router]).find((r) => key(r.method, r.path) === key(c.method, c.route));
      expect(route, label(c)).toBeDefined();
      if (c.gate === 'device') {
        const gate = route!.handlers.map((h) => getDeviceSourceGate(h)).find((g) => g !== undefined);
        expect(gate, label(c)).toEqual({ resource: c.resource, action: c.action, from: c.from });
      } else {
        const gate = route!.handlers.map((h) => getPermissionGate(h)).find((g) => g !== undefined);
        expect(gate, label(c)).toEqual({ resource: c.resource, action: c.action, sourceScoped: true });
      }
    }
  });

  it('every hasPermission() call in channelRoutes.ts names a source', () => {
    // The per-channel checks are made inside the handlers, where the route
    // enumeration above cannot see them. A call with three arguments checks a
    // per-source permission against any source.
    const source = readFileSync(fileURLToPath(new URL('./channelRoutes.ts', import.meta.url)), 'utf8');
    const calls = [...source.matchAll(/\bhasPermission\(([^()]*)\)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    const withoutSource = calls.filter((args) => args.split(',').length < 4);
    expect(withoutSource).toEqual([]);
  });
});
