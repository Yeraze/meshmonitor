/**
 * v1 POST /messages on a MeshCore source (#6263 WP4): permission matrix, byte
 * limits (413), TX disabled (409), not connected (503), unsupported source
 * (400), and the mesh-impact guarantee that a v1 send never arms the manager's
 * auto-retry or reaches the auto-responder / acknowledge / forwarding tail.
 * Real auth + permission rows (createRouteTestApp); the manager is a stub, or a
 * real MeshCoreManager with a stubbed bridge for the self-origin test. No RF.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const registry = vi.hoisted(() => ({
  managers: new Map<string, unknown>(),
}));
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (id: string) => registry.managers.get(id),
    getAllManagers: () => [...registry.managers.values()],
  },
}));
vi.mock('../../meshtasticManager.js', () => ({ default: {}, fallbackManager: {} }));
vi.mock('../../messageQueueService.js', () => ({ messageQueueService: {} }));

import databaseService from '../../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import { attachSource } from './sourceParam.js';
import messagesRouter from './messages.js';
import { VALIDATION } from '../meshcoreRouteShared.js';
import { MeshCoreManager, MeshCoreDeviceType } from '../../meshcoreManager.js';

const MC = 'wp4-mc-source';
const MQ = 'wp4-mcmqtt-source';
const PK = 'ab'.repeat(32);

const makeStub = (over: Record<string, unknown> = {}) => ({
  sourceType: 'meshcore',
  isReceiveOnly: vi.fn(() => false),
  isConnected: vi.fn(() => true),
  sendMessageWithResult: vi.fn(async () => ({ ok: true, message: { id: `${MC}_row1` } })),
  ...over,
});

describe('v1 POST /messages — MeshCore source', () => {
  let h: RouteTestHarness;
  let user: { id: number; username: string; isAdmin: boolean };
  let stub: ReturnType<typeof makeStub>;

  const wipe = async () => {
    await databaseService.sources.deleteSource(MC).catch(() => {});
    await databaseService.sources.deleteSource(MQ).catch(() => {});
  };
  const post = (body: unknown, sourceId = MC) => request(h.app).post(`/v1/sources/${sourceId}/messages`).send(body as object);
  const grant = async (resource: string, acts: Array<'read' | 'write'>) => {
    await databaseService.auth.createPermission({
      userId: h.limited.id, resource,
      canRead: acts.includes('read'), canWrite: acts.includes('write'), canViewOnMap: false,
      sourceId: MC, grantedAt: Date.now(), grantedBy: null,
    } as never);
  };

  beforeEach(async () => {
    registry.managers.clear();
    h = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use((req: any, _res: any, next: any) => { req.user = user; next(); });
        app.use('/v1/sources/:sourceId/messages', attachSource('messages', 'read'), messagesRouter);
      },
    });
    user = h.limited;
    await wipe();
    await databaseService.sources.createSource({ id: MC, name: 'MC', type: 'meshcore', config: {}, enabled: true });
    await databaseService.sources.createSource({ id: MQ, name: 'MQ', type: 'meshcore_mqtt', config: {}, enabled: true });
    stub = makeStub();
    registry.managers.set(MC, stub);
    await h.revokeAll(h.limited.id);
    await grant('messages', ['read']);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await wipe();
    await h.cleanup();
  });

  it('DM needs messages:write; with it the send is 201 with MeshCore keys and autoRetryOnMiss=false', async () => {
    await post({ text: 'hi', toNodeId: `mc:${PK}` }).expect(403);
    expect(stub.sendMessageWithResult).not.toHaveBeenCalled();

    await h.revokeAll(h.limited.id);
    await grant('messages', ['read', 'write']);
    const res = await post({ text: ' hi ', toNodeId: `mc:${PK}` }).expect(201);
    expect(res.body.data).toMatchObject({
      messageId: `${MC}_row1`, requestId: null, deliveryState: 'pending', messageCount: 1,
      text: 'hi', channel: -1, toNodeId: `mc:${PK}`, protocol: 'meshcore',
    });
    // (text, toPublicKey, channelIdx, scope, autoRetryOnMiss)
    expect(stub.sendMessageWithResult).toHaveBeenCalledWith('hi', PK, undefined, undefined, false);
  });

  it('bare 64-hex toNodeId is accepted and lower-cased', async () => {
    await h.revokeAll(h.limited.id);
    await grant('messages', ['read', 'write']);
    await post({ text: 'hi', toNodeId: PK.toUpperCase() }).expect(201);
    expect(stub.sendMessageWithResult.mock.calls[0][1]).toBe(PK);
  });

  it('channel send needs write on that slot (slot > 7 works) and passes scope', async () => {
    await post({ text: 'hi', channel: 12 }).expect(403);
    await h.revokeAll(h.limited.id);
    await grant('messages', ['read']);
    await grant('channel_1', ['write']);
    await post({ text: 'hi', channel: 12 }).expect(403);
    await post({ text: 'hi', channel: 1, scope: 'usa' }).expect(201);
    expect(stub.sendMessageWithResult).toHaveBeenLastCalledWith('hi', undefined, 1, 'usa', false);

    // legacy messages:write opens every slot (UI parity)
    await h.revokeAll(h.limited.id);
    await grant('messages', ['read', 'write']);
    const res = await post({ text: 'hi', channel: 12 }).expect(201);
    expect(res.body.data).toMatchObject({ channel: 12, toNodeId: 'broadcast', protocol: 'meshcore' });
  });

  it('admin skips the grant check', async () => {
    user = h.admin;
    await post({ text: 'hi', channel: 3 }).expect(201);
  });

  it('validates the body: 400 for missing text, both/neither target, bad channel/key/scope', async () => {
    user = h.admin;
    await post({ channel: 0 }).expect(400);
    await post({ text: 'x', channel: 0, toNodeId: `mc:${PK}` }).expect(400);
    await post({ text: 'x' }).expect(400);
    await post({ text: 'x', channel: 256 }).expect(400);
    await post({ text: 'x', channel: -1 }).expect(400);
    await post({ text: 'x', toNodeId: '!a1b2c3d4' }).expect(400);
    await post({ text: 'x', channel: 0, scope: 'x'.repeat(64) }).expect(400);
    await post({ text: 'x', toNodeId: PK, scope: 'usa' }).expect(400);
    expect(stub.sendMessageWithResult).not.toHaveBeenCalled();
  });

  it('413 over the per-context byte limits (DM, channel, scoped channel); not split', async () => {
    user = h.admin;
    const dm = 'a'.repeat(VALIDATION.MAX_MESSAGE_BYTES_DM + 1);
    const ch = 'a'.repeat(VALIDATION.MAX_MESSAGE_BYTES_CHANNEL + 1);
    const sc = 'a'.repeat(VALIDATION.MAX_MESSAGE_BYTES_CHANNEL_SCOPED + 1);
    await post({ text: dm, toNodeId: PK }).expect(413);
    await post({ text: ch, channel: 0 }).expect(413);
    await post({ text: sc, channel: 0, scope: 'usa' }).expect(413);
    await post({ text: 'a'.repeat(VALIDATION.MAX_MESSAGE_BYTES_DM), toNodeId: PK }).expect(201);
    expect(stub.sendMessageWithResult).toHaveBeenCalledTimes(1);
  });

  it('409 TX_DISABLED when receive-only; 503 when not connected', async () => {
    user = h.admin;
    stub.isReceiveOnly.mockReturnValue(true);
    const a = await post({ text: 'x', channel: 0 }).expect(409);
    expect(a.body.code).toBe('TX_DISABLED');
    stub.isReceiveOnly.mockReturnValue(false);
    stub.isConnected.mockReturnValue(false);
    await post({ text: 'x', channel: 0 }).expect(503);
    expect(stub.sendMessageWithResult).not.toHaveBeenCalled();
  });

  it('a TxDisabledError raised mid-send maps to 409', async () => {
    user = h.admin;
    const { TxDisabledError } = await import('../../errors/txDisabledError.js');
    stub.sendMessageWithResult.mockRejectedValue(new TxDisabledError());
    const res = await post({ text: 'x', channel: 0 }).expect(409);
    expect(res.body.code).toBe('TX_DISABLED');
  });

  it('meshcore_mqtt source has no radio: 400 SOURCE_NOT_MESHTASTIC', async () => {
    user = h.admin;
    registry.managers.set(MQ, { sourceType: 'meshcore_mqtt' });
    const res = await post({ text: 'x', channel: 0 }, MQ).expect(400);
    expect(res.body.code).toBe('SOURCE_NOT_MESHTASTIC');
  });

  it('a registered-nowhere MeshCore source answers 409 SOURCE_NOT_CONNECTED', async () => {
    user = h.admin;
    registry.managers.delete(MC);
    const res = await post({ text: 'x', channel: 0 }).expect(409);
    expect(res.body.code).toBe('SOURCE_NOT_CONNECTED');
  });

  describe('self-origin: a v1 send never reaches the auto-reply tail', () => {
    it('real manager: no retry armed, no auto-responder / acknowledge / forwarding, one bridge send', async () => {
      user = h.admin;
      const real = new MeshCoreManager(MC);
      (real as any).deviceType = MeshCoreDeviceType.COMPANION;
      (real as any).connected = true;
      const bridge: Array<{ cmd: string; params: Record<string, unknown> }> = [];
      (real as any).sendBridgeCommand = async (cmd: string, params: Record<string, unknown>) => {
        bridge.push({ cmd, params });
        return { id: '1', success: true, data: {} };
      };
      const spies = ['checkAutoResponder', 'checkAutoAcknowledge', 'checkForwarding', 'deliverReceivedMessage']
        .map((m) => vi.spyOn(real as any, m).mockResolvedValue(undefined));
      // Retry opt-in ON: a sender that asked for retry would arm the machine.
      vi.spyOn(databaseService.settings, 'getSettingAsBoolean').mockResolvedValue(true);
      registry.managers.set(MC, real);

      await post({ text: 'hello mesh', channel: 0 }).expect(201);
      await new Promise((r) => setTimeout(r, 20));

      expect(bridge.filter((c) => c.cmd === 'send_message')).toHaveLength(1);
      expect((real as any).pendingChannelRetries.size).toBe(0);
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    });
  });
});
