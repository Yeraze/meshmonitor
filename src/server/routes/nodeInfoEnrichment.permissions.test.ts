/**
 * NodeInfo Enrichment routes — permission isolation (Phase 1 WP-B).
 *
 * Mounts the REAL `nodesRoutes.ts` router (not a minimal stand-in) via
 * `createRouteTestApp`, the same pattern as `sourceRoutes.permissions.test.ts`
 * (the canonical harness template). Mounting the actual router file proves
 * the new `/nodes/enrichment/analysis` and `/nodes/enrichment/apply`
 * registrations are reachable and are not shadowed by any of the router's
 * existing `/nodes/:nodeNum/...` / `/nodes/:nodeId/...` parametric routes.
 *
 * `sourceManagerRegistry.js` and `meshtasticManager.js` are mocked for the
 * same reason `sourceRoutes.permissions.test.ts` mocks them: `nodesRoutes.ts`
 * imports the source-manager machinery at module load for its *other*
 * routes (node refresh, favorites, etc.), and those must not attempt real
 * TCP connections under test. The enrichment routes under test never call
 * into `sourceManagerRegistry` or `fallbackManager` — they only touch
 * `databaseService` (real, via the harness singleton) — so the mocks are
 * inert as far as this file's assertions are concerned.
 *
 * Permission enforcement is real: no `checkPermissionAsync` monkey-patching.
 * `harness.grant(...)` inserts real permission rows and the handlers call
 * the real `databaseService.checkPermissionAsync`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodesRoutes from './nodesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  fallbackManager: {
    getAllNodesAsync: vi.fn().mockResolvedValue([]),
  },
}));

// Monotonic nodeNum generator. upsertNode's update-path preserves a prior
// non-blank value when the incoming value is null (#3456/#3505 semantics —
// blank means "not reported", not "clear"). Since the harness's sourceA/
// sourceB ids are fixed strings reused across every test in this file (and
// deleteSource does not cascade to the nodes table), reusing one nodeNum
// across tests would let a copy from an earlier test "leak" into a later
// test's supposedly-blank target row. A fresh nodeNum per test sidesteps
// this entirely (no existingNode row, no preserve-on-null).
let nodeCounter = 0x50000000;
function freshNodeNum(): number {
  nodeCounter += 1;
  return nodeCounter;
}
function toNodeId(nodeNum: number): string {
  return `!${nodeNum.toString(16).padStart(8, '0')}`;
}

/**
 * The `permissions` table has a UNIQUE(user_id, resource, sourceId)
 * constraint — one row per (user, resource, source), carrying canRead and
 * canWrite as two columns on that same row. `harness.grant()` only ever
 * sets one of them true per call, so granting read AND write on the same
 * (resource, sourceId) requires a single combined insert instead of two
 * `grant()` calls (the second would violate the unique constraint).
 */
async function grantReadAndWrite(harness: RouteTestHarness, userId: number, resource: string, sourceId: string): Promise<void> {
  await harness.db.auth.createPermission({
    userId,
    resource,
    canRead: true,
    canWrite: true,
    sourceId,
    grantedAt: Date.now(),
    grantedBy: null,
  });
}

