/**
 * Per-source permission scoping for the device-config routes.
 *
 * Every route that reads or writes one source's Meshtastic device is gated by
 * `requireDeviceSourcePermission()`. These tests drive each such route through
 * the real auth middleware with real permission rows:
 *
 *   - a user granted the permission on source A only is refused for source B
 *     and allowed for source A;
 *   - a request with no sourceId is authorised against the primary source;
 *   - an anonymous caller is refused; an admin is allowed everywhere.
 *
 * The guard block at the end enumerates the routers' registered routes and
 * fails when a `configuration`-gated route is not scoped, or when a scoped
 * route has no row in the table here.
 *
 * Managers are fakes. Nothing is sent to a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { Router } from 'express';

vi.mock('../services/deviceBackupService.js', () => ({
  deviceBackupService: { generateBackup: vi.fn().mockResolvedValue('yaml: true\n') },
}));
vi.mock('../services/deviceRestoreService.js', () => ({
  deviceRestoreService: {
    restoreBackup: vi.fn().mockResolvedValue({ applied: [], failed: [], channels: 0, requiresReboot: false }),
  },
}));
vi.mock('../services/backupFileService.js', () => ({
  backupFileService: {
    getBackup: vi.fn().mockResolvedValue('yaml: true\n'),
    saveBackup: vi.fn().mockResolvedValue('saved.yaml'),
    listBackups: vi.fn().mockResolvedValue([]),
    deleteBackup: vi.fn().mockResolvedValue(undefined),
  },
}));

import configRoutes from './configRoutes.js';
import deviceRoutes from './deviceRoutes.js';
import channelRoutes from './channelRoutes.js';
import { backupRouter } from './backupRoutes.js';
import databaseService from '../../services/database.js';
import { deviceBackupService } from '../services/deviceBackupService.js';
import { deviceRestoreService } from '../services/deviceRestoreService.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { sourceManagerRegistry, type ISourceManager } from '../sourceManagerRegistry.js';
import { getPermissionGate } from '../auth/authMiddleware.js';
import { getDeviceSourceGate } from '../utils/deviceSourcePermission.js';
import { isSourceyResource } from '../../types/permission.js';

type Agent = Awaited<ReturnType<RouteTestHarness['loginAs']>>;
type Action = 'read' | 'write';

/** Every device method a route under test calls. */
const DEVICE_METHODS = [
  'getCurrentConfig',
  'isLocalNodeBridged',
  'setDeviceConfig',
  'setNetworkConfig',
  'setLoRaConfig',
  'isTxEnabled',
  'getConfiguredModemPreset',
  'setPositionConfig',
  'setMQTTConfig',
  'setNeighborInfoConfig',
  'setPowerConfig',
  'setDisplayConfig',
  'setTelemetryConfig',
  'requestModuleConfig',
  'setGenericModuleConfig',
  'setNodeOwner',
  'requestConfig',
  'getDeviceConfig',
  'getLocalNodeInfo',
  'rebootDevice',
  'purgeNodeDb',
  'beginEditSettings',
  'commitEditSettings',
  'setChannelConfig',
] as const;

type FakeManager = ISourceManager & Record<(typeof DEVICE_METHODS)[number], Mock>;

function fakeManager(sourceId: string, sourceType = 'meshtastic_tcp'): FakeManager {
  const methods = Object.fromEntries(DEVICE_METHODS.map((name) => [name, vi.fn().mockResolvedValue(undefined)]));
  return {
    sourceId,
    sourceType,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ sourceId, sourceName: sourceId, sourceType, connected: true }),
    startDistanceDeleteScheduler: vi.fn().mockResolvedValue(undefined),
    stopDistanceDeleteScheduler: vi.fn(),
    ...methods,
    getCurrentConfig: vi.fn().mockReturnValue({ deviceConfig: {}, moduleConfig: {} }),
    isLocalNodeBridged: vi.fn().mockReturnValue(false),
    getMqttClientProxyState: vi.fn().mockReturnValue(null),
    isTxEnabled: vi.fn().mockReturnValue(true),
    getConfiguredModemPreset: vi.fn().mockReturnValue(0),
    getDeviceConfig: vi.fn().mockResolvedValue({ region: 'US' }),
    getLocalNodeInfo: vi.fn().mockReturnValue({ nodeId: '!00000001' }),
  } as unknown as FakeManager;
}

