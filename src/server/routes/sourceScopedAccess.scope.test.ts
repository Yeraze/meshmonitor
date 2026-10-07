/**
 * Per-source permission scoping for the nodes, ignored-nodes, settings and
 * message routes that take an optional `sourceId`.
 *
 * Every route gated by `requireSourcePermission()` has a row in CASES and is
 * driven through the real auth middleware with real permission rows:
 *
 *   - a grant on source A only, a request naming B: 403 and nothing happens;
 *   - the same request naming A is allowed and acts on A only;
 *   - no sourceId: the route's rule (primary / permitted / first-permitted /
 *     required), with source B's data and devices untouched for a user who
 *     holds the permission on A only;
 *   - anonymous is refused; an admin is allowed.
 *
 * The guard block at the end enumerates the four routers' registered routes
 * and fails when one is not classified, or when a per-source resource is
 * gated without a source.
 *
 * Managers are fakes. Nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Router } from 'express';

import nodesRoutes from './nodesRoutes.js';
import ignoredNodeRoutes from './ignoredNodeRoutes.js';
import settingsRoutes from './settingsRoutes.js';
import messageRoutes from './messageRoutes.js';
import databaseService from '../../services/database.js';
import { autoDeleteByDistanceService } from '../services/autoDeleteByDistanceService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { getPermissionGate, isAdminGate } from '../auth/authMiddleware.js';
import {
  getSourceScopedGate,
  getSourcePairGate,
  readNewestAcrossSources,
  type OmittedSourceRule,
} from '../utils/sourceScopedAccess.js';
import { isSourceyResource } from '../../types/permission.js';

type Agent = Awaited<ReturnType<RouteTestHarness['loginAs']>>;
type Action = 'read' | 'write';
type RouterName = 'nodes' | 'ignored' | 'settings' | 'messages';

const NODE_NUM = 0x11111111;
const NODE_ID = '!11111111';
const DM_PEER = '!22222222';
const UNSCOPED = 'UNSCOPED';

const MOUNT: Record<RouterName, string> = {
  nodes: '',
  ignored: '/ignored-nodes',
  settings: '/settings',
  messages: '/messages',
};

const ROUTERS: Record<RouterName, Router> = {
  nodes: nodesRoutes,
  ignored: ignoredNodeRoutes,
  settings: settingsRoutes,
  messages: messageRoutes,
};

interface RouteCase {
  router: RouterName;
  method: 'get' | 'post' | 'delete';
  /** Path as registered on the router (the guard matches on it). */
  route: string;
  /** Path to request, when the registered one has a parameter. */
  path?: string;
  resource: 'nodes' | 'settings' | 'messages';
  action: Action;
  /** What the route does with no sourceId. */
  rule: OmittedSourceRule;
  /** True when the route drives a Meshtastic radio. */
  device?: boolean;
  /** Where this test sends sourceId on a non-GET request. */
  via?: 'query' | 'body';
  payload?: Record<string, unknown>;
  /** The request must leave a trace (a call or a row) for the source it acts on. */
  mustTouch?: boolean;
  /** An admin sees other sources' rows next to the named one (copy candidates). */
  adminSeesOthers?: boolean;
}

const CASES: RouteCase[] = [
  // ── nodesRoutes ──
  { router: 'nodes', method: 'post', route: '/nodes/:nodeId/send-key-warning', path: `/nodes/${NODE_ID}/send-key-warning`, resource: 'messages', action: 'write', rule: 'primary', device: true, mustTouch: true },
  { router: 'nodes', method: 'post', route: '/nodes/:nodeNum/scan-remote-admin', path: `/nodes/${NODE_NUM}/scan-remote-admin`, resource: 'settings', action: 'write', rule: 'primary', device: true, via: 'query', mustTouch: true },
  { router: 'nodes', method: 'post', route: '/auto-ping/stop/:nodeNum', path: `/auto-ping/stop/${NODE_NUM}`, resource: 'settings', action: 'write', rule: 'primary', device: true, mustTouch: true },
  { router: 'nodes', method: 'post', route: '/nodes/refresh', resource: 'nodes', action: 'write', rule: 'primary', device: true, mustTouch: true },
  { router: 'nodes', method: 'post', route: '/nodes/scan-duplicate-keys', resource: 'nodes', action: 'write', rule: 'permitted', mustTouch: true },
  { router: 'nodes', method: 'get', route: '/nodes/:nodeNum/copy-candidates', path: `/nodes/${NODE_NUM}/copy-candidates`, resource: 'nodes', action: 'read', rule: 'required', mustTouch: true, adminSeesOthers: true },
  { router: 'nodes', method: 'get', route: '/auto-favorite/status', resource: 'nodes', action: 'read', rule: 'primary', mustTouch: true },
  { router: 'nodes', method: 'get', route: '/nodes/:nodeNum/sources', path: `/nodes/${NODE_NUM}/sources`, resource: 'nodes', action: 'read', rule: 'permitted', mustTouch: true },
  { router: 'nodes', method: 'post', route: '/nodes/:nodeId/ignored', path: `/nodes/${NODE_ID}/ignored`, resource: 'nodes', action: 'write', rule: 'first-permitted', payload: { isIgnored: true, syncToDevice: false }, mustTouch: true },
  // ── ignoredNodeRoutes ──
  { router: 'ignored', method: 'get', route: '/', resource: 'nodes', action: 'read', rule: 'first-permitted', mustTouch: true },
  { router: 'ignored', method: 'delete', route: '/:nodeId', path: `/${NODE_ID}`, resource: 'nodes', action: 'write', rule: 'first-permitted', via: 'query', mustTouch: true },
  // ── settingsRoutes ──
  { router: 'settings', method: 'post', route: '/traceroute-interval', resource: 'settings', action: 'write', rule: 'primary', payload: { intervalMinutes: 5 }, mustTouch: true },
  { router: 'settings', method: 'post', route: '/remote-localstats-interval', resource: 'settings', action: 'write', rule: 'primary', payload: { intervalMinutes: 5 }, mustTouch: true },
  { router: 'settings', method: 'get', route: '/traceroute-nodes', resource: 'settings', action: 'read', rule: 'primary', mustTouch: true },
  { router: 'settings', method: 'post', route: '/traceroute-nodes', resource: 'settings', action: 'write', rule: 'primary', via: 'query', payload: { enabled: false, nodeNums: [] }, mustTouch: true },
  { router: 'settings', method: 'get', route: '/remote-localstats-nodes', resource: 'settings', action: 'read', rule: 'primary', mustTouch: true },
  { router: 'settings', method: 'post', route: '/remote-localstats-nodes', resource: 'settings', action: 'write', rule: 'required', via: 'query', payload: { enabled: false, nodeNums: [] }, mustTouch: true },
  { router: 'settings', method: 'get', route: '/time-sync-nodes', resource: 'settings', action: 'read', rule: 'primary', mustTouch: true },
  { router: 'settings', method: 'post', route: '/time-sync-nodes', resource: 'settings', action: 'write', rule: 'primary', via: 'query', payload: { enabled: false }, mustTouch: true },
  { router: 'settings', method: 'get', route: '/auto-ping', resource: 'settings', action: 'read', rule: 'primary', mustTouch: true },
  { router: 'settings', method: 'post', route: '/auto-ping', resource: 'settings', action: 'write', rule: 'primary', via: 'query', payload: { autoPingEnabled: true }, mustTouch: true },
  { router: 'settings', method: 'get', route: '/traceroute-log', resource: 'settings', action: 'read', rule: 'permitted', mustTouch: true },
  { router: 'settings', method: 'get', route: '/key-repair-log', resource: 'settings', action: 'read', rule: 'permitted', mustTouch: true },
  { router: 'settings', method: 'get', route: '/distance-delete/log', resource: 'settings', action: 'read', rule: 'permitted', mustTouch: true },
  { router: 'settings', method: 'post', route: '/distance-delete/run-now', resource: 'settings', action: 'write', rule: 'permitted', via: 'query', mustTouch: true },
  { router: 'settings', method: 'post', route: '/mark-all-welcomed', resource: 'settings', action: 'write', rule: 'permitted', via: 'query', mustTouch: true },
  // ── messageRoutes ──
  { router: 'messages', method: 'get', route: '/direct/:nodeId1/:nodeId2', path: `/direct/${NODE_ID}/${DM_PEER}`, resource: 'messages', action: 'read', rule: 'permitted', mustTouch: true },
];

