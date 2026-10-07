/**
 * Per-source scoping for the telemetry reads and for `GET /status`.
 *
 * `info` and `dashboard`, which open the telemetry routes, are install-wide
 * grants. The rows are per source, so each handler must pick its sources from
 * the caller's per-source grants:
 *
 *   - `GET /telemetry/available/nodes` with no `sourceId`
 *   - `GET /direct-neighbors`
 *   - `GET /telemetry/:nodeId/rates` with no `sourceId`
 *   - `DELETE /telemetry/:nodeId/:telemetryType`
 *
 * `GET /status` is open to everyone and used to hand out the primary node's
 * identity and install-wide counts. The exact key set per caller is asserted.
 *
 * Real auth middleware and real permission rows. Managers are fakes; nothing
 * is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';

import telemetryRoutes from './telemetryRoutes.js';
import systemRoutes from './systemRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { getPermissionGate, isAdminGate } from '../auth/authMiddleware.js';
import { getSourceScopedGate } from '../utils/sourceScopedAccess.js';
import { getDeviceSourceGate } from '../utils/deviceSourcePermission.js';
import { isSourceyResource } from '../../types/permission.js';

const nodeIdFor = (num: number): string => `!${num.toString(16).padStart(8, '0')}`;

// Node numbers unique to this file: node rows outlive a test.
const SHARED = 0x5d000001;
const ONLY_A = 0x5d0a0002;
const ONLY_B = 0x5d0b0003;
const LOCAL_NUM = 0x5d000999;
const ALL_NODES = [SHARED, ONLY_A, ONLY_B];

const LOCAL = { nodeNum: LOCAL_NUM, nodeId: nodeIdFor(LOCAL_NUM), longName: 'ZZ-PRIMARY-LONG', shortName: 'ZZPS' };
const IDENTITY_MARKERS = [LOCAL.nodeId, LOCAL.longName, LOCAL.shortName, String(LOCAL_NUM)];

const text = (body: unknown): string => JSON.stringify(body ?? null);

describe('telemetry reads and GET /status are scoped by the caller\'s per-source grants', () => {
  let harness: RouteTestHarness;
  let limited: SeededUser;

  const fakeManager = (sourceId: string): ISourceManager =>
    ({
      sourceId,
      sourceType: 'meshtastic_tcp',
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType: 'meshtastic_tcp', connected: true }),
      getLocalNodeInfo: vi.fn().mockReturnValue({ ...LOCAL, extra: 'not-for-the-reply' }),
      getConnectionStatus: vi.fn().mockResolvedValue({
        connected: true, nodeResponsive: true, configuring: false, nodeIp: '10.99.99.99', userDisconnected: false,
      }),
    }) as unknown as ISourceManager;

  const give = async (
    resource: string,
    actions: Array<'read' | 'write' | 'viewOnMap'>,
    sourceId?: string,
  ): Promise<void> => {
    await databaseService.auth.createPermission({
      userId: limited.id,
      resource,
      canRead: actions.includes('read'),
      canWrite: actions.includes('write'),
      canViewOnMap: actions.includes('viewOnMap'),
      sourceId: sourceId ?? null,
      grantedAt: Date.now(),
      grantedBy: null,
    } as never);
  };

  const seedNode = (sourceId: string, nodeNum: number): Promise<unknown> =>
    databaseService.nodes.upsertNode(
      {
        nodeNum, nodeId: nodeIdFor(nodeNum), longName: `Node ${nodeNum.toString(16)}`, shortName: 'N', hwModel: 43,
        channel: 0, latitude: 30, longitude: -90, lastHeard: Math.floor(Date.now() / 1000),
      } as never,
      sourceId,
    );

  const sample = (sourceId: string, nodeNum: number, telemetryType: string, value: number, agoMs: number): Promise<unknown> => {
    const at = Date.now() - agoMs;
    return databaseService.telemetry.insertTelemetry(
      { nodeId: nodeIdFor(nodeNum), nodeNum, telemetryType, timestamp: at, value, createdAt: at, channel: 0 },
      sourceId,
    );
  };

  const heard = (sourceId: string, nodeNum: number, rssi: number): Promise<unknown> =>
    databaseService.packetLog.insertPacketLog(
      {
        timestamp: Date.now() - 60_000, from_node: nodeNum, from_node_id: nodeIdFor(nodeNum), portnum: 1, encrypted: false,
        rssi, hop_start: 3, hop_limit: 3, direction: 'rx',
      },
      sourceId,
    );

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/', telemetryRoutes);
        app.use('/', systemRoutes);
      },
    });
    limited = harness.limited;
    // A is registered first, so it is the primary Meshtastic source.
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceA));
    await sourceManagerRegistry.addManager(fakeManager(harness.sourceB));

    await seedNode(harness.sourceA, SHARED);
    await seedNode(harness.sourceA, ONLY_A);
    await seedNode(harness.sourceB, SHARED);
    await seedNode(harness.sourceB, ONLY_B);

    // SHARED reports weather on B only. Device metrics on both.
    await sample(harness.sourceA, SHARED, 'batteryLevel', 90, 60_000);
    await sample(harness.sourceB, SHARED, 'temperature', 21, 60_000);
    await sample(harness.sourceB, ONLY_B, 'temperature', 22, 60_000);
    // Packet counters: 60 packets a minute on A, 6000 a minute on B.
    await sample(harness.sourceA, SHARED, 'numPacketsRx', 0, 120_000);
    await sample(harness.sourceA, SHARED, 'numPacketsRx', 60, 60_000);
    await sample(harness.sourceB, SHARED, 'numPacketsRx', 0, 120_000);
    await sample(harness.sourceB, SHARED, 'numPacketsRx', 6000, 60_000);

    // Zero-hop packets: SHARED heard by both, ONLY_B by B.
    await heard(harness.sourceA, SHARED, -50);
    await heard(harness.sourceB, SHARED, -90);
    await heard(harness.sourceB, ONLY_B, -70);
    databaseService.invalidateTelemetryTypesCache();
  });

  afterEach(async () => {
    for (const sourceId of [harness.sourceA, harness.sourceB]) {
      for (const nodeNum of ALL_NODES) {
        await databaseService.telemetry.purgeNodeTelemetry(nodeNum, sourceId).catch(() => {});
        await databaseService.nodes.deleteNodeRecord(nodeNum, sourceId).catch(() => {});
      }
      await databaseService.packetLog.clearPacketLogs(sourceId).catch(() => {});
      await sourceManagerRegistry.removeManager(sourceId);
    }
    databaseService.invalidateTelemetryTypesCache();
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  // ── GET /telemetry/available/nodes ────────────────────────────────────────
  describe('GET /telemetry/available/nodes', () => {
    it('with no sourceId, lists only nodes of the source the caller holds a channel grant on', async () => {
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/telemetry/available/nodes');

      expect(res.status).toBe(200);
      expect(res.body.nodes).toEqual([nodeIdFor(SHARED)]);
      // SHARED's weather samples are source B's.
      expect(res.body.weather).toEqual([]);
      expect(text(res.body)).not.toContain(nodeIdFor(ONLY_B));
    });

    it('lists both sources for a user with a channel grant on each, as it does for an admin', async () => {
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      await give('channel_0', ['viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);
      const admin = await harness.loginAs(harness.admin);
      const ours = (ids: string[]): string[] => ids.filter((id) => ALL_NODES.map(nodeIdFor).includes(id)).sort();

      const user = (await agent.get('/telemetry/available/nodes')).body;
      const all = (await admin.get('/telemetry/available/nodes')).body;

      expect(ours(user.nodes)).toEqual(ours(all.nodes));
      expect(ours(user.weather)).toEqual(ours(all.weather));
      expect([...new Set(ours(user.weather))]).toEqual([nodeIdFor(SHARED), nodeIdFor(ONLY_B)].sort());
      expect(Object.keys(user).sort()).toEqual(Object.keys(all).sort());
    });

    it('checks the channel on the row\'s own source: channel_1 on B does not list B\'s channel-0 nodes', async () => {
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      await give('channel_1', ['viewOnMap'], harness.sourceB);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/telemetry/available/nodes');

      expect(res.body.nodes).toEqual([nodeIdFor(SHARED)]);
      expect(text(res.body)).not.toContain(nodeIdFor(ONLY_B));
    });

    it('lists nothing for a holder of info:read with no channel grant, and when naming a source without one', async () => {
      await give('info', ['read']);
      const agent = await harness.loginAs(limited);
      expect((await agent.get('/telemetry/available/nodes')).body).toMatchObject({ nodes: [], weather: [], pkc: [], unmapped: [] });

      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const named = await agent.get('/telemetry/available/nodes').query({ sourceId: harness.sourceB });
      expect(named.body).toMatchObject({ nodes: [], weather: [], pkc: [] });
    });

    it('403s without info:read', async () => {
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      expect((await (await harness.loginAs(limited)).get('/telemetry/available/nodes')).status).toBe(403);
    });
  });

  // ── GET /direct-neighbors ─────────────────────────────────────────────────
  describe('GET /direct-neighbors', () => {
    it('reads only the sources the caller holds nodes:read on', async () => {
      await give('info', ['read']);
      await give('nodes', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get('/direct-neighbors');

      expect(res.status).toBe(200);
      expect(Object.keys(res.body.data)).toEqual([String(SHARED)]);
      // Source A's packet only: B heard the same node at -90.
      expect(res.body.data[SHARED]).toMatchObject({ avgRssi: -50, packetCount: 1 });
      expect(res.body.count).toBe(1);
    });

    it('returns nothing to a holder of info:read with nodes:read on no source', async () => {
      await give('info', ['read']);
      const res = await (await harness.loginAs(limited)).get('/direct-neighbors');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, data: {}, count: 0 });
    });

    it('403s naming a source the caller does not hold nodes:read on, and narrows to one they do', async () => {
      await give('info', ['read']);
      await give('nodes', ['read'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const refused = await agent.get('/direct-neighbors').query({ sourceId: harness.sourceB });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ success: false, code: 'FORBIDDEN' });

      const named = await agent.get('/direct-neighbors').query({ sourceId: harness.sourceA });
      expect(Object.keys(named.body.data)).toEqual([String(SHARED)]);
    });

    it('merges both sources for a user with nodes:read on both, as for an admin', async () => {
      await give('info', ['read']);
      await give('nodes', ['read'], harness.sourceA);
      await give('nodes', ['read'], harness.sourceB);
      const user = (await (await harness.loginAs(limited)).get('/direct-neighbors')).body.data;
      const admin = await harness.loginAs(harness.admin);
      const all = (await admin.get('/direct-neighbors')).body.data;

      expect(user[SHARED]).toMatchObject({ avgRssi: -70, packetCount: 2 });
      expect(user[SHARED]).toEqual(all[SHARED]);
      expect(user[ONLY_B]).toEqual(all[ONLY_B]);
      // An admin naming one source gets that source.
      const one = (await admin.get('/direct-neighbors').query({ sourceId: harness.sourceB })).body.data;
      expect(one[SHARED]).toMatchObject({ avgRssi: -90, packetCount: 1 });
    });
  });

  // ── GET /telemetry/:nodeId/rates ──────────────────────────────────────────
  describe('GET /telemetry/:nodeId/rates', () => {
    const rxRates = (body: { numPacketsRx: Array<{ ratePerMinute: number }> }): number[] =>
      body.numPacketsRx.map((r) => r.ratePerMinute);

    it('with no sourceId, reads only the source the caller may see the node on', async () => {
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.get(`/telemetry/${nodeIdFor(SHARED)}/rates`);

      expect(res.status).toBe(200);
      expect(rxRates(res.body)).toEqual([60]);
    });

    it('403s with no sourceId when the caller may see the node on no source, and for a node only B holds', async () => {
      await give('info', ['read']);
      const agent = await harness.loginAs(limited);
      const none = await agent.get(`/telemetry/${nodeIdFor(SHARED)}/rates`);
      expect(none.status).toBe(403);
      expect(none.body).toMatchObject({ success: false, code: 'FORBIDDEN' });

      await give('channel_0', ['viewOnMap'], harness.sourceA);
      expect((await agent.get(`/telemetry/${nodeIdFor(ONLY_B)}/rates`)).status).toBe(403);
    });

    it('403s naming a source the caller cannot see the node on, and reads the one they can', async () => {
      await give('info', ['read']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      expect((await agent.get(`/telemetry/${nodeIdFor(SHARED)}/rates`).query({ sourceId: harness.sourceB })).status).toBe(403);
      const named = await agent.get(`/telemetry/${nodeIdFor(SHARED)}/rates`).query({ sourceId: harness.sourceA });
      expect(rxRates(named.body)).toEqual([60]);
    });

    it('an admin naming a source gets that source', async () => {
      const admin = await harness.loginAs(harness.admin);
      const res = await admin.get(`/telemetry/${nodeIdFor(SHARED)}/rates`).query({ sourceId: harness.sourceB });
      expect(rxRates(res.body)).toEqual([6000]);
    });
  });

  // ── DELETE /telemetry/:nodeId/:telemetryType ──────────────────────────────
  describe('DELETE /telemetry/:nodeId/:telemetryType', () => {
    const remaining = async (sourceId: string): Promise<number> =>
      (await databaseService.telemetry.getTelemetryByNode(nodeIdFor(SHARED), 100, undefined, undefined, 0, 'numPacketsRx', sourceId)).length;

    it('refuses a holder of info:write who cannot see the node on that source', async () => {
      await give('info', ['read', 'write']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.delete(`/telemetry/${nodeIdFor(SHARED)}/numPacketsRx`).query({ sourceId: harness.sourceB });

      expect(res.status).toBe(403);
      expect(await remaining(harness.sourceB)).toBe(2);
    });

    it('deletes on the source the caller can see the node on, and only there', async () => {
      await give('info', ['read', 'write']);
      await give('channel_0', ['viewOnMap'], harness.sourceA);
      const agent = await harness.loginAs(limited);

      const res = await agent.delete(`/telemetry/${nodeIdFor(SHARED)}/numPacketsRx`).query({ sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(await remaining(harness.sourceA)).toBe(0);
      expect(await remaining(harness.sourceB)).toBe(2);
    });
  });

  // ── GET /status ───────────────────────────────────────────────────────────
  describe('GET /status', () => {
    const BASE_KEYS = ['connection', 'nodeEnv', 'status', 'timestamp', 'uptime', 'version'];
    const expectNoIdentity = (body: unknown): void => {
      for (const marker of IDENTITY_MARKERS) expect(text(body), `leaked ${marker}`).not.toContain(marker);
    };

    it('gives an anonymous caller that the server is up, its version and the link flag, and nothing else', async () => {
      const res = await (await harness.loginAs(null)).get('/status');

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(BASE_KEYS);
      expect(res.body.connection).toEqual({ connected: true });
      expect(res.body.status).toBe('ok');
      expect(typeof res.body.version).toBe('string');
      expectNoIdentity(res.body);
    });

    it('gives a signed-in user with no grant the same as an anonymous caller', async () => {
      const res = await (await harness.loginAs(limited)).get('/status');

      expect(Object.keys(res.body).sort()).toEqual(BASE_KEYS);
      expect(res.body.connection).toEqual({ connected: true });
      expectNoIdentity(res.body);
    });

    it('does not give the primary node\'s identity on a grant held on another source', async () => {
      await give('nodes', ['read'], harness.sourceB);
      await give('info', ['read']);
      await give('dashboard', ['read']);
      const res = await (await harness.loginAs(limited)).get('/status');

      expect(Object.keys(res.body).sort()).toEqual(BASE_KEYS);
      expect(res.body.connection).toEqual({ connected: true });
      expectNoIdentity(res.body);
    });

    it('adds the node identity, and no counts, for nodes:read on the primary source', async () => {
      await give('nodes', ['read'], harness.sourceA);
      const res = await (await harness.loginAs(limited)).get('/status');

      expect(Object.keys(res.body).sort()).toEqual(BASE_KEYS);
      expect(res.body.connection).toEqual({ connected: true, localNode: LOCAL });
    });

    it('gives an admin the identity and the install-wide counts', async () => {
      const res = await (await harness.loginAs(harness.admin)).get('/status');

      expect(Object.keys(res.body).sort()).toEqual([...BASE_KEYS, 'statistics'].sort());
      expect(res.body.connection).toEqual({ connected: true, localNode: LOCAL });
      expect(Object.keys(res.body.statistics).sort()).toEqual(['channels', 'messages', 'nodes']);
      expect(res.body.statistics.nodes).toBeGreaterThanOrEqual(4);
    });
  });
});

// ── Guard: every telemetry / system route is classified ─────────────────────

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
 * How a telemetry or system route decides who gets what:
 *  - `global-then-source`: gated on an install-wide grant (`info`), then the
 *    handler picks the sources from the caller's per-source grants. Tested above.
 *  - `in-handler`: no permission middleware. The handler checks the install-wide
 *    grant and then the node on the source read. A `sourceId` is required, or
 *    the handler resolves the caller's sources itself (`/rates`).
 *  - `reduced`: open to every caller; the handler adds fields by grant. Tested above.
 *  - `global`: an install-wide grant and no per-source rows in the reply.
 *  - `public`: no rows from any source.
 */
