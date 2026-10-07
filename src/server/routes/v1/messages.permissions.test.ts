/**
 * v1 messages — sourceId permission scoping tests
 *
 * Real-middleware harness (createRouteTestApp) and real permission rows.
 *
 * Route profile: GET /api/v1/sources/:sourceId/messages
 *   - `attachSource('messages', 'read')` checks the grant on the source in the
 *     path; the handler then narrows to the channels readable ON THAT SOURCE,
 *     from one load of the user's grants.
 *   - A mount with no source is refused: the handler used to fall back to
 *     grants merged across every source.
 *   - Sets req.user from requireAPIToken in production; simulated via a mount
 *     middleware here (useOptionalAuth: false).
 *
 * See src/server/test-helpers/routeTestApp.ts for the design rationale.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

// Non-DB mocks stay: these modules make external node connections or require
// hardware state that must not run in unit tests.
vi.mock('../../meshtasticManager.js', () => ({ default: {} }));
vi.mock('../../meshcoreManager.js', () => ({ default: {} }));
vi.mock('../../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: { getManager: vi.fn() },
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

describe('v1 messages — sourceId scoping', () => {
  let harness: RouteTestHarness;
  let globalPermSpy: ReturnType<typeof vi.spyOn>;
  let grantsSpy: ReturnType<typeof vi.spyOn>;

  const seedMessage = (sourceId: string, id: string, channel: number): Promise<unknown> =>
    databaseService.messages.insertMessage(
      {
        id, fromNodeNum: 1, toNodeNum: 0xffffffff, fromNodeId: '!00000001', toNodeId: '!ffffffff',
        text: `text ${id}`, channel, portnum: 1, timestamp: Date.now(), rxTime: Date.now(), createdAt: Date.now(),
      } as never,
      sourceId,
    );

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => {
        // Simulate requireAPIToken: set req.user so the handler can read
        // the user without touching the session.
        app.use((req: any, _res: any, next: any) => {
          req.user = harness.limited;
          next();
        });
        // The production wiring: attachSource, then the mergeParams router.
        app.use('/v1/sources/:sourceId/messages', attachSource('messages', 'read'), v1Messages);
        // No source and no attachSource: must be refused.
        app.use('/v1/messages', v1Messages);
      },
    });

    // messages:read + channel_0:read on sourceA. On sourceB: messages:read
    // only, so the route opens but no channel is readable there.
    await harness.grant(harness.limited.id, 'messages',  'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'messages',  'read', harness.sourceB);

    await seedMessage(harness.sourceA, 'perm-a-ch0', 0);
    await seedMessage(harness.sourceA, 'perm-a-ch1', 1);
    await seedMessage(harness.sourceB, 'perm-b-ch0', 0);

    globalPermSpy = vi.spyOn(databaseService, 'getUserPermissionSetAsync');
    grantsSpy = vi.spyOn(databaseService.auth, 'getPermissionsForUser');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await databaseService.messages.deleteAllMessages(harness.sourceA);
    await databaseService.messages.deleteAllMessages(harness.sourceB);
    await harness.cleanup();
  });

  it('GET /sources/sourceA/messages returns the channels readable on sourceA, from one grants load', async () => {
    const res = await request(harness.app).get(`/v1/sources/${harness.sourceA}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.data.map((m: { id: string }) => m.id)).toEqual(['perm-a-ch0']);
    // Two reads of the grants: attachSource's check at the door and the
    // handler's one load. None per channel (it used to be nine), and never
    // the set merged across sources.
    expect(grantsSpy).toHaveBeenCalledTimes(2);
    expect(globalPermSpy).not.toHaveBeenCalled();
  });

  it('a channel grant on sourceA does not open the same channel on sourceB', async () => {
    const res = await request(harness.app).get(`/v1/sources/${harness.sourceB}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain('perm-b-ch0');
  });

  it('403s on a source the user holds no messages:read on', async () => {
    await harness.revokeAll(harness.limited.id);
    await harness.grant(harness.limited.id, 'messages',  'read', harness.sourceA);

    const res = await request(harness.app).get(`/v1/sources/${harness.sourceB}/messages`);

    expect(res.status).toBe(403);
  });

  it('GET with no source is refused instead of reading every source with merged grants', async () => {
    const res = await request(harness.app).get('/v1/messages');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MISSING_SOURCE_ID');
    expect(globalPermSpy).not.toHaveBeenCalled();
  });
});