const key = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;
const label = (c: RouteCase): string => `${c.method.toUpperCase()} ${MOUNT[c.router]}${c.route}`;

/** Device methods the routes under test call. Each records the manager's source. */
const DEVICE_METHODS = [
  'sendTextMessage',
  'scanNodeForRemoteAdmin',
  'stopAutoPingSession',
  'refreshNodeDatabase',
  'supportsFavorites',
  'setTracerouteInterval',
  'setRemoteLocalStatsInterval',
  'setTimeSyncInterval',
  'getAutoPingSessions',
  'sendRemoveNode',
  'broadcastNodeInfoUpdate',
  'sendNodeInfoRequest',
] as const;

type FakeManager = ISourceManager & Record<(typeof DEVICE_METHODS)[number], ReturnType<typeof vi.fn>>;

describe('nodes / ignored-nodes / settings / message routes: permission is checked on the target source', () => {
  let harness: RouteTestHarness;
  let managerA: FakeManager;
  let managerB: FakeManager;
  /** Every source a request acted on, as recorded by the fakes and spies. */
  let acted: string[];
  const MQTT_SOURCE = 'rt-source-mqtt';
  const MESHCORE_SOURCE = 'rt-source-meshcore';

  const fakeManager = (sourceId: string, sourceType = 'meshtastic_tcp'): FakeManager => {
    const returns: Partial<Record<(typeof DEVICE_METHODS)[number], unknown>> = {
      scanNodeForRemoteAdmin: { hasRemoteAdmin: false, metadata: null },
      supportsFavorites: true,
      getAutoPingSessions: [],
      sendTextMessage: 1234,
    };
    const methods = Object.fromEntries(
      DEVICE_METHODS.map((name) => [
        name,
        vi.fn(() => {
          acted.push(sourceId);
          const value = returns[name];
          return name === 'supportsFavorites' ? value : Promise.resolve(value);
        }),
      ]),
    );
    return {
      sourceId,
      sourceType,
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType, connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ nodeNum: 999, nodeId: '!000003e7', longName: 'local', shortName: 'L' }),
      getAllNodesAsync: vi.fn().mockResolvedValue([]),
      // Channel 0 and a DM per source, each naming the source it came from.
      getRecentMessages: vi.fn(async (_limit: number, id?: string) => [
        { id: `c-${id}`, channel: 0, text: `channel text on ${id ?? UNSCOPED}`, timestamp: new Date() },
        { id: `d-${id}`, channel: -1, text: `dm text on ${id ?? UNSCOPED}`, timestamp: new Date() },
      ]),
      startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
      stopDistanceDeleteScheduler: vi.fn(),
      ...methods,
    } as unknown as FakeManager;
  };

  /** Rows on `sourceId` that name it, so a response that includes them shows which source it read. */
  const seedSource = async (sourceId: string): Promise<void> => {
    await databaseService.nodes.upsertNode(
      { nodeNum: NODE_NUM, nodeId: NODE_ID, longName: `node on ${sourceId}`, shortName: 'N', hwModel: 43 },
      sourceId,
    );
    await databaseService.nodes.updateNodeSecurityFlags(NODE_NUM, true, 'duplicate', sourceId);
    await databaseService.ignoredNodes.addIgnoredNodeAsync(NODE_NUM, sourceId, NODE_ID, `ignored on ${sourceId}`, 'I', 'seed');
    await databaseService.logAutoTracerouteAttemptAsync(NODE_NUM, `traced on ${sourceId}`, sourceId);
    await databaseService.logKeyRepairAttemptAsync(NODE_NUM, `repaired on ${sourceId}`, 'exchange', true, null, null, sourceId);
    await databaseService.distanceDeleteLog.addDistanceDeleteLogEntry({
      timestamp: Date.now(),
      nodesDeleted: 1,
      thresholdKm: 100,
      details: JSON.stringify([{ nodeName: `deleted on ${sourceId}` }]),
      sourceId,
    });
    const now = Date.now();
    await databaseService.messages.insertMessage(
      {
        id: `${sourceId}_dm`, fromNodeNum: NODE_NUM, toNodeNum: 0x22222222, fromNodeId: NODE_ID, toNodeId: DM_PEER,
        text: `dm on ${sourceId}`, channel: -1, portnum: 1, timestamp: now, createdAt: now,
      } as never,
      sourceId,
    );
    await databaseService.messages.insertMessage(
      {
        id: `${sourceId}_ch`, fromNodeNum: NODE_NUM, toNodeNum: 0xffffffff, fromNodeId: NODE_ID, toNodeId: '!ffffffff',
        text: `channel on ${sourceId}`, channel: 0, portnum: 1, timestamp: now, createdAt: now,
      } as never,
      sourceId,
    );
  };

  /** Record which source a database write or read was made for. */
  const record = <T extends object>(
    target: T,
    method: keyof T & string,
    sourceArg: number,
    result?: unknown,
    callThrough = false,
  ): void => {
    const original = (target[method] as unknown as (...args: unknown[]) => unknown).bind(target);
    vi.spyOn(target as never, method as never).mockImplementation(((...args: unknown[]) => {
      const sourceId = args[sourceArg];
      acted.push(typeof sourceId === 'string' && sourceId.length > 0 ? sourceId : UNSCOPED);
      return callThrough ? original(...args) : Promise.resolve(result);
    }) as never);
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    acted = [];
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/', nodesRoutes);
        app.use('/ignored-nodes', ignoredNodeRoutes);
        app.use('/settings', settingsRoutes);
        app.use('/messages', messageRoutes);
      },
    });
    // A is registered first, so it is the primary Meshtastic source.
    managerA = fakeManager(harness.sourceA);
    managerB = fakeManager(harness.sourceB);
    await sourceManagerRegistry.addManager(managerA);
    await sourceManagerRegistry.addManager(managerB);
    await seedSource(harness.sourceA);
    await seedSource(harness.sourceB);

    // Writes are stubbed and recorded; reads run for real and are recorded.
    record(databaseService, 'setNodeIgnoredAsync', 2);
    record(databaseService.ignoredNodes, 'removeIgnoredNodeAsync', 1);
    record(databaseService.nodes, 'getNodesWithPublicKeys', 0, [], false);
    record(databaseService, 'getTracerouteFilterSettingsAsync', 0, undefined, true);
    record(databaseService, 'setTracerouteFilterSettingsAsync', 1);
    record(databaseService, 'getRemoteLocalStatsFilterSettingsAsync', 0, undefined, true);
    record(databaseService, 'setRemoteLocalStatsFilterSettingsAsync', 1);
    record(databaseService, 'getTimeSyncFilterSettingsAsync', 0, undefined, true);
    record(databaseService, 'setTimeSyncFilterSettingsAsync', 1);
    record(databaseService.settings, 'setSourceSetting', 0);
    record(databaseService.settings, 'setSetting', 99);
    record(databaseService, 'markAllNodesAsWelcomedAsync', 0, 1);
    record(autoDeleteByDistanceService, 'runNow', 0, { deletedCount: 1 });
    acted = [];
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB, MQTT_SOURCE, MESHCORE_SOURCE]) {
      await sourceManagerRegistry.removeManager(id);
    }
    await databaseService.sources.deleteSource(MQTT_SOURCE).catch(() => {});
    await databaseService.sources.deleteSource(MESHCORE_SOURCE).catch(() => {});
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  /** Send the case's request naming `sourceId` (or no source when undefined). */
  const send = (agent: Agent, c: RouteCase, sourceId?: string) => {
    const url = `${MOUNT[c.router]}${c.path ?? c.route}`;
    if (c.method === 'get') return agent.get(url).query(sourceId ? { sourceId } : {});
    const inQuery = c.via === 'query';
    const body = { ...(c.payload ?? {}), ...(sourceId && !inQuery ? { sourceId } : {}) };
    const req = c.method === 'delete' ? agent.delete(url) : agent.post(url);
    return req.query(sourceId && inQuery ? { sourceId } : {}).send(body);
  };

  /** The sources a request acted on or returned data from. */
  const touched = (body: unknown): string[] => {
    const text = JSON.stringify(body ?? {});
    const seen = new Set(acted);
    for (const id of [harness.sourceA, harness.sourceB]) {
      if (text.includes(id)) seen.add(id);
    }
    return [...seen].sort();
  };

  const expectRefused = (res: { status: number; body: unknown }, statuses: number[] = [403]) => {
    expect(statuses).toContain(res.status);
    expect(touched(res.body)).toEqual([]);
  };

  /** Allowed, and nothing but `sourceId` was acted on or shown. */
  const expectOnly = (c: RouteCase, res: { status: number; body: unknown }, sourceId: string) => {
    expect(res.status).toBe(200);
    const seen = touched(res.body);
    expect(seen.filter((id) => id !== sourceId)).toEqual([]);
    if (c.mustTouch) expect(seen).toContain(sourceId);
  };

  describe.each(CASES.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    it('403s for source B when the grant is on source A only, and does nothing', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expectRefused(await send(agent, c, harness.sourceB));
    });

    it('is allowed for source A with the grant on source A, and acts on A only', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expectOnly(c, await send(agent, c, harness.sourceA), harness.sourceA);
    });

    if (c.action === 'write') {
      it('403s with only the read permission on the source', async () => {
        await harness.grant(harness.limited.id, c.resource, 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        expectRefused(await send(agent, c, harness.sourceA));
      });
    }

    if (c.rule === 'required') {
      it('400s without a sourceId, whoever asks', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await send(agent, c);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MISSING_SOURCE_ID');
        expect(touched(res.body)).toEqual([]);
      });
    }

    if (c.rule === 'primary') {
      it('with no sourceId, acts on the primary source for a grant on it', async () => {
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        expectOnly(c, await send(agent, c), harness.sourceA);
      });

      it('with no sourceId, 403s when the grant is on a non-primary source', async () => {
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceB);
        const agent = await harness.loginAs(harness.limited);
        expectRefused(await send(agent, c));
      });

      it('with no sourceId, an admin acts on the primary source', async () => {
        const agent = await harness.loginAs(harness.admin);
        expectOnly(c, await send(agent, c), harness.sourceA);
      });
    }

    if (c.rule === 'permitted') {
      it('with no sourceId, a user holding it on A only reaches A and never B', async () => {
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        expectOnly(c, await send(agent, c), harness.sourceA);
      });

      it('with no sourceId, a user holding it on B only reaches B and never A', async () => {
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceB);
        const agent = await harness.loginAs(harness.limited);
        expectOnly(c, await send(agent, c), harness.sourceB);
      });

      it('with no sourceId, an admin still reaches every source', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await send(agent, c);
        expect(res.status).toBe(200);
        const seen = touched(res.body);
        // One unscoped call, or both sources by name.
        expect(seen.includes(UNSCOPED) || (seen.includes(harness.sourceA) && seen.includes(harness.sourceB))).toBe(true);
      });
    }

    if (c.rule === 'first-permitted') {
      it('with no sourceId, acts on the one source the caller holds the permission on', async () => {
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceB);
        const agent = await harness.loginAs(harness.limited);
        expectOnly(c, await send(agent, c), harness.sourceB);
      });
    }

    it('refuses a caller with no grant', async () => {
      const agent = await harness.loginAs(harness.limited);
      expectRefused(await send(agent, c, harness.sourceA));
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      expectRefused(await send(agent, c, harness.sourceA), [401, 403]);
    });

    it('lets an admin act on source B without a grant', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await send(agent, c, harness.sourceB);
      if (c.adminSeesOthers) {
        expect(res.status).toBe(200);
        expect(touched(res.body)).toContain(harness.sourceB);
      } else {
        expectOnly(c, res, harness.sourceB);
      }
    });

    it('404s for a sourceId that names no source, instead of falling back', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await send(agent, c, 'no-such-source');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SOURCE_NOT_FOUND');
      expect(touched(res.body)).toEqual([]);
    });

    it('403s, not 404s, for an unknown sourceId the caller has no grant on', async () => {
      await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expectRefused(await send(agent, c, 'no-such-source'));
    });

    if (c.method !== 'get') {
      it('400s when the query and the body name different sources', async () => {
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const url = `${MOUNT[c.router]}${c.path ?? c.route}`;
        const req = c.method === 'delete' ? agent.delete(url) : agent.post(url);
        const res = await req.query({ sourceId: harness.sourceA }).send({ ...(c.payload ?? {}), sourceId: harness.sourceB });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SOURCE_ID_CONFLICT');
        expect(touched({})).toEqual([]);
      });
    }

    if (c.device) {
      it('does not tell a caller without the grant that a source has no radio', async () => {
        await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
        await harness.grant(harness.limited.id, c.resource, c.action, harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        expectRefused(await send(agent, c, MQTT_SOURCE));
      });

      it('400s SOURCE_NOT_MESHTASTIC for a permitted source with no radio, and uses no other radio', async () => {
        await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
        await harness.grant(harness.limited.id, c.resource, c.action, MQTT_SOURCE);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c, MQTT_SOURCE);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
        expect(touched({})).toEqual([]);
      });
    }
  });

  describe('sources that are not Meshtastic devices', () => {
    const createSource = (id: string, type: string) =>
      databaseService.sources.createSource({ id, name: id, type, config: {}, enabled: true } as never);

    it('serves a MeshCore source its own ignore list, on a grant for that source', async () => {
      await createSource(MESHCORE_SOURCE, 'meshcore');
      await databaseService.ignoredNodes.addIgnoredNodeAsync(7, MESHCORE_SOURCE, '!00000007', 'ignored on meshcore', 'M', 'seed');
      await harness.grant(harness.limited.id, 'nodes', 'read', MESHCORE_SOURCE);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get('/ignored-nodes').query({ sourceId: MESHCORE_SOURCE });
      expect(res.status).toBe(200);
      expect(res.body.map((row: { longName: string }) => row.longName)).toEqual(['ignored on meshcore']);

      // The same grant does not open a Meshtastic source's list.
      expect((await agent.get('/ignored-nodes').query({ sourceId: harness.sourceA })).status).toBe(403);
    });

    it('lets a MeshCore source remove its own ignored node', async () => {
      await createSource(MESHCORE_SOURCE, 'meshcore');
      await harness.grant(harness.limited.id, 'nodes', 'write', MESHCORE_SOURCE);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.delete(`/ignored-nodes/${NODE_ID}`).query({ sourceId: MESHCORE_SOURCE });
      expect(res.status).toBe(200);
      expect(acted).toEqual([MESHCORE_SOURCE, MESHCORE_SOURCE]);
    });

    it('saves an MQTT source its own automation settings and re-arms no radio', async () => {
      await createSource(MQTT_SOURCE, 'mqtt_broker');
      await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
      await harness.grant(harness.limited.id, 'settings', 'write', MQTT_SOURCE);
      const agent = await harness.loginAs(harness.limited);

      const saved = await agent.post('/settings/time-sync-nodes').query({ sourceId: MQTT_SOURCE }).send({ enabled: true, intervalMinutes: 30 });
      expect(saved.status).toBe(200);
      const interval = await agent.post('/settings/traceroute-interval').send({ intervalMinutes: 5, sourceId: MQTT_SOURCE });
      expect(interval.status).toBe(200);

      // The settings were written for the MQTT source; no manager was re-armed.
      expect([...new Set(acted)]).toEqual([MQTT_SOURCE]);
      expect(managerA.setTimeSyncInterval).not.toHaveBeenCalled();
      expect(managerA.setTracerouteInterval).not.toHaveBeenCalled();
    });

    it('reports no auto-favorite support for an MQTT source instead of the primary radio\'s status', async () => {
      await createSource(MQTT_SOURCE, 'mqtt_broker');
      await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
      await harness.grant(harness.limited.id, 'nodes', 'read', MQTT_SOURCE);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get('/auto-favorite/status').query({ sourceId: MQTT_SOURCE });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ localNodeRole: null, firmwareVersion: null, supportsFavorites: false, autoFavoriteNodes: [] });
      expect(managerA.supportsFavorites).not.toHaveBeenCalled();
    });
  });

  describe('POST /nodes/:nodeNum/copy-nodeinfo: read on the source copied from, write on the source copied to', () => {
    const copy = (agent: Agent, from: string, to: string) =>
      agent.post(`/nodes/${NODE_NUM}/copy-nodeinfo`).send({ fromSourceId: from, toSourceId: to, fields: ['longName'] });
    const nameOn = async (sourceId: string) => (await databaseService.nodes.getNode(NODE_NUM, sourceId))?.longName;

    it.each([
      { from: true, to: true, status: 200 },
      { from: true, to: false, status: 403 },
      { from: false, to: true, status: 403 },
      { from: false, to: false, status: 403 },
    ])('read on from: $from, write on to: $to → $status', async ({ from, to, status }) => {
      if (from) await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      if (to) await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);

      const res = await copy(agent, harness.sourceA, harness.sourceB);

      expect(res.status).toBe(status);
      expect(await nameOn(harness.sourceB)).toBe(status === 200 ? `node on ${harness.sourceA}` : `node on ${harness.sourceB}`);
      expect(await nameOn(harness.sourceA)).toBe(`node on ${harness.sourceA}`);
    });

    it('403s with the two grants the wrong way round', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await copy(agent, harness.sourceA, harness.sourceB)).status).toBe(403);
      expect(await nameOn(harness.sourceB)).toBe(`node on ${harness.sourceB}`);
    });

    it('403s with write on both sources but read on neither', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await copy(agent, harness.sourceA, harness.sourceB)).status).toBe(403);
      expect(await nameOn(harness.sourceB)).toBe(`node on ${harness.sourceB}`);
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      expect([401, 403]).toContain((await copy(agent, harness.sourceA, harness.sourceB)).status);
      expect(await nameOn(harness.sourceB)).toBe(`node on ${harness.sourceB}`);
    });

    it('lets an admin copy between any two sources', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await copy(agent, harness.sourceB, harness.sourceA)).status).toBe(200);
      expect(await nameOn(harness.sourceA)).toBe(`node on ${harness.sourceB}`);
    });

    it('400s without both source ids and 404s for one that does not exist', async () => {
      const agent = await harness.loginAs(harness.admin);
      const missing = await agent.post(`/nodes/${NODE_NUM}/copy-nodeinfo`).send({ toSourceId: harness.sourceB });
      expect(missing.status).toBe(400);
      expect(missing.body.code).toBe('MISSING_SOURCE_ID');
      const unknown = await copy(agent, 'no-such-source', harness.sourceB);
      expect(unknown.status).toBe(404);
      expect(unknown.body.code).toBe('SOURCE_NOT_FOUND');
    });
  });

  describe('listing routes do not reveal a source the caller cannot read', () => {
    it('copy-candidates lists another source only when the caller holds nodes:read on it', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const url = `/nodes/${NODE_NUM}/copy-candidates`;

      const hidden = await agent.get(url).query({ sourceId: harness.sourceA });
      expect(hidden.status).toBe(200);
      expect(hidden.body.data.candidates).toEqual([]);
      expect(hidden.body.data.target.longName).toBe(`node on ${harness.sourceA}`);

      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      const shown = await agent.get(url).query({ sourceId: harness.sourceA });
      expect(shown.body.data.candidates.map((c: { sourceId: string }) => c.sourceId)).toEqual([harness.sourceB]);
    });

    it('/nodes/:nodeNum/sources lists only readable sources', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/nodes/${NODE_NUM}/sources`);
      expect(res.body.data.sources).toEqual([
        { sourceId: harness.sourceB, sourceName: 'Source B', nodeName: `node on ${harness.sourceB}` },
      ]);

      const admin = await harness.loginAs(harness.admin);
      const all = await admin.get(`/nodes/${NODE_NUM}/sources`);
      expect(all.body.data.sources.map((s: { sourceId: string }) => s.sourceId).sort()).toEqual([harness.sourceA, harness.sourceB]);
    });
  });

  describe('POST /nodes/:nodeId/hide-from-map with allSources', () => {
    const hidden = async (sourceId: string) => Boolean((await databaseService.nodes.getNode(NODE_NUM, sourceId))?.hideFromMap);
    const hide = (agent: Agent) =>
      agent.post(`/nodes/${NODE_ID}/hide-from-map`).send({ hideFromMap: true, sourceId: harness.sourceA, allSources: true });

    it('changes only the sources the caller holds nodes:write on', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await hide(agent)).status).toBe(200);
      expect(await hidden(harness.sourceA)).toBe(true);
      expect(await hidden(harness.sourceB)).toBe(false);
    });

    it('changes every source for an admin', async () => {
      const agent = await harness.loginAs(harness.admin);
      expect((await hide(agent)).status).toBe(200);
      expect(await hidden(harness.sourceA)).toBe(true);
      expect(await hidden(harness.sourceB)).toBe(true);
    });
  });

  describe('DELETE /settings', () => {
    const seedSettings = async () => {
      vi.restoreAllMocks();
      await databaseService.settings.setSetting('scopeTestGlobal', '1');
      await databaseService.settings.setSourceSetting(harness.sourceA, 'scopeTestKey', 'a');
      await databaseService.settings.setSourceSetting(harness.sourceB, 'scopeTestKey', 'b');
    };
    const valueOn = async (sourceId: string) => (await databaseService.settings.getSourceSettings(sourceId)).scopeTestKey;

    it('resets global settings and only the sources the caller may write', async () => {
      await seedSettings();
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      expect((await agent.delete('/settings')).status).toBe(200);

      expect(await databaseService.settings.getSetting('scopeTestGlobal')).toBeNull();
      expect(await valueOn(harness.sourceA)).toBeUndefined();
      expect(await valueOn(harness.sourceB)).toBe('b');
    });

    it('resets everything for an admin', async () => {
      await seedSettings();
      const agent = await harness.loginAs(harness.admin);
      expect((await agent.delete('/settings')).status).toBe(200);
      expect(await valueOn(harness.sourceA)).toBeUndefined();
      expect(await valueOn(harness.sourceB)).toBeUndefined();
    });
  });

  describe('POST /messages/send', () => {
    const sendMessage = (agent: Agent, body: Record<string, unknown>) =>
      agent.post('/messages/send').send({ text: 'hello', channel: 0, ...body });

    it('403s and sends nothing for source B on a channel grant for source A', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await sendMessage(agent, { sourceId: harness.sourceB });
      expect(res.status).toBe(403);
      expect(managerA.sendTextMessage).not.toHaveBeenCalled();
      expect(managerB.sendTextMessage).not.toHaveBeenCalled();
    });

    it('sends through source A on a grant for source A', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await sendMessage(agent, { sourceId: harness.sourceA })).status).toBe(200);
      expect(managerA.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(managerB.sendTextMessage).not.toHaveBeenCalled();
    });

    it('with no sourceId, checks the grant on the primary source it sends through', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      expect((await sendMessage(agent, {})).status).toBe(403);
      expect(managerA.sendTextMessage).not.toHaveBeenCalled();

      await harness.grant(harness.limited.id, 'channel_0', 'write', harness.sourceA);
      expect((await sendMessage(agent, {})).status).toBe(200);
      expect(managerA.sendTextMessage).toHaveBeenCalledTimes(1);
      expect(managerB.sendTextMessage).not.toHaveBeenCalled();
    });

    it('checks messages:write on the named source for a direct message', async () => {
      await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await sendMessage(agent, { destination: NODE_ID, sourceId: harness.sourceB })).status).toBe(403);
      expect(managerB.sendTextMessage).not.toHaveBeenCalled();
      expect((await sendMessage(agent, { destination: NODE_ID, sourceId: harness.sourceA })).status).toBe(200);
      expect(managerA.sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('404s for an unknown source instead of sending through the primary', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await sendMessage(agent, { sourceId: 'no-such-source' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SOURCE_NOT_FOUND');
      expect(managerA.sendTextMessage).not.toHaveBeenCalled();
    });

    it('400s when the query and the body name different sources', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/messages/send').query({ sourceId: harness.sourceA }).send({ text: 'x', sourceId: harness.sourceB });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_ID_CONFLICT');
      expect(managerA.sendTextMessage).not.toHaveBeenCalled();
      expect(managerB.sendTextMessage).not.toHaveBeenCalled();
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      expect([401, 403]).toContain((await sendMessage(agent, { sourceId: harness.sourceA })).status);
      expect(managerA.sendTextMessage).not.toHaveBeenCalled();
    });
  });

  describe('POST /messages/nodes/:nodeNum/purge-from-device', () => {
    const url = `/messages/nodes/${NODE_NUM}/purge-from-device`;

    beforeEach(() => {
      vi.spyOn(databaseService, 'deleteNodeAsync').mockResolvedValue({
        nodeDeleted: true, messagesDeleted: 0, traceroutesDeleted: 0, telemetryDeleted: 0,
      } as never);
    });

    it('removes the node from the radio of the source the permission was checked on, wherever sourceId is sent', async () => {
      await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);

      // In the query: the handler used to read the body only and use the primary.
      const res = await agent.post(url).query({ sourceId: harness.sourceB }).send({});

      expect(res.status).toBe(200);
      expect(managerB.sendRemoveNode).toHaveBeenCalledWith(NODE_NUM);
      expect(managerA.sendRemoveNode).not.toHaveBeenCalled();
      expect(databaseService.deleteNodeAsync).toHaveBeenCalledWith(NODE_NUM, harness.sourceB);
    });

    it('refuses a source with no radio instead of purging the primary radio', async () => {
      await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
      await harness.grant(harness.limited.id, 'messages', 'write', MQTT_SOURCE);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.post(url).send({ sourceId: MQTT_SOURCE });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expect(managerA.sendRemoveNode).not.toHaveBeenCalled();
      expect(databaseService.deleteNodeAsync).not.toHaveBeenCalled();
    });

    it('403s for source B on a grant for source A', async () => {
      await harness.grant(harness.limited.id, 'messages', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post(url).send({ sourceId: harness.sourceB })).status).toBe(403);
      expect(managerA.sendRemoveNode).not.toHaveBeenCalled();
      expect(managerB.sendRemoveNode).not.toHaveBeenCalled();
    });
  });

  describe('message reads with no sourceId', () => {
    it('GET /messages returns only the sources the caller may read, by kind', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get('/messages');

      expect(res.status).toBe(200);
      expect(res.body.map((m: { text: string }) => m.text).sort()).toEqual([
        `channel text on ${harness.sourceB}`,
        `dm text on ${harness.sourceA}`,
      ]);
    });

    it('GET /messages still reads every source in one query for an admin', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/messages');
      expect(res.body.map((m: { text: string }) => m.text).sort()).toEqual([
        `channel text on ${UNSCOPED}`,
        `dm text on ${UNSCOPED}`,
      ]);
    });

    it('GET /messages/channel/0 returns only the sources the caller holds channel_0:read on', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get('/messages/channel/0');

      expect(res.status).toBe(200);
      expect(res.body.messages.map((m: { text: string }) => m.text)).toEqual([`channel on ${harness.sourceA}`]);

      const admin = await harness.loginAs(harness.admin);
      const all = await admin.get('/messages/channel/0');
      expect(all.body.messages.map((m: { text: string }) => m.text).sort()).toEqual([
        `channel on ${harness.sourceA}`,
        `channel on ${harness.sourceB}`,
      ]);
    });

    it('GET /messages/direct returns the DMs of every permitted source, newest first, paged as one list', async () => {
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const url = `/messages/direct/${NODE_ID}/${DM_PEER}`;

      const both = await agent.get(url);
      expect(both.body.messages.map((m: { text: string }) => m.text).sort()).toEqual([
        `dm on ${harness.sourceA}`,
        `dm on ${harness.sourceB}`,
      ]);
      expect(both.body.hasMore).toBe(false);

      const first = await agent.get(url).query({ limit: 1 });
      expect(first.body.messages).toHaveLength(1);
      expect(first.body.hasMore).toBe(true);
      const second = await agent.get(url).query({ limit: 1, offset: 1 });
      expect(second.body.messages).toHaveLength(1);
      expect(second.body.messages[0].id).not.toBe(first.body.messages[0].id);
    });

    it('POST /messages/mark-read checks the permission on the named source', async () => {
      await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      expect((await agent.post('/messages/mark-read').send({ channelId: 0, sourceId: harness.sourceB })).status).toBe(403);
      expect((await agent.post('/messages/mark-read').send({ channelId: 0, sourceId: harness.sourceA })).status).toBe(200);
    });
  });

  describe('how the source is resolved', () => {
    it('400s when sourceId is not a string', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/settings/traceroute-interval').send({ intervalMinutes: 5, sourceId: [harness.sourceA] });
      expect(res.status).toBe(400);
      expect(managerA.setTracerouteInterval).not.toHaveBeenCalled();
    });

    it('400s when the query sourceId is repeated', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/settings/traceroute-log?sourceId=${harness.sourceA}&sourceId=${harness.sourceB}`);
      expect(res.status).toBe(400);
    });

    it('accepts the same sourceId in the query and the body', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post('/settings/traceroute-interval')
        .query({ sourceId: harness.sourceB })
        .send({ intervalMinutes: 5, sourceId: harness.sourceB });
      expect(res.status).toBe(200);
      expect(managerB.setTracerouteInterval).toHaveBeenCalledWith(5);
      expect(managerA.setTracerouteInterval).not.toHaveBeenCalled();
    });

    it('409s SOURCE_NOT_CONNECTED on a device route for a permitted source whose radio is offline', async () => {
      await sourceManagerRegistry.removeManager(harness.sourceB);
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/nodes/refresh').send({ sourceId: harness.sourceB });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      expect(managerA.refreshNodeDatabase).not.toHaveBeenCalled();
    });

    it('accepts a Bearer token under the same per-source rule', async () => {
      await harness.grant(harness.limited.id, 'settings', 'read', harness.sourceA);
      const token = await harness.tokenFor(harness.limited);
      const agent = await harness.loginAs(null);
      const allowed = await agent.get('/settings/auto-ping').query({ sourceId: harness.sourceA }).set('Authorization', `Bearer ${token}`);
      expect(allowed.status).toBe(200);
      const refused = await agent.get('/settings/auto-ping').query({ sourceId: harness.sourceB }).set('Authorization', `Bearer ${token}`);
      expect(refused.status).toBe(403);
    });
  });
});

