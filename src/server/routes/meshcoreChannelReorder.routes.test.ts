/**
 * Route test — POST /sources/:id/meshcore/channels/reorder (#5379).
 *
 * Real-middleware harness (createRouteTestApp): real session + auth + real
 * permission rows in the singleton's :memory: SQLite. Only the source-manager
 * registry is mocked, with a stub whose `reorderChannels` is a spy.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import meshcoreRoutes from './meshcoreRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { ChannelReorderPlanError } from '../meshcoreChannelReorder.js';

const { reorderMock } = vi.hoisted(() => ({ reorderMock: vi.fn() }));

vi.mock('../sourceManagerRegistry.js', () => {
  const stubFor = (sourceId: string) => ({
    sourceId,
    sourceType: 'meshcore' as const,
    reorderChannels: reorderMock,
    isReceiveOnly: () => false,
    canTransmit: () => true,
  });
  const managers = new Map([
    ['rt-source-a', stubFor('rt-source-a')],
    ['rt-source-b', stubFor('rt-source-b')],
  ]);
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => managers.get(sourceId),
      getAllManagers: () => Array.from(managers.values()),
    },
  };
});

const APPLIED = {
  status: 'applied',
  moves: [{ from: 2, to: 1 }, { from: 1, to: 2 }],
  writes: 4,
  remap: {
    messages: 3, channels: 2, readMarkers: 1, permissionsMoved: 0, permissionsDropped: 0,
    settingsUpdated: [], appliedMoves: [{ from: 2, to: 1 }, { from: 1, to: 2 }], automationsToReview: [],
  },
};

describe('POST /sources/:id/meshcore/channels/reorder', () => {
  let harness: RouteTestHarness;
  const url = (sid: string) => `/sources/${sid}/meshcore/channels/reorder`;

  beforeEach(async () => {
    reorderMock.mockReset();
    reorderMock.mockResolvedValue(APPLIED);
    harness = await createRouteTestApp({
      mount: (app) => app.use('/sources/:id/meshcore', meshcoreRoutes),
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('rejects an anonymous caller', async () => {
    const anon = await harness.loginAs(null);
    const res = await anon.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(res.status).toBe(401);
    expect(reorderMock).not.toHaveBeenCalled();
  });

  it('requires configuration:write on THIS source', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceB);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(res.status).toBe(403);
    expect(reorderMock).not.toHaveBeenCalled();
  });

  it('also requires write on every channel slot 1-7 it moves', async () => {
    await harness.grant(harness.limited.id, 'configuration', 'write', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_1', 'write', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const denied = await agent.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(denied.status).toBe(403);
    expect(denied.body.required).toEqual({ resource: 'channel_2', action: 'write' });
    expect(reorderMock).not.toHaveBeenCalled();

    await harness.grant(harness.limited.id, 'channel_2', 'write', harness.sourceA);
    const allowed = await agent.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ success: true, data: APPLIED });
    expect(reorderMock).toHaveBeenCalledWith([2, 1]);
  });

  it('validates the order body before touching the device', async () => {
    const agent = await harness.loginAs(harness.admin);
    for (const body of [{}, { order: [] }, { order: [0, 1] }, { order: ['1'] }, { order: [1.5] }]) {
      const res = await agent.post(url(harness.sourceA)).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('ORDER_INVALID');
    }
    expect(reorderMock).not.toHaveBeenCalled();
  });

  it('maps a pre-write refusal to its status and code', async () => {
    const agent = await harness.loginAs(harness.admin);
    reorderMock.mockRejectedValueOnce(new ChannelReorderPlanError('stale', 'ORDER_MISMATCH'));
    const mismatch = await agent.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toMatchObject({ success: false, code: 'ORDER_MISMATCH' });

    reorderMock.mockRejectedValueOnce(new ChannelReorderPlanError('offline', 'NOT_CONNECTED'));
    const offline = await agent.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(offline.status).toBe(503);
  });

  it('reports a rolled-back reorder as 502 with the result', async () => {
    const agent = await harness.loginAs(harness.admin);
    reorderMock.mockResolvedValueOnce({ status: 'rolled_back', error: 'slot 2 write failed', writes: 3, rollbackWrites: 2 });
    const res = await agent.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('CHANNEL_REORDER_ROLLED_BACK');
    expect(res.body.result.status).toBe('rolled_back');
  });

  it('reports an unconfirmed rollback as 500 with the device slots', async () => {
    const agent = await harness.loginAs(harness.admin);
    reorderMock.mockResolvedValueOnce({
      status: 'inconsistent', error: 'link lost', rollbackError: 'link lost',
      deviceSlots: [{ slot: 1, name: 'b' }, { slot: 2, name: null, unknown: true }],
    });
    const res = await agent.post(url(harness.sourceA)).send({ order: [2, 1] });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('CHANNEL_REORDER_INCONSISTENT');
    expect(res.body.result.deviceSlots).toHaveLength(2);
  });
});
