/**
 * POST /api/messages/send: rate limiter wiring and the send audit row (#3045).
 * Real auth and permission rows (createRouteTestApp); the manager is a stub,
 * so nothing reaches a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import messageRoutes from './messageRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';
import { messageLimiter } from '../middleware/rateLimiters.js';
import { TxDisabledError } from '../errors/txDisabledError.js';

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

describe('POST /api/messages/send audit (#3045)', () => {
  let h: RouteTestHarness;
  let audit: ReturnType<typeof vi.spyOn>;
  const mk = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshtastic_tcp' as const,
    sendTextMessage: vi.fn(async () => undefined),
  });
  const rows = () => audit.mock.calls.filter((c) => c[1] === 'message_sent');

  beforeEach(async () => {
    h = await createRouteTestApp({ mount: (app) => app.use('/api/messages', messageRoutes) });
    stubs.clear();
    stubs.set(h.sourceA, mk(h.sourceA));
    stubs.set(h.sourceB, mk(h.sourceB));
    audit = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });

  it('a channel send writes one message_sent row without the text', async () => {
    const agent = await h.loginAs(h.admin);
    const res = await agent
      .post('/api/messages/send')
      .send({ text: 'secret words', channel: 1, sourceId: h.sourceA, replyId: 42, emoji: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0][2]).toBe('messages');
    expect(JSON.parse(rows()[0][3] as string)).toMatchObject({
      sourceId: h.sourceA, kind: 'channel', channel: 1, destination: null, replyId: 42, tapback: true, via: 'api',
    });
    expect(String(rows()[0][3])).not.toContain('secret words');
    expect(String(rows()[0][3])).not.toMatch(/length|textBytes/i);
  });

  it('a DM send records the destination and kind dm', async () => {
    const agent = await h.loginAs(h.admin);
    const res = await agent
      .post('/api/messages/send')
      .send({ text: 'hi', destination: '!0a000002', sourceId: h.sourceA });
    expect(res.status).toBe(200);
    expect(JSON.parse(rows()[0][3] as string)).toMatchObject({ kind: 'dm', destination: '!0a000002' });
  });

  it('a limited user with a grant on A sending to B gets 403 and no row', async () => {
    await h.grant(h.limited.id, 'channel_1', 'write', h.sourceA);
    const agent = await h.loginAs(h.limited);
    const res = await agent.post('/api/messages/send').send({ text: 'hi', channel: 1, sourceId: h.sourceB });
    expect(res.status).toBe(403);
    expect(rows()).toHaveLength(0);
    expect(stubs.get(h.sourceB).sendTextMessage).not.toHaveBeenCalled();
  });

  it('TX disabled gives 409 and no row', async () => {
    stubs.get(h.sourceA).sendTextMessage.mockRejectedValueOnce(new TxDisabledError());
    const agent = await h.loginAs(h.admin);
    const res = await agent.post('/api/messages/send').send({ text: 'hi', channel: 1, sourceId: h.sourceA });
    expect(res.status).toBe(409);
    expect(rows()).toHaveLength(0);
  });

  it('a rejecting audit write still returns 200', async () => {
    audit.mockRejectedValue(new Error('db down'));
    const agent = await h.loginAs(h.admin);
    const res = await agent.post('/api/messages/send').send({ text: 'hi', channel: 1, sourceId: h.sourceA });
    expect(res.status).toBe(200);
  });

  it('wires messageLimiter on the route', () => {
    const layer = (messageRoutes as any).stack.find(
      (l: any) => l.route?.path === '/send' && l.route.methods.post,
    );
    expect(layer).toBeTruthy();
    expect(layer.route.stack.map((l: any) => l.handle)).toContain(messageLimiter);
  });
});
