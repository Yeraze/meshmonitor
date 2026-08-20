/**
 * Source Routes — GET /:id/messages/:messageId/events (Delivery Diagnostics
 * epic #4816, Phase 3 WP3).
 *
 * Exercises the real per-source permission gate (optionalAuth +
 * requirePermission('messages','read', sourceIdFrom params.id)) and the real
 * SQL path through MessageEventsRepository via the createRouteTestApp harness —
 * no mocking of checkPermissionAsync (CLAUDE.md route-test rule).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

// Non-DB mocks: sourceRoutes.ts wires these at request time and they must not
// attempt real TCP connections in tests.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

describe('sourceRoutes — GET /:id/messages/:messageId/events', () => {
  let harness: RouteTestHarness;

  const MESSAGE_ID = 'msg-with-events';

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    // limited user may read messages on sourceA only.
    await harness.grant(harness.limited.id, 'messages', 'read', harness.sourceA);

    // Seed a couple of event rows on sourceA for MESSAGE_ID, out of chrono order
    // to prove the repo/route return them ascending by timestamp.
    await harness.db.messageEvents.recordEvent({
      sourceId: harness.sourceA,
      messageId: MESSAGE_ID,
      eventType: 'delivered',
      provenance: 'reported',
      timestamp: 2000,
    });
    await harness.db.messageEvents.recordEvent({
      sourceId: harness.sourceA,
      messageId: MESSAGE_ID,
      eventType: 'submitted',
      provenance: 'reported',
      timestamp: 1000,
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('returns 200 with the ordered event timeline for a granted source', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/messages/${MESSAGE_ID}/events`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.events)).toBe(true);
    expect(res.body.data.events).toHaveLength(2);
    // Chronological ascending by timestamp.
    expect(res.body.data.events.map((e: { eventType: string }) => e.eventType)).toEqual([
      'submitted',
      'delivered',
    ]);
  });

  it('returns 403 for a source the user lacks messages:read on', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceB}/messages/${MESSAGE_ID}/events`);

    expect(res.status).toBe(403);
  });

  it('returns 200 with an empty array for a message with no events', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(`/${harness.sourceA}/messages/no-such-message/events`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.events).toEqual([]);
  });
});
