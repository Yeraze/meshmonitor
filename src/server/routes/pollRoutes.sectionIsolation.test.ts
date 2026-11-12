/**
 * GET /poll: one failing section must not blank the others (#6342).
 *
 * The node load and the incremental (delta) serialiser used to sit outside the
 * per-section try blocks, so one throw there returned 500 for the whole reply
 * and the UI showed no nodes AND no channels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pollRoutes from './pollRoutes.js';
import databaseService from '../../services/database.js';
import { pollDeltaTracker } from '../services/pollDeltaTracker.js';
import { resolveSourceManager } from '../utils/resolveSourceManager.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
// Registers the real `fallbackManager` that resolveSourceManager() returns
// when no primary source is registered (the server loads it at startup).
import '../meshtasticManager.js';

describe('pollRoutes — section isolation (#6342)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    pollDeltaTracker.reset();
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', pollRoutes),
    });
    await databaseService.channels.upsertChannel({ id: 0, name: 'IsoPrimary', psk: 'AQ==', role: 1 }, harness.sourceA);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    pollDeltaTracker.reset();
    await harness.cleanup();
  });

  it('still returns channels when the node read throws', async () => {
    const manager = resolveSourceManager(harness.sourceA);
    const nodeRead = vi.spyOn(manager, 'getAllNodesAsync').mockRejectedValue(new Error('node read failed'));

    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get('/poll').query({ sourceId: harness.sourceA });

    expect(nodeRead).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect(res.body.deviceNodeNums).toEqual([]);
    expect(res.body.channels.map((c: { name: string }) => c.name)).toContain('IsoPrimary');
    expect(res.body).toHaveProperty('connection');
    expect(res.body).toHaveProperty('config');
  });

  it('falls back to a full reply when the delta serialiser throws, then recovers', async () => {
    const apply = vi.spyOn(pollDeltaTracker, 'apply').mockImplementationOnce(() => {
      throw new Error('delta failed');
    });
    const agent = await harness.loginAs(harness.admin);

    const first = await agent.get('/poll').query({ sourceId: harness.sourceA, cursor: '' });
    expect(first.status).toBe(200);
    expect(first.body.channels.map((c: { name: string }) => c.name)).toContain('IsoPrimary');
    // A full reply: no cursor, so the client drops its base and reads in full.
    expect(first.body).not.toHaveProperty('pollCursor');
    expect(first.body).not.toHaveProperty('pollDelta');

    // The next (empty-cursor) read goes through the tracker again as normal.
    const second = await agent.get('/poll').query({ sourceId: harness.sourceA, cursor: '' });
    expect(second.status).toBe(200);
    expect(typeof second.body.pollCursor).toBe('string');
    expect(second.body.channels.map((c: { name: string }) => c.name)).toContain('IsoPrimary');
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('fails closed to the no-user view when the grant load throws', async () => {
    const grantRead = vi.spyOn(databaseService, 'getChannelDatabasePermissionsForUserAsSetAsync').mockRejectedValue(new Error('grant read failed'));
    await harness.grant(harness.limited.id, 'channel_0', 'read', harness.sourceA);

    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/poll').query({ sourceId: harness.sourceA });

    expect(grantRead).toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(res.body.nodes).toEqual([]);
    expect(res.body.channels ?? []).toEqual([]);
    expect(res.body).toHaveProperty('connection');
  });
});
