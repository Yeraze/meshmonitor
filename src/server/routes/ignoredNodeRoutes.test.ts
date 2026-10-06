/**
 * Ignored-node routes: handler behaviour (errors, validation, source
 * fallback). Real auth middleware and permission rows via the route harness.
 * Per-source permission scoping is covered in
 * `sourceScopedAccess.scope.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ignoredNodeRoutes from './ignoredNodeRoutes.js';
import databaseService from '../../services/database.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

describe('ignoredNodeRoutes', () => {
  let harness: RouteTestHarness;
  type Agent = Awaited<ReturnType<RouteTestHarness['loginAs']>>;
  let admin: Agent;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', ignoredNodeRoutes) });
    admin = await harness.loginAs(harness.admin);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.cleanup();
  });

  describe('GET /', () => {
    it('returns ignored nodes for the named source', async () => {
      await harness.db.ignoredNodes.addIgnoredNodeAsync(123, harness.sourceA, '!0000007b', 'Node', 'N', 'admin');

      const res = await admin.get('/').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    });

    it('with no sourceId, uses the first source the caller holds nodes:read on', async () => {
      await harness.db.ignoredNodes.addIgnoredNodeAsync(1, harness.sourceA, '!00000001', 'On A', 'A', 'admin');
      await harness.db.ignoredNodes.addIgnoredNodeAsync(2, harness.sourceB, '!00000002', 'On B', 'B', 'admin');
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get('/');

      expect(res.status).toBe(200);
      expect(res.body.map((row: { nodeNum: number }) => Number(row.nodeNum))).toEqual([2]);
    });

    it('returns 400 when no source can be resolved', async () => {
      // A grant on a source that is not enabled: the caller holds nodes:read
      // somewhere, but there is no enabled source to fall back to.
      await harness.db.sources.updateSource(harness.sourceA, { enabled: false });
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);

      const res = await agent.get('/');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'MISSING_SOURCE_ID', error: 'No permitted source' });
      expect(typeof res.body.details).toBe('string');
    });

    it('returns 500 on database error', async () => {
      vi.spyOn(databaseService.ignoredNodes, 'getIgnoredNodesAsync').mockRejectedValue(new Error('db error'));

      const res = await admin.get('/').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
    });
  });

  describe('DELETE /:nodeId', () => {
    it('removes an ignored node and returns success', async () => {
      await harness.db.ignoredNodes.addIgnoredNodeAsync(0xaabbccdd, harness.sourceA, '!aabbccdd', 'Node', 'N', 'admin');

      const res = await admin.delete('/!aabbccdd').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ success: true, nodeNum: 0xaabbccdd, sourceId: harness.sourceA });
      expect(await harness.db.ignoredNodes.getIgnoredNodesAsync(harness.sourceA)).toHaveLength(0);
    });

    it('returns 400 for invalid nodeId format', async () => {
      const res = await admin.delete('/!ZZZZ').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, code: 'INVALID_NODE_ID', error: 'Invalid nodeId format' });
      expect(typeof res.body.details).toBe('string');
    });

    it('succeeds even if setNodeIgnoredAsync throws (node not in nodes table)', async () => {
      vi.spyOn(databaseService, 'setNodeIgnoredAsync').mockRejectedValue(new Error('not found'));

      const res = await admin.delete('/!aabbccdd').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('returns 500 on removeIgnoredNodeAsync error', async () => {
      vi.spyOn(databaseService.ignoredNodes, 'removeIgnoredNodeAsync').mockRejectedValue(new Error('db error'));

      const res = await admin.delete('/!aabbccdd').query({ sourceId: harness.sourceA });

      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
    });
  });
});