describe('readNewestAcrossSources', () => {
  const rows: Record<string, number[]> = { a: [9, 6, 3], b: [8, 7, 1] };
  const fetch = async (id: string, limit: number) => rows[id].slice(0, limit);

  it('pages the merged list the way one query over the same sources would', async () => {
    expect(await readNewestAcrossSources(['a', 'b'], fetch, (n) => n, 3)).toEqual([9, 8, 7]);
    expect(await readNewestAcrossSources(['a', 'b'], fetch, (n) => n, 3, 2)).toEqual([7, 6, 3]);
    expect(await readNewestAcrossSources(['a'], fetch, (n) => n, 2, 1)).toEqual([6, 3]);
    expect(await readNewestAcrossSources([], fetch, (n) => n, 5)).toEqual([]);
  });
});

// ── Guard: every route on these routers is classified ───────────────────────

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

/**
 * How a route is gated:
 *  - `source-gate`: requireSourcePermission() / requireSourcePairPermission().
 *  - `admin-only`: requireAdmin(). An admin holds every permission on every
 *    source, so there is no source to check.
 *  - `scoped`: requirePermission() with `sourceIdFrom`.
 *  - `unscoped`: requirePermission() on a per-source resource with no source.
 *  - `global`: requirePermission() on a resource that is not per-source.
 *  - `in-handler`: no requirePermission(); the handler or a local middleware checks.
 */