type Kind = 'global-then-source' | 'in-handler' | 'reduced' | 'global' | 'public';

const CLASSIFIED: Record<'telemetry' | 'system', Record<string, Kind>> = {
  telemetry: {
    'GET /direct-neighbors': 'global-then-source',
    'GET /telemetry/available/nodes': 'global-then-source',
    'DELETE /telemetry/:nodeId/:telemetryType': 'global-then-source',
    'GET /telemetry/:nodeId': 'in-handler',
    'GET /telemetry/:nodeId/rates': 'in-handler',
    'GET /telemetry/:nodeId/smarthops': 'in-handler',
    'GET /telemetry/:nodeId/linkquality': 'in-handler',
    'GET /telemetry/:nodeId/signal-trend': 'in-handler',
  },
  system: {
    'GET /status': 'reduced',
    'GET /system/status': 'global',
    'GET /version/check': 'public',
    // `settings:write` with no source: restarts the whole process. Not a read; not changed here.
    'POST /system/restart': 'global',
  },
};

describe('guard: telemetry and system routes are classified', () => {
  const routers = { telemetry: telemetryRoutes, system: systemRoutes } as const;
  const key = (r: RegisteredRoute): string => `${r.method.toUpperCase()} ${r.path}`;
  const source = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

  const detected = (route: RegisteredRoute): 'source-gate' | 'admin-only' | 'permission' | 'ungated' => {
    if (route.handlers.some((h) => getSourceScopedGate(h) || getDeviceSourceGate(h))) return 'source-gate';
    if (route.handlers.some((h) => isAdminGate(h))) return 'admin-only';
    if (route.handlers.some((h) => getPermissionGate(h))) return 'permission';
    return 'ungated';
  };

  it.each(['telemetry', 'system'] as const)('every %s route has a class, and its middleware matches it', (name) => {
    const routes = registeredRoutes(routers[name]);
    // A new route must be added to CLASSIFIED, with a test for what it returns to whom.
    expect(routes.map(key).sort()).toEqual(Object.keys(CLASSIFIED[name]).sort());
    for (const route of routes) {
      const kind = CLASSIFIED[name][key(route)];
      const expected = kind === 'global-then-source' || kind === 'global' ? 'permission' : 'ungated';
      expect(detected(route), key(route)).toBe(expected);
    }
  });

  it('a requirePermission() with no source on the telemetry router gates an install-wide resource only', () => {
    // `requirePermission('nodes', 'read')` with no source passes on a grant for
    // any source. `info` is install-wide, so it may open a route; the handler
    // then picks the sources. `POST /system/restart` is the one known exception.
    for (const route of registeredRoutes(telemetryRoutes)) {
      for (const gate of route.handlers.map((h) => getPermissionGate(h)).filter((g) => g !== undefined)) {
        expect(gate.sourceScoped || !isSourceyResource(gate.resource), key(route)).toBe(true);
      }
    }
    const unscoped = registeredRoutes(systemRoutes)
      .filter((route) => route.handlers.some((h) => {
        const gate = getPermissionGate(h);
        return gate !== undefined && !gate.sourceScoped && isSourceyResource(gate.resource);
      }))
      .map(key);
    expect(unscoped).toEqual(['POST /system/restart']);
  });

  it('every hasPermission() call on a per-source resource names a source', () => {
    // With three arguments the check passes on a grant for ANY source. That is
    // right for an install-wide resource (`info`, `dashboard`) and wrong for a
    // per-source one. The position gate must not call it at all: it answers
    // per row from one load of the grants.
    const files = ['./telemetryRoutes.ts', './systemRoutes.ts', '../services/sourceDashboardData.ts', '../utils/positionVisibility.ts'];
    for (const file of files) {
      const calls = [...source(file).matchAll(/\b(?:hasPermission|checkPermissionAsync)\(([^()]*)\)/g)].map((m) => m[1].split(',').map((a) => a.trim()));
      const unscoped = calls.filter((args) => args.length < 4 && isSourceyResource(args[1].replace(/['"`]/g, '') as never));
      expect(unscoped, file).toEqual([]);
    }
    expect(source('../utils/positionVisibility.ts')).not.toMatch(/\b(?:hasPermission|checkPermissionAsync|getUserPermissionSetAsync)\(/);
  });

  it('the telemetry reads do not merge channel grants across sources', () => {
    // `filterNodesByChannelPermission(rows, user)` and
    // `checkNodeChannelAccess(nodeId, user)` with no source check against
    // grants merged from every source.
    const telemetry = source('./telemetryRoutes.ts');
    for (const fn of ['filterNodesByChannelPermission', 'checkNodeChannelAccess']) {
      const calls = [...telemetry.matchAll(new RegExp(`\\b${fn}\\(([^()]*)\\)`, 'g'))].map((m) => m[1]);
      expect(calls.length, fn).toBeGreaterThan(0);
      expect(calls.filter((args) => args.split(',').length < 3), fn).toEqual([]);
      // A third argument that can be undefined is the same merge.
      expect(calls.filter((args) => /as string \| undefined|\?\? undefined/.test(args)), fn).toEqual([]);
    }
  });
});
