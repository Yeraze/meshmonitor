/**
 * Anonymous sending is opt-in (#6499). Real auth and permission rows
 * (createRouteTestApp); the manager is a stub, so nothing reaches a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import nodesRoutes from './nodesRoutes.js';
import reticulumRoutes from './reticulumRoutes.js';
import { requireAnonymousSendAllowed } from '../utils/anonymousSendGate.js';
import { requirePermission } from '../auth/authMiddleware.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const { stubs } = vi.hoisted(() => ({ stubs: new Map<string, any>() }));

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => stubs.get(sourceId),
    getAllManagers: () => Array.from(stubs.values()),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn(),
  fallbackManager: { sourceId: 'fallback', getLocalNodeInfo: () => null, getAllNodesAsync: async () => [] },
}));

describe('anonymous sending opt-in (#6499)', () => {
  let h: RouteTestHarness;
  let send: ReturnType<typeof vi.fn>;
  const body = (h2: RouteTestHarness) => ({ text: 'hi', channel: 1, sourceId: h2.sourceA });

  beforeEach(async () => {
    h = await createRouteTestApp({
      mount: (app) => {
        app.use('/api/messages', messageRoutes);
        app.post(
          '/gated',
          requirePermission('messages', 'write', { sourceIdFrom: 'query' }),
          requireAnonymousSendAllowed(),
          (_req, res) => res.json({ reached: true }),
        );
      },
    });
    send = vi.fn(async () => undefined);
    stubs.clear();
    stubs.set(h.sourceA, { sourceId: h.sourceA, sourceType: 'meshtastic_tcp', sendTextMessage: send });
    await h.revokeAll(h.anonymous.id);
    await h.grant(h.anonymous.id, 'channel_1', 'write', h.sourceA);
    await h.grant(h.anonymous.id, 'messages', 'write', h.sourceA);
    await h.db.settings.setSetting('allowAnonymousSend', '0');
  });

  afterEach(async () => {
    await h.db.settings.setSetting('allowAnonymousSend', '0');
    await h.revokeAll(h.anonymous.id);
    vi.restoreAllMocks();
    await h.cleanup();
  });

  it('refuses an anonymous send with 401 when the setting is off, and sends nothing', async () => {
    const agent = await h.loginAs(null);
    const res = await agent.post('/api/messages/send').send(body(h));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses when the setting is absent', async () => {
    await h.db.settings.setSetting('allowAnonymousSend', '');
    const agent = await h.loginAs(null);
    const res = await agent.post('/api/messages/send').send(body(h));
    expect(res.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('with the setting on, an anonymous send proceeds when the grant allows it', async () => {
    await h.db.settings.setSetting('allowAnonymousSend', '1');
    const agent = await h.loginAs(null);
    const res = await agent.post('/api/messages/send').send(body(h));
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('with the setting on, an anonymous send without a grant is still 403', async () => {
    await h.db.settings.setSetting('allowAnonymousSend', '1');
    await h.revokeAll(h.anonymous.id);
    const agent = await h.loginAs(null);
    const res = await agent.post('/api/messages/send').send(body(h));
    expect(res.status).toBe(403);
    expect(send).not.toHaveBeenCalled();
  });

  it('a signed-in user is unchanged with the setting off', async () => {
    await h.grant(h.limited.id, 'channel_1', 'write', h.sourceA);
    const agent = await h.loginAs(h.limited);
    const res = await agent.post('/api/messages/send').send(body(h));
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('the gate middleware blocks anonymous and passes signed-in users (off)', async () => {
    const anon = await h.loginAs(null);
    const r1 = await anon.post(`/gated?sourceId=${h.sourceA}`);
    expect(r1.status).toBe(401);
    expect(r1.body.code).toBe('AUTH_REQUIRED');
    const user = await h.loginAs(h.admin);
    const r2 = await user.post(`/gated?sourceId=${h.sourceA}`);
    expect(r2.status).toBe(200);
    await h.db.settings.setSetting('allowAnonymousSend', 'true');
    const r3 = await anon.post(`/gated?sourceId=${h.sourceA}`);
    expect(r3.status).toBe(200);
  });

  it.each([
    ['nodes send-key-warning', nodesRoutes, '/nodes/:nodeId/send-key-warning', 'post'],
    ['reticulum POST /messages', reticulumRoutes, '/messages', 'post'],
    ['reticulum POST /propagation/sync', reticulumRoutes, '/propagation/sync', 'post'],
  ])('%s carries the anonymous-send gate', (_n, router, path, method) => {
    const layer = (router as unknown as { stack: any[] }).stack.find(
      (l) => l.route?.path === path && l.route.methods[method],
    );
    expect(layer).toBeTruthy();
    const names = layer.route.stack.map((l: any) => l.handle.name || '');
    // The gate is a closure returned by requireAnonymousSendAllowed().
    const probe = requireAnonymousSendAllowed();
    expect(layer.route.stack.some((l: any) => l.handle.toString() === probe.toString())).toBe(true);
    expect(names.length).toBeGreaterThan(0);
  });
});