interface RouteCase {
  /** Router this route is registered on, and the path it is mounted under. */
  router: 'config' | 'device' | 'channels' | 'backup';
  method: 'get' | 'post';
  /** Path as registered on the router (the guard matches on it). */
  route: string;
  /** Path to request, when the registered one has a parameter. */
  path?: string;
  action: Action;
  from: 'query' | 'body';
  /** Payload sent besides sourceId. */
  payload?: Record<string, unknown>;
  /** Status once the gate lets the request through. */
  allowed: number;
  /** Device method the handler calls on the target manager, if it gets that far. */
  device?: (typeof DEVICE_METHODS)[number];
  /** Routes that 400 without an explicit sourceId (requireSourceId). */
  explicitOnly?: boolean;
  /** Extra proof the handler ran against `sourceId`. */
  reached?: (sourceId: string, manager: FakeManager) => void;
}

const MOUNT: Record<RouteCase['router'], string> = {
  config: '/config',
  device: '',
  channels: '/channels',
  backup: '/backup',
};

const CASES: RouteCase[] = [
  { router: 'config', method: 'get', route: '/current', action: 'read', from: 'query', allowed: 200, device: 'getCurrentConfig' },
  { router: 'config', method: 'post', route: '/device', action: 'write', from: 'body', payload: { role: 1 }, allowed: 200, device: 'setDeviceConfig' },
  { router: 'config', method: 'post', route: '/network', action: 'write', from: 'body', payload: { wifiEnabled: false }, allowed: 200, device: 'setNetworkConfig' },
  { router: 'config', method: 'post', route: '/lora', action: 'write', from: 'body', payload: { hopLimit: 3 }, allowed: 200, device: 'setLoRaConfig' },
  { router: 'config', method: 'post', route: '/position', action: 'write', from: 'body', payload: { fixedPosition: false }, allowed: 200, device: 'setPositionConfig' },
  { router: 'config', method: 'post', route: '/mqtt', action: 'write', from: 'body', payload: { enabled: false }, allowed: 200, device: 'setMQTTConfig' },
  { router: 'config', method: 'post', route: '/neighborinfo', action: 'write', from: 'body', payload: { enabled: false }, allowed: 200, device: 'setNeighborInfoConfig' },
  { router: 'config', method: 'post', route: '/power', action: 'write', from: 'body', payload: { isPowerSaving: false }, allowed: 200, device: 'setPowerConfig' },
  { router: 'config', method: 'post', route: '/display', action: 'write', from: 'body', payload: { screenOnSecs: 60 }, allowed: 200, device: 'setDisplayConfig' },
  { router: 'config', method: 'post', route: '/module/telemetry', action: 'write', from: 'body', payload: { deviceUpdateInterval: 900 }, allowed: 200, device: 'setTelemetryConfig' },
  { router: 'config', method: 'post', route: '/module/request', action: 'write', from: 'body', payload: { configType: 1 }, allowed: 200, device: 'requestModuleConfig' },
  { router: 'config', method: 'post', route: '/module/:moduleType', path: '/module/serial', action: 'write', from: 'body', payload: { enabled: false }, allowed: 200, device: 'setGenericModuleConfig' },
  { router: 'config', method: 'post', route: '/owner', action: 'write', from: 'body', payload: { longName: 'Long', shortName: 'LN' }, allowed: 200, device: 'setNodeOwner' },
  { router: 'config', method: 'post', route: '/request', action: 'write', from: 'body', payload: { configType: 1 }, allowed: 200, device: 'requestConfig' },
  { router: 'device', method: 'get', route: '/device-config', action: 'read', from: 'query', allowed: 200, device: 'getDeviceConfig' },
  {
    router: 'device', method: 'get', route: '/device/backup', action: 'read', from: 'query', allowed: 200,
    reached: (_sourceId, manager) => expect(deviceBackupService.generateBackup).toHaveBeenCalledWith(manager),
  },
  { router: 'device', method: 'post', route: '/device/reboot', action: 'write', from: 'body', payload: { seconds: 5 }, allowed: 200, device: 'rebootDevice' },
  {
    router: 'device', method: 'post', route: '/device/purge-nodedb', action: 'write', from: 'body', payload: { seconds: 0 }, allowed: 200, device: 'purgeNodeDb',
    reached: (sourceId) => expect(databaseService.purgeAllNodesAsync).toHaveBeenCalledWith(sourceId),
  },
  // These two stop at their own validation (a 400 the gate did not send), so
  // the allowed path proves the gate passed without starting a device write.
  { router: 'channels', method: 'post', route: '/encode-url', action: 'read', from: 'body', payload: { channelIds: 'not-an-array' }, allowed: 400, explicitOnly: true },
  { router: 'channels', method: 'post', route: '/import-config', action: 'write', from: 'body', payload: {}, allowed: 400, explicitOnly: true },
  {
    router: 'backup', method: 'post', route: '/restore/:filename', path: '/restore/backup-1.yaml', action: 'write', from: 'body', allowed: 200,
    reached: (_sourceId, manager) => expect(deviceRestoreService.restoreBackup).toHaveBeenCalledWith(manager, expect.any(String)),
  },
];