type Verdict = 'source-gate' | 'admin-only' | 'scoped' | 'unscoped' | 'global' | 'in-handler';

function verdict(route: RegisteredRoute): Verdict {
  if (route.handlers.some((h) => getSourceScopedGate(h) || getSourcePairGate(h))) return 'source-gate';
  if (route.handlers.some((h) => isAdminGate(h))) return 'admin-only';
  const gates = route.handlers.map((h) => getPermissionGate(h)).filter((g) => g !== undefined);
  if (gates.length === 0) return 'in-handler';
  if (gates.some((g) => isSourceyResource(g.resource) && !g.sourceScoped)) return 'unscoped';
  return gates.every((g) => g.sourceScoped) ? 'scoped' : 'global';
}

const routesWith = (router: Router, wanted: Verdict): string[] =>
  registeredRoutes(router).filter((r) => verdict(r) === wanted).map((r) => key(r.method, r.path)).sort();

describe('guard: per-source routes on these routers are registered with a source-scoped gate', () => {
  /**
   * Routes that gate a per-source resource with NO source, on purpose. A new
   * route must not be added here unless it reads and changes nothing that
   * belongs to one source. Each entry says why.
   */
  const UNSCOPED_BY_DESIGN: Record<RouterName, string[]> = {
    nodes: [
      // One row per physical node in the global estimated_positions table,
      // pooled from every source (#3271). There is no source to check.
      'GET /nodes/:nodeNum/position-estimate',
    ],
    ignored: [],
    settings: [
      // Clears the global rows (writable on a grant for any source, by the
      // ruling in PER_SOURCE_NODE_DISPLAY_PHASE6_SPEC §11). The handler limits
      // the per-source rows it clears to the sources the caller may write.
      'DELETE /',
      // Global, install-wide status of the two batch jobs below.
      'GET /auto-enrichment/status',
      'GET /position-estimation/status',
      // Probes a URL the caller supplies or the global Apprise URL.
      'POST /test-apprise',
    ],
    messages: [],
  };

  it.each(Object.keys(ROUTERS) as RouterName[])('%s: no per-source resource is gated without a source, beyond the commented list', (name) => {
    expect(routesWith(ROUTERS[name], 'unscoped')).toEqual([...UNSCOPED_BY_DESIGN[name]].sort());
  });

  /**
   * Routes behind requireAdmin(). A job that works on every source at once
   * belongs here, not behind a per-source permission: `settings:write` on one
   * source is not a grant over the others.
   */
  const ADMIN_ONLY: Record<RouterName, string[]> = {
    nodes: [
      // Re-keys one node's history. Admin only since #5032.
      'POST /nodes/identity-changes/merge',
      'POST /nodes/identity-changes/merge/preview',
      'POST /nodes/identity-changes/merges/:mergeId/undo',
    ],
    ignored: [],
    settings: [
      // Install-wide batch jobs over every source (maintainer ruling).
      'POST /auto-enrichment/run-now',
      'POST /position-estimation/run-now',
    ],
    messages: [],
  };

  it.each(Object.keys(ROUTERS) as RouterName[])('%s: the admin-only routes are the known ones', (name) => {
    expect(routesWith(ROUTERS[name], 'admin-only')).toEqual([...ADMIN_ONLY[name]].sort());
  });

  it('every source-gated route has a row in CASES, and enforces what the row says', () => {
    for (const name of Object.keys(ROUTERS) as RouterName[]) {
      const tableKeys = CASES.filter((c) => c.router === name).map((c) => key(c.method, c.route));
      // copy-nodeinfo is the one pair-gated route; its tests are in their own block.
      const pairKeys = registeredRoutes(ROUTERS[name])
        .filter((r) => r.handlers.some((h) => getSourcePairGate(h)))
        .map((r) => key(r.method, r.path));
      expect(routesWith(ROUTERS[name], 'source-gate'), name).toEqual([...tableKeys, ...pairKeys].sort());
    }
    for (const c of CASES) {
      const route = registeredRoutes(ROUTERS[c.router]).find((r) => key(r.method, r.path) === key(c.method, c.route));
      expect(route, label(c)).toBeDefined();
      const gate = route!.handlers.map((h) => getSourceScopedGate(h)).find((g) => g !== undefined);
      expect(gate, label(c)).toEqual({
        resource: c.resource,
        action: c.action,
        whenOmitted: c.rule,
        device: c.device ? 'meshtastic' : 'any',
      });
    }
  });

  it('copy-nodeinfo is the only pair-gated route and reads/writes the fields its tests send', () => {
    const pairs = registeredRoutes(nodesRoutes)
      .map((r) => ({ route: key(r.method, r.path), gate: r.handlers.map((h) => getSourcePairGate(h)).find((g) => g !== undefined) }))
      .filter((r) => r.gate);
    expect(pairs).toEqual([
      { route: 'POST /nodes/:nodeNum/copy-nodeinfo', gate: { resource: 'nodes', readFrom: 'fromSourceId', writeTo: 'toSourceId' } },
    ]);
  });

  /**
   * Routes with no requirePermission() at all: the handler (or a middleware
   * local to the file) resolves the user and checks per source itself. A new
   * route lands here only if it does that; otherwise give it a gate.
   */
  const IN_HANDLER: Record<RouterName, string[]> = {
    nodes: [
      'GET /nodes',
      'GET /nodes/active',
      'GET /nodes/enrichment/analysis',
      'POST /nodes/enrichment/apply',
      'GET /nodes/:nodeId/position-history',
      'GET /nodes/:nodeId/positions',
      'GET /nodes/:nodeId/position-override',
    ],
    ignored: [],
    settings: ['GET /'],
    messages: [
      'GET /search',
      'DELETE /:id',
      'DELETE /channels/:channelId',
      'DELETE /direct-messages/:nodeNum',
      'DELETE /nodes/:nodeNum/traceroutes',
      'DELETE /nodes/:nodeNum/telemetry',
      'DELETE /nodes/:nodeNum/position-history',
      'DELETE /nodes/:nodeNum',
      'POST /nodes/:nodeNum/purge-from-device',
      'GET /',
      'GET /channel/:channel',
      'POST /mark-read',
      'GET /counts',
      'GET /unread-counts',
      'GET /unread-by-source',
      'POST /mark-all-dms-read',
      'GET /first-unread',
      'POST /send',
    ],
  };

  it.each(Object.keys(ROUTERS) as RouterName[])('%s: routes that check in the handler are the known ones', (name) => {
    expect(routesWith(ROUTERS[name], 'in-handler')).toEqual([...IN_HANDLER[name]].sort());
  });

  it('no route on these routers gates only a global resource', () => {
    // If one appears, classify it: add an expectation here saying why it is global.
    for (const name of Object.keys(ROUTERS) as RouterName[]) {
      expect(routesWith(ROUTERS[name], 'global'), name).toEqual([]);
    }
  });
});
