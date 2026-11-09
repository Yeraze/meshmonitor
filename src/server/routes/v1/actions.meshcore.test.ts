/**
 * v1 actions on a MeshCore source (#6263 WP4): fire-and-forget trace with a
 * sync pre-check, request-telemetry for both protocols (one handler), the 60 s
 * per-source gate (429 + Retry-After), unsupported actions (400), and the
 * shared limiter bucket with the UI. Real auth + permission rows; managers and
 * the telemetry scheduler are stubs. No RF.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const registry = vi.hoisted(() => ({ managers: new Map<string, unknown>() }));
const limiterCalls = vi.hoisted(() => ({ meshcore: 0 }));
const scheduler = vi.hoisted(() => ({
  current: null as null | { requestTelemetryForNode: (...a: unknown[]) => Promise<unknown> },
}));
const mtTelemetry = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => registry.managers.get(id),
    getAllManagers: () => [...registry.managers.values()],
  },
}));
vi.mock('../../meshtasticManager.js', () => ({ default: {}, fallbackManager: {} }));
vi.mock('../../messageQueueService.js', () => ({ messageQueueService: {} }));
vi.mock('../../middleware/rateLimiters.js', async (orig) => {
  const actual = await orig<typeof import('../../middleware/rateLimiters.js')>();
  return {
    ...actual,
    // Same instance the UI routes import; count every pass through it.
    meshcoreDeviceLimiter: (_q: unknown, _r: unknown, next: () => void) => { limiterCalls.meshcore++; next(); },
  };
});
vi.mock('../../services/meshcoreRemoteTelemetryScheduler.js', async (orig) => {
  const actual = await orig<typeof import('../../services/meshcoreRemoteTelemetryScheduler.js')>();
  return { ...actual, getMeshCoreRemoteTelemetryScheduler: () => scheduler.current };
});
vi.mock('../meshRequestRoutes.js', () => ({ default: {}, requestMeshtasticTelemetry: mtTelemetry.fn }));

import databaseService from '../../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import actionsRouter from './actions.js';
import { MeshCoreDeviceType } from '../../meshcoreManager.js';

const MC = 'wp4a-mc-source';
const MQ = 'wp4a-mcmqtt-source';
const PK = 'cd'.repeat(32);

const makeStub = (over: Record<string, unknown> = {}) => ({
  sourceType: 'meshcore',
  isReceiveOnly: vi.fn(() => false),
  isConnected: vi.fn(() => true),
  getConnectionStatus: vi.fn(() => ({ connected: true, deviceType: MeshCoreDeviceType.COMPANION, config: null })),
  getContact: vi.fn(() => ({ publicKey: PK })),
  traceContactPathDetailed: vi.fn(async () => ({ ok: true, hops: [], lastSnr: 0, path: [] })),
  getLastMeshTxAt: vi.fn(() => 0),
  recordMeshTx: vi.fn(),
  ...over,
});

describe('v1 actions — MeshCore source', () => {
  let h: RouteTestHarness;
  let user: { id: number; username: string; isAdmin: boolean };
  let stub: ReturnType<typeof makeStub>;

  const wipe = async () => {
    await databaseService.sources.deleteSource(MC).catch(() => {});
    await databaseService.sources.deleteSource(MQ).catch(() => {});
  };
  const post = (action: string, body: unknown, sourceId = MC) =>
    request(h.app).post(`/v1/sources/${sourceId}/actions/${action}`).send(body as object);

  beforeEach(async () => {
    registry.managers.clear();
    limiterCalls.meshcore = 0;
    mtTelemetry.fn.mockReset();
    scheduler.current = { requestTelemetryForNode: vi.fn(async () => ({ written: 2, sources: ['status', 'lpp'] })) };
    h = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use((req: any, _res: any, next: any) => { req.user = user; next(); });
        app.use('/v1/sources/:sourceId/actions', actionsRouter);
      },
    });
    user = h.admin;
    await wipe();
    await databaseService.sources.createSource({ id: MC, name: 'MC', type: 'meshcore', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: MQ, name: 'MQ', type: 'meshcore_mqtt', config: {}, enabled: true });
    stub = makeStub();
    registry.managers.set(MC, stub);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await wipe();
    await h.cleanup();
  });

  describe('traceroute', () => {
    it('pre-check passes: 200 immediately, trace runs in the background without return leg', async () => {
      let release!: () => void;
      stub.traceContactPathDetailed.mockImplementation(() => new Promise((r) => { release = () => r({ ok: true }); }) as never);
      const res = await post('traceroute', { destination: `mc:${PK}` }).expect(200);
      expect(res.body.data).toEqual({
        destination: `mc:${PK}`, channel: null, message: 'Traceroute request sent', protocol: 'meshcore',
      });
      // The response came back while the trace is still pending.
      expect(stub.traceContactPathDetailed).toHaveBeenCalledWith(PK, { autoReturn: false, origin: 'api' });
      release();
    });

    it('409 MESHCORE_TRACE_FAILED when not a Companion or the contact is unknown (nothing sent)', async () => {
      stub.getConnectionStatus.mockReturnValue({ connected: true, deviceType: MeshCoreDeviceType.REPEATER, config: null });
      let res = await post('traceroute', { destination: PK }).expect(409);
      expect(res.body.code).toBe('MESHCORE_TRACE_FAILED');
      stub.getConnectionStatus.mockReturnValue({ connected: true, deviceType: MeshCoreDeviceType.COMPANION, config: null });
      stub.getContact.mockReturnValue(undefined as never);
      res = await post('traceroute', { destination: PK }).expect(409);
      expect(res.body.code).toBe('MESHCORE_TRACE_FAILED');
      expect(stub.traceContactPathDetailed).not.toHaveBeenCalled();
    });

    it('a background failure is swallowed (no unhandled rejection)', async () => {
      stub.traceContactPathDetailed.mockRejectedValue(new Error('boom'));
      await post('traceroute', { destination: PK }).expect(200);
      await new Promise((r) => setTimeout(r, 10));
    });

    it('400 for a missing/Meshtastic-style destination; 409 receive-only; 503 disconnected', async () => {
      await post('traceroute', {}).expect(400);
      await post('traceroute', { destination: '!a1b2c3d4' }).expect(400);
      stub.isReceiveOnly.mockReturnValue(true);
      expect((await post('traceroute', { destination: PK }).expect(409)).body.code).toBe('TX_DISABLED');
      stub.isReceiveOnly.mockReturnValue(false);
      stub.isConnected.mockReturnValue(false);
      await post('traceroute', { destination: PK }).expect(503);
    });

    it('meshcore_mqtt source: 400 SOURCE_NOT_MESHTASTIC', async () => {
      registry.managers.set(MQ, { sourceType: 'meshcore_mqtt' });
      const res = await post('traceroute', { destination: PK }, MQ).expect(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
    });

    it('needs traceroute:write on the source', async () => {
      user = h.limited;
      await h.revokeAll(h.limited.id);
      await databaseService.auth.createPermission({
        userId: h.limited.id, resource: 'messages', canRead: true, canWrite: true, canViewOnMap: false,
        sourceId: MC, grantedAt: Date.now(), grantedBy: null,
      } as never);
      await post('traceroute', { destination: PK }).expect(403);
    });
  });

  describe('request-telemetry', () => {
    it('MeshCore: status poll through the shared function, recordMeshTx stamped before the request', async () => {
      const order: string[] = [];
      stub.recordMeshTx.mockImplementation(() => { order.push('stamp'); });
      scheduler.current = {
        requestTelemetryForNode: vi.fn(async () => { order.push('request'); return { written: 1, sources: ['status'] }; }),
      };
      const res = await post('request-telemetry', { destination: `mc:${PK}`, type: 'status' }).expect(200);
      expect(res.body.data).toMatchObject({ destination: `mc:${PK}`, type: 'status', written: 1, protocol: 'meshcore' });
      expect(order).toEqual(['stamp', 'request']);
      expect(scheduler.current!.requestTelemetryForNode).toHaveBeenCalledWith(
        stub, expect.objectContaining({ publicKey: PK }), { includeStatus: true, includeLpp: false },
      );
    });

    it('MeshCore: inside the 60 s gate answers 429 with Retry-After and sends nothing', async () => {
      stub.getLastMeshTxAt.mockReturnValue(Date.now() - 20_000);
      const res = await post('request-telemetry', { destination: PK, type: 'lpp' }).expect(429);
      const retry = Number(res.headers['retry-after']);
      expect(retry).toBeGreaterThan(30);
      expect(retry).toBeLessThanOrEqual(40);
      expect(res.body.code).toBe('RATE_LIMITED');
      expect(stub.recordMeshTx).not.toHaveBeenCalled();
      expect(scheduler.current!.requestTelemetryForNode).not.toHaveBeenCalled();
    });

    it('MeshCore: type must be status or lpp; disconnected is 503; receive-only is 409', async () => {
      await post('request-telemetry', { destination: PK }).expect(400);
      await post('request-telemetry', { destination: PK, type: 'device' }).expect(400);
      stub.isReceiveOnly.mockReturnValue(true);
      await post('request-telemetry', { destination: PK, type: 'lpp' }).expect(409);
      stub.isReceiveOnly.mockReturnValue(false);
      stub.isConnected.mockReturnValue(false);
      await post('request-telemetry', { destination: PK, type: 'lpp' }).expect(503);
    });

    it('needs messages:write', async () => {
      user = h.limited;
      await h.revokeAll(h.limited.id);
      await databaseService.auth.createPermission({
        userId: h.limited.id, resource: 'traceroute', canRead: true, canWrite: true, canViewOnMap: false,
        sourceId: MC, grantedAt: Date.now(), grantedBy: null,
      } as never);
      await post('request-telemetry', { destination: PK, type: 'lpp' }).expect(403);
    });

    it('Meshtastic: same endpoint calls the shared sender with the node number and type', async () => {
      const MT = h.sourceA;
      registry.managers.set(MT, { sourceType: 'meshtastic_tcp' });
      mtTelemetry.fn.mockResolvedValue({
        kind: 'sent', destinationNum: 0xa1b2c3d4, channel: 0, packetId: 1, requestId: 2, typeLabel: 'environment',
      });
      const res = await post('request-telemetry', { destination: '!a1b2c3d4', type: 'environment' }, MT).expect(200);
      expect(res.body.data).toMatchObject({
        destination: '!a1b2c3d4', channel: 0, type: 'environment', protocol: 'meshtastic',
      });
      expect(mtTelemetry.fn).toHaveBeenCalledWith(expect.objectContaining({
        sourceId: MT, destination: 0xa1b2c3d4, telemetryType: 'environment',
      }));
    });

    it('Meshtastic: an invalid type from the shared sender is 400', async () => {
      const MT = h.sourceA;
      registry.managers.set(MT, { sourceType: 'meshtastic_tcp' });
      mtTelemetry.fn.mockResolvedValue({ kind: 'invalid', message: 'Invalid telemetry type.' });
      await post('request-telemetry', { destination: '!a1b2c3d4', type: 'nope' }, MT).expect(400);
    });
  });

  it('unsupported actions on MeshCore answer 400 SOURCE_NOT_MESHTASTIC', async () => {
    for (const action of ['request-position', 'request-nodeinfo', 'request-neighbors']) {
      const res = await post(action, { destination: 4_000_000_000 }).expect(400);
      expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
    }
  });

  it('traceroute and request-telemetry pass through the UI meshcoreDeviceLimiter instance; Meshtastic does not', async () => {
    await post('traceroute', { destination: PK }).expect(200);
    await post('request-telemetry', { destination: PK, type: 'lpp' }).expect(200);
    expect(limiterCalls.meshcore).toBe(2);

    const MT = h.sourceA;
    registry.managers.set(MT, { sourceType: 'meshtastic_tcp' });
    mtTelemetry.fn.mockResolvedValue({ kind: 'invalid', message: 'x' });
    await post('request-telemetry', { destination: '!a1b2c3d4' }, MT);
    expect(limiterCalls.meshcore).toBe(2);
  });
});
