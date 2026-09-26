/**
 * POST /api/purge/nodes — coverage receptions cascade (#5277 amendment 5 / D7).
 *
 * `purgeRoutes.test.ts` mocks the entire DatabaseService singleton, so it can
 * only prove the route CALLS purgeAllNodesAsync — not that the real cascade
 * inside it removes coverage_receptions rows. This file uses the real-DB
 * route harness (see routeTestApp.ts) instead, mirroring
 * sourceRoutes.deleteCleanup.test.ts's real-cascade pattern, to prove the
 * actual purge for both the scoped and the global ("purge all nodes") path.
 *
 * `resolveSourceManager` is mocked — same as purgeRoutes.test.ts — since the
 * route also calls `refreshNodeDatabase()` on the resolved manager, and a
 * real manager would attempt a live device connection.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import purgeRoutes from './purgeRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService from '../../services/database.js';

const mockManager = { refreshNodeDatabase: vi.fn().mockResolvedValue(undefined) };
vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: vi.fn(() => mockManager),
  resolveOwnMeshtasticManager: vi.fn(() => mockManager),
}));

const receptionParams = (sourceId: string, receiverId: string, senderId: string, packetKey: string) => ({
  sourceId,
  protocol: 'meshtastic',
  receiverKind: 'local',
  receiverId,
  senderId,
  packetKey,
  pathKey: 'r0:h0',
  latitude: 37.0,
  longitude: -122.0,
  receivedAt: Date.now(),
});

describe('POST /api/purge/nodes — coverage receptions cascade (#5277)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/purge', purgeRoutes) });

    await databaseService.coverageReceptions.recordReception(
      receptionParams(harness.sourceA, '!0000cova', '!0000send', 'pkt-purge-1'),
    );
    await databaseService.coverageReceptions.recordReception(
      receptionParams(harness.sourceB, '!0000covb', '!0000send', 'pkt-purge-2'),
    );
  });

  afterEach(async () => {
    await databaseService.coverageReceptions.deleteForSource(harness.sourceA).catch(() => {});
    await databaseService.coverageReceptions.deleteForSource(harness.sourceB).catch(() => {});
    await harness.cleanup();
  });

  it('scoped purge removes only the target source\'s coverage receptions', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/nodes').send({ sourceId: harness.sourceA });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const pageA = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [harness.sourceA], sinceMs: 0, untilMs: Date.now() + 1000, pageSize: 10,
    });
    expect(pageA.items).toEqual([]);

    const pageB = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [harness.sourceB], sinceMs: 0, untilMs: Date.now() + 1000, pageSize: 10,
    });
    expect(pageB.items.length).toBe(1);
  });

  it('global purge (no sourceId) empties coverage receptions across every source', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.post('/purge/nodes').send({});
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const page = await databaseService.coverageReceptions.getReceptions({
      sourceIds: [harness.sourceA, harness.sourceB], sinceMs: 0, untilMs: Date.now() + 1000, pageSize: 10,
    });
    expect(page.items).toEqual([]);
  });
});