const label = (c: RouteCase): string => `${c.method.toUpperCase()} ${MOUNT[c.router]}${c.route}`;

describe('device-config routes: permission is checked on the target source', () => {
  let harness: RouteTestHarness;
  let managerA: FakeManager;
  let managerB: FakeManager;
  const MQTT_SOURCE = 'rt-source-mqtt';

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createRouteTestApp({
      mount: (app) => {
        app.use('/config', configRoutes);
        app.use('/', deviceRoutes);
        app.use('/channels', channelRoutes);
        app.use('/backup', backupRouter);
      },
    });
    // A is registered first, so it is the primary Meshtastic source.
    managerA = fakeManager(harness.sourceA);
    managerB = fakeManager(harness.sourceB);
    await sourceManagerRegistry.addManager(managerA);
    await sourceManagerRegistry.addManager(managerB);
    vi.spyOn(databaseService, 'purgeAllNodesAsync').mockResolvedValue(undefined);
  });

  afterEach(async () => {
    for (const id of [harness.sourceA, harness.sourceB, MQTT_SOURCE]) {
      await sourceManagerRegistry.removeManager(id);
    }
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  /** Send the case's request naming `sourceId` (or no source when undefined). */
  const send = (agent: Agent, c: RouteCase, sourceId?: string) => {
    const url = `${MOUNT[c.router]}${c.path ?? c.route}`;
    if (c.method === 'get') {
      return agent.get(url).query(sourceId ? { sourceId } : {});
    }
    const body = { ...(c.payload ?? {}), ...(sourceId ? { sourceId } : {}) };
    return agent.post(url).send(body);
  };

  const deviceCalls = (manager: FakeManager): number =>
    DEVICE_METHODS.reduce((sum, name) => sum + manager[name].mock.calls.length, 0);

  /** The gate let the request through and the handler ran against `manager`. */
  const expectReached = (c: RouteCase, status: number, manager: FakeManager, other: FakeManager) => {
    expect(status).toBe(c.allowed);
    if (c.device) expect(manager[c.device]).toHaveBeenCalled();
    c.reached?.(manager.sourceId, manager);
    expect(deviceCalls(other)).toBe(0);
  };

  /** The gate refused: nothing reached either device. */
  const expectUntouched = () => {
    expect(deviceCalls(managerA)).toBe(0);
    expect(deviceCalls(managerB)).toBe(0);
    expect(deviceBackupService.generateBackup).not.toHaveBeenCalled();
    expect(deviceRestoreService.restoreBackup).not.toHaveBeenCalled();
    expect(databaseService.purgeAllNodesAsync).not.toHaveBeenCalled();
  };

  describe.each(CASES.map((c) => [label(c), c] as const))('%s', (_name, c) => {
    it('403s for source B when the grant is on source A only', async () => {
      await harness.grant(harness.limited.id, 'configuration', c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c, harness.sourceB);
      expect(res.status).toBe(403);
      expectUntouched();
    });

    it('is allowed for source A with the grant on source A', async () => {
      await harness.grant(harness.limited.id, 'configuration', c.action, harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, c, harness.sourceA);
      expectReached(c, res.status, managerA, managerB);
    });

    if (c.action === 'write') {
      it('403s with only configuration:read on the source', async () => {
        await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c, harness.sourceA);
        expect(res.status).toBe(403);
        expectUntouched();
      });
    }

    if (c.explicitOnly) {
      it('400s without a sourceId, whoever asks', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await send(agent, c);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('MISSING_SOURCE_ID');
        expectUntouched();
      });
    } else {
      it('with no sourceId, is allowed with the grant on the primary source and acts on it', async () => {
        await harness.grant(harness.limited.id, 'configuration', c.action, harness.sourceA);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c);
        expectReached(c, res.status, managerA, managerB);
      });

      it('with no sourceId, 403s when the grant is on a non-primary source', async () => {
        await harness.grant(harness.limited.id, 'configuration', c.action, harness.sourceB);
        const agent = await harness.loginAs(harness.limited);
        const res = await send(agent, c);
        expect(res.status).toBe(403);
        expectUntouched();
      });

      it('with no sourceId, an admin acts on the primary source', async () => {
        const agent = await harness.loginAs(harness.admin);
        const res = await send(agent, c);
        expectReached(c, res.status, managerA, managerB);
      });
    }

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await send(agent, c, harness.sourceA);
      expect([401, 403]).toContain(res.status);
      expectUntouched();
    });

    it('lets an admin act on either source without a grant', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await send(agent, c, harness.sourceB);
      expectReached(c, res.status, managerB, managerA);
    });
  });

  describe('how the target source is resolved', () => {
    const readCase = CASES.find((c) => c.route === '/current')!;
    const writeCase = CASES.find((c) => c.route === '/device')!;

    it('400s when the body sourceId is not a string', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/config/device').send({ role: 1, sourceId: [harness.sourceA] });
      expect(res.status).toBe(400);
      expectUntouched();
    });

    it('400s when the query sourceId is repeated', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/config/current?sourceId=${harness.sourceA}&sourceId=${harness.sourceB}`);
      expect(res.status).toBe(400);
      expectUntouched();
    });

    it('400s when a body route also carries a different sourceId in the query', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent
        .post(`/config/device?sourceId=${harness.sourceB}`)
        .send({ role: 1, sourceId: harness.sourceA });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_ID_CONFLICT');
      expectUntouched();
    });

    it('400s when a body route names its source only in the query', async () => {
      // The handler reads the body, so this request would act on the primary
      // while naming B. Refuse it instead of guessing.
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post(`/config/device?sourceId=${harness.sourceB}`).send({ role: 1 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_ID_CONFLICT');
      expectUntouched();
    });

    it('accepts the same sourceId in both places', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent
        .post(`/config/device?sourceId=${harness.sourceB}`)
        .send({ role: 1, sourceId: harness.sourceB });
      expect(res.status).toBe(200);
      expect(managerB.setDeviceConfig).toHaveBeenCalledWith({ role: 1 });
      expect(deviceCalls(managerA)).toBe(0);
    });

    it('does not pass sourceId to the device as config', async () => {
      const agent = await harness.loginAs(harness.admin);
      await send(agent, writeCase, harness.sourceB);
      expect(managerB.setDeviceConfig).toHaveBeenCalledWith({ role: 1 });
    });

    it('404s for a sourceId that names no source, instead of acting on the primary', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await send(agent, writeCase, 'no-such-source');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('SOURCE_NOT_FOUND');
      expectUntouched();
    });

    it('403s, not 404s, for an unknown sourceId the caller has no grant on', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, writeCase, 'no-such-source');
      expect(res.status).toBe(403);
      expectUntouched();
    });

    it('does not tell a caller without the grant that a source has no Meshtastic device', async () => {
      await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
      await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, writeCase, MQTT_SOURCE);
      expect(res.status).toBe(403);
      expectUntouched();
    });

    it('400s SOURCE_NOT_MESHTASTIC for a caller who may configure that non-device source', async () => {
      await sourceManagerRegistry.addManager(fakeManager(MQTT_SOURCE, 'mqtt_broker'));
      await harness.grant(harness.limited.id, 'configuration', 'write', MQTT_SOURCE);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, writeCase, MQTT_SOURCE);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
      expectUntouched();
    });

    it('409s SOURCE_NOT_CONNECTED for a permitted source whose device is offline', async () => {
      await sourceManagerRegistry.removeManager(harness.sourceB);
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, readCase, harness.sourceB);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
      expectUntouched();
    });

    it('with no Meshtastic source registered, a request with no sourceId 403s for a non-admin', async () => {
      await sourceManagerRegistry.removeManager(harness.sourceA);
      await sourceManagerRegistry.removeManager(harness.sourceB);
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await send(agent, readCase);
      expect(res.status).toBe(403);
    });

    it('accepts a Bearer token under the same per-source rule', async () => {
      await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
      const token = await harness.tokenFor(harness.limited);
      const agent = await harness.loginAs(null);
      const allowed = await agent.get('/config/current').query({ sourceId: harness.sourceA }).set('Authorization', `Bearer ${token}`);
      expect(allowed.status).toBe(200);
      const refused = await agent.get('/config/current').query({ sourceId: harness.sourceB }).set('Authorization', `Bearer ${token}`);
      expect(refused.status).toBe(403);
    });
  });
});

// ── Guard: no `configuration` route may be registered without a source ──────

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

type Verdict = 'scoped' | 'unscoped' | 'other-gate' | 'ungated';

/** How a route is gated for per-source resources. */
function verdict(route: RegisteredRoute): Verdict {
  if (route.handlers.some((h) => getDeviceSourceGate(h))) return 'scoped';
  const gates = route.handlers.map((h) => getPermissionGate(h)).filter((g) => g !== undefined);
  if (gates.length === 0) return 'ungated';
  if (gates.some((g) => isSourceyResource(g.resource) && !g.sourceScoped)) return 'unscoped';
  return gates.every((g) => g.sourceScoped) ? 'scoped' : 'other-gate';
}

const key = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

describe('guard: device-config routes are registered with a source-scoped gate', () => {
  const tableKeys = (router: RouteCase['router']): string[] =>
    CASES.filter((c) => c.router === router).map((c) => key(c.method, c.route)).sort();

  it('every /api/config route is scoped, except the public GET /', () => {
    const routes = registeredRoutes(configRoutes);
    const PUBLIC = ['GET /'];
    const notScoped = routes
      .filter((r) => verdict(r) !== 'scoped')
      .map((r) => key(r.method, r.path));
    // A new route here must use requireDeviceSourcePermission(). Do not add it
    // to PUBLIC unless it reads no device and needs no permission.
    expect(notScoped).toEqual(PUBLIC);
    // ...and must get a row in CASES above, so its scoping is tested.
    expect(routes.filter((r) => verdict(r) === 'scoped').map((r) => key(r.method, r.path)).sort()).toEqual(tableKeys('config'));
  });

  it('every device route is scoped', () => {
    const routes = registeredRoutes(deviceRoutes);
    expect(routes.filter((r) => verdict(r) !== 'scoped').map((r) => key(r.method, r.path))).toEqual([]);
    expect(routes.map((r) => key(r.method, r.path)).sort()).toEqual(tableKeys('device'));
  });

  it('every scoped route gates `configuration` and reads sourceId from the place the table says', () => {
    const routers: Record<RouteCase['router'], Router> = {
      config: configRoutes,
      device: deviceRoutes,
      channels: channelRoutes,
      backup: backupRouter,
    };
    for (const c of CASES) {
      const route = registeredRoutes(routers[c.router]).find((r) => key(r.method, r.path) === key(c.method, c.route));
      expect(route, label(c)).toBeDefined();
      const gate = route!.handlers.map((h) => getDeviceSourceGate(h)).find((g) => g !== undefined);
      expect(gate, label(c)).toEqual({ resource: 'configuration', action: c.action, from: c.from });
    }
  });

  it('the channel and backup routers have no unscoped `configuration` route beyond the known global ones', () => {
    const unscoped = (router: Router): string[] =>
      registeredRoutes(router)
        .filter((r) => verdict(r) === 'unscoped')
        .filter((r) => r.handlers.some((h) => getPermissionGate(h)?.resource === 'configuration'))
        .map((r) => key(r.method, r.path))
        .sort();

    // decode-url parses a URL the caller supplies. It touches no source.
    expect(unscoped(channelRoutes)).toEqual(['POST /decode-url']);
    // The saved-backup store on disk and its schedule are not per-source.
    expect(unscoped(backupRouter)).toEqual([
      'DELETE /delete/:filename',
      'GET /download/:filename',
      'GET /list',
      'GET /settings',
      'POST /settings',
    ]);
  });

  it('requirePermission records whether its check is tied to a source', async () => {
    const { requirePermission } = await import('../auth/authMiddleware.js');
    expect(getPermissionGate(requirePermission('configuration', 'write'))).toEqual({
      resource: 'configuration', action: 'write', sourceScoped: false,
    });
    expect(getPermissionGate(requirePermission('configuration', 'write', { sourceIdFrom: 'body' }))?.sourceScoped).toBe(true);
    expect(getPermissionGate(() => undefined)).toBeUndefined();
  });
});
