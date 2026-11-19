/**
 * POST /api/v1/messages writes the same text-free send audit row as
 * POST /api/messages/send (#6499). Real auth and permission rows; the manager
 * is a stub, so nothing reaches a radio.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { stubs } = vi.hoisted(() => ({ stubs: new Map<string, any>() }));

vi.mock('../../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn(),
  fallbackManager: { sourceId: 'fallback' },
}));
vi.mock('../../meshcoreManager.js', () => ({ default: {} }));
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (sourceId: string) => stubs.get(sourceId),
    getAllManagers: () => Array.from(stubs.values()),
  },
}));
vi.mock('../../messageQueueService.js', () => ({ messageQueueService: {} }));
vi.mock('../../middleware/rateLimiters.js', () => ({
  messageLimiter: (_req: any, _res: any, next: any) => next(),
  translateLimiter: (_req: any, _res: any, next: any) => next(),
}));

import databaseService from '../../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../../test-helpers/routeTestApp.js';
import v1Messages from './messages.js';
import { attachSource } from './sourceParam.js';

describe('v1 POST /messages audit (#6499)', () => {
  let h: RouteTestHarness;
  let audit: ReturnType<typeof vi.spyOn>;
  const rows = () => audit.mock.calls.filter((c) => c[1] === 'message_sent');

  beforeEach(async () => {
    h = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        app.use((req: any, _res: any, next: any) => {
          req.user = h.admin;
          next();
        });
        app.use('/v1/sources/:sourceId/messages', attachSource('messages', 'write'), v1Messages);
      },
    });
    stubs.clear();
    stubs.set(h.sourceA, {
      sourceId: h.sourceA,
      sourceType: 'meshtastic_tcp',
      sendTextMessage: vi.fn(async () => 7),
    });
    audit = vi.spyOn(databaseService, 'auditLogAsync').mockResolvedValue(undefined as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.cleanup();
  });

  it('a send writes one message_sent row with via v1 and no text', async () => {
    const agent = await h.loginAs(h.admin);
    const res = await agent
      .post(`/v1/sources/${h.sourceA}/messages`)
      .send({ text: 'secret words', channel: 1, sourceId: h.sourceA, replyId: 5 });
    expect(res.status).toBe(201);
    expect(rows()).toHaveLength(1);
    expect(rows()[0][2]).toBe('messages');
    expect(JSON.parse(rows()[0][3] as string)).toEqual({
      sourceId: h.sourceA, kind: 'channel', channel: 1, destination: null, replyId: 5, tapback: false, via: 'v1',
    });
    expect(String(rows()[0][3])).not.toContain('secret words');
  });

  it('a DM records the destination', async () => {
    const agent = await h.loginAs(h.admin);
    const res = await agent.post(`/v1/sources/${h.sourceA}/messages`).send({ text: 'hi', toNodeId: '!0a000002', sourceId: h.sourceA });
    expect(res.status).toBe(201);
    expect(JSON.parse(rows()[0][3] as string)).toMatchObject({ kind: 'dm', destination: '!0a000002', via: 'v1' });
  });

  it('a rejecting audit write still returns success', async () => {
    audit.mockRejectedValue(new Error('db down'));
    const agent = await h.loginAs(h.admin);
    const res = await agent.post(`/v1/sources/${h.sourceA}/messages`).send({ text: 'hi', channel: 1, sourceId: h.sourceA });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('a failed send writes no row', async () => {
    stubs.get(h.sourceA).sendTextMessage.mockRejectedValueOnce(new Error('boom'));
    const agent = await h.loginAs(h.admin);
    const res = await agent.post(`/v1/sources/${h.sourceA}/messages`).send({ text: 'hi', channel: 1, sourceId: h.sourceA });
    expect(res.status).toBe(500);
    expect(rows()).toHaveLength(0);
  });
});