describe('NodeInfo enrichment routes — permission isolation (real nodesRoutes router)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: app => app.use('/', nodesRoutes) });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  /**
   * Seed a fresh nodeNum present in both sourceA (full donor) and sourceB
   * (blank target: longName/shortName/hwModel unset).
   */
  async function seedDonorTargetPair(): Promise<number> {
    const nodeNum = freshNodeNum();
    const nodeId = toNodeId(nodeNum);
    await harness.db.upsertNodeAsync({
      nodeNum,
      nodeId,
      longName: 'Full Name',
      shortName: 'FN',
      hwModel: 42,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any, harness.sourceA);
    await harness.db.upsertNodeAsync({
      nodeNum,
      nodeId,
      longName: null,
      shortName: null,
      hwModel: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as any, harness.sourceB);
    return nodeNum;
  }

  describe('GET /nodes/enrichment/analysis', () => {
    it('anonymous caller (no login) sees an empty result — 200, not 403', async () => {
      await seedDonorTargetPair();
      const agent = await harness.loginAs(null);
      const res = await agent.get('/nodes/enrichment/analysis');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.nodes).toEqual([]);
      expect(res.body.data.summary).toEqual({ nodeCount: 0, targetCount: 0, fieldCount: 0 });
    });

    it('limited caller with nodes:read on sourceA only never sees the sourceB target (filtered out)', async () => {
      const nodeNum = await seedDonorTargetPair();
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      // Deliberately no grant on sourceB.
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/nodes/enrichment/analysis');
      expect(res.status).toBe(200);
      expect(res.body.data.nodes.find((n: any) => n.nodeNum === nodeNum)).toBeUndefined();
      // Never references sourceB anywhere in the (empty) result.
      const raw = JSON.stringify(res.body.data);
      expect(raw).not.toContain(harness.sourceB);
    });

    it('limited caller with nodes:read on both sources sees the fillable target', async () => {
      const nodeNum = await seedDonorTargetPair();
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/nodes/enrichment/analysis');
      expect(res.status).toBe(200);
      const node = res.body.data.nodes.find((n: any) => n.nodeNum === nodeNum);
      expect(node).toBeDefined();
      const target = node.targets.find((t: any) => t.targetSourceId === harness.sourceB);
      expect(target).toBeDefined();
      expect(target.donorSourceId).toBe(harness.sourceA);
      expect(target.fillableFields.sort()).toEqual(['hwModel', 'longName', 'shortName'].sort());
    });

    it('admin sees the target across both sources with no explicit grants (admin bypass)', async () => {
      const nodeNum = await seedDonorTargetPair();
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/nodes/enrichment/analysis');
      expect(res.status).toBe(200);
      const node = res.body.data.nodes.find((n: any) => n.nodeNum === nodeNum);
      expect(node).toBeDefined();
      expect(
        node.targets.some((t: any) => t.targetSourceId === harness.sourceB && t.donorSourceId === harness.sourceA),
      ).toBe(true);
    });
  });

  describe('POST /nodes/enrichment/apply', () => {
    it('400 INVALID_REQUEST when items is missing/empty', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/nodes/enrichment/apply').send({ items: [] });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.code).toBe('INVALID_REQUEST');
    });

    it('400 INVALID_ITEM when donorSourceId === targetSourceId', async () => {
      const nodeNum = await seedDonorTargetPair();
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/nodes/enrichment/apply').send({
        items: [{ nodeNum, targetSourceId: harness.sourceA, donorSourceId: harness.sourceA }],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ITEM');
    });

    it('400 INVALID_ITEM when nodeNum is not numeric', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/nodes/enrichment/apply').send({
        items: [{ nodeNum: 'not-a-number', targetSourceId: harness.sourceB, donorSourceId: harness.sourceA }],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ITEM');
    });

    it('403 FORBIDDEN when the caller lacks nodes:write on the target source (fail-closed)', async () => {
      const nodeNum = await seedDonorTargetPair();
      // read on both, write only on sourceB — apply targets sourceA, which
      // requires write on sourceA (missing).
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await grantReadAndWrite(harness, harness.limited.id, 'nodes', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/nodes/enrichment/apply').send({
        items: [{ nodeNum, targetSourceId: harness.sourceA, donorSourceId: harness.sourceB }],
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.missing).toEqual(
        expect.arrayContaining([{ sourceId: harness.sourceA, action: 'write' }]),
      );
    });

    it('403 FORBIDDEN when the caller lacks nodes:read on the donor source (fail-closed)', async () => {
      const nodeNum = await seedDonorTargetPair();
      // write on target (sourceB) only; no read grant anywhere (donor sourceA unreadable).
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/nodes/enrichment/apply').send({
        items: [{ nodeNum, targetSourceId: harness.sourceB, donorSourceId: harness.sourceA }],
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
      expect(res.body.missing).toEqual(
        expect.arrayContaining([{ sourceId: harness.sourceA, action: 'read' }]),
      );
    });

    it('200 when the caller holds nodes:read on the donor and nodes:write on the target', async () => {
      const nodeNum = await seedDonorTargetPair();
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'nodes', 'write', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.post('/nodes/enrichment/apply').send({
        items: [{ nodeNum, targetSourceId: harness.sourceB, donorSourceId: harness.sourceA }],
      });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.applied[0].error).toBeUndefined();
      expect(res.body.data.applied[0].copiedFields.sort()).toEqual(['hwModel', 'longName', 'shortName'].sort());

      const targetRow = await harness.db.nodes.getNode(nodeNum, harness.sourceB);
      expect(targetRow?.longName).toBe('Full Name');
    });

    it('admin bypasses the permission checks and applies across both sources', async () => {
      const nodeNum = await seedDonorTargetPair();
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.post('/nodes/enrichment/apply').send({
        items: [{ nodeNum, targetSourceId: harness.sourceB, donorSourceId: harness.sourceA }],
        pushToNodeDb: false,
      });
      expect(res.status).toBe(200);
      expect(res.body.data.applied[0].error).toBeUndefined();
      expect(res.body.data.totalFieldsCopied).toBeGreaterThan(0);
    });
  });
});
