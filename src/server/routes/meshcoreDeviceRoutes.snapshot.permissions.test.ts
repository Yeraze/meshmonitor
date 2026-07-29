/**
 * Route test — GET /sources/:id/meshcore/snapshot message-permission scoping
 * (issue #4422).
 *
 * `/snapshot` is gated only by `connection:read` (a viewer needs that just to
 * see the source at all), but its `messages` field carries DM content, which
 * has its own, stricter `messages:read` grant ("Node Details & DM"). Before
 * the fix, a caller with `connection:read` but not `messages:read` — e.g. an
 * anonymous user given view-only status access — received full message
 * content via this bundled payload.
 *
 * Uses the real-middleware harness (createRouteTestApp) per CLAUDE.md: real
 * express-session + real auth middleware + real checkPermissionAsync against
 * the singleton's `:memory:` SQLite DB. Only the source-manager registry is
 * mocked (non-DB) with a stub manager carrying one DM and one channel message.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const STUB_MESSAGES = [
  { id: 'm1', fromPublicKey: 'aaaa', toPublicKey: 'bbbb', text: 'secret dm', timestamp: 1000 },
];

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    getConnectionStatus: () => ({ connected: true, deviceType: 1, config: null }),
    getLocalNode: () => null,
    getContacts: () => [],
    getAllNodes: async () => [],
    getRecentMessages: (_limit?: number) => STUB_MESSAGES,
  });
  const managers = new Map([['rt-source-a', stubFor('rt-source-a')]]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

describe('meshcoreDeviceRoutes — GET /snapshot message-permission scoping (#4422)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const urlFor = (sourceId: string) => `/sources/${sourceId}/meshcore/snapshot`;

  it('omits messages when the caller has connection:read but not messages:read', async () => {
    await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(urlFor(harness.sourceA));

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toEqual([]);
    expect(res.body.data.seqCursor).toBe(0);
  });

  it('includes messages once messages:read is also granted', async () => {
    await harness.grant(harness.limited.id, 'connection', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(urlFor(harness.sourceA));

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.messages[0].text).toBe('secret dm');
    expect(res.body.data.seqCursor).toBe(1000);
  });

  it('admin sees messages regardless of explicit grants', async () => {
    const agent = await harness.loginAs(harness.admin);

    const res = await agent.get(urlFor(harness.sourceA));

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
  });

  it('anonymous (unauthenticated) caller without messages:read gets no messages', async () => {
    await harness.grant(harness.anonymous.id, 'connection', 'read', harness.sourceA);
    const agent = await harness.loginAs(null);

    const res = await agent.get(urlFor(harness.sourceA));

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toEqual([]);
  });
});
