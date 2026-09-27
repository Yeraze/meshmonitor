/**
 * Asset Tracking routes (#5354).
 *
 * Real-middleware harness (createRouteTestApp): real session, real
 * optionalAuth/requirePermission, the live DatabaseService against `:memory:`
 * SQLite. The properties that matter:
 *  - writing a flag needs `settings:write`; read access must not imply it;
 *  - the asset table is global and keyed by nodeNum, so GET only returns rows
 *    for nodes the caller can see on a permitted source;
 *  - the estimate only counts telemetry on the caller's permitted sources.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import assetRoutes from './assetRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const NODE_A = 0x0a0a0a0a;
const NODE_B = 0x0b0b0b0b;
const HOUR = 60 * 60 * 1000;

describe('assetRoutes (#5354)', () => {
  let harness: RouteTestHarness;

  async function seedNode(nodeNum: number, sourceId: string, longName: string): Promise<void> {
    await harness.db.nodes.upsertNode(
      {
        nodeNum,
        nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
        longName,
        shortName: longName.slice(0, 4),
        lastHeard: Math.floor(Date.now() / 1000),
      },
      sourceId,
    );
  }

  /** The harness shares one `:memory:` DB across tests; this table is not in its reset list. */
  async function clearAssets(): Promise<void> {
    for (const a of await harness.db.assetNodes.getAllAsync()) {
      await harness.db.assetNodes.clearAsync(a.nodeNum);
    }
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', assetRoutes) });
    await clearAssets();
    await seedNode(NODE_A, harness.sourceA, 'Alpha');
    await seedNode(NODE_B, harness.sourceB, 'Bravo');
  });

  afterEach(async () => {
    await clearAssets();
    await harness.cleanup();
  });

  describe('PUT /:nodeNum', () => {
    it('lets an admin flag a node, change retention, and records the editor', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put(`/${NODE_A}`).send({ retentionDays: 30 });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({ nodeNum: NODE_A, retentionDays: 30, updatedBy: harness.admin.id });

      await agent.put(`/${NODE_A}`).send({ retentionDays: 120 });
      expect((await harness.db.assetNodes.getMapAsync()).get(NODE_A)).toEqual({ retentionDays: 120 });
    });

    it('allows a settings:write user', async () => {
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.put(`/${NODE_A}`).send({ retentionDays: 90 });
      expect(res.status).toBe(200);
    });

    it('refuses a settings:read user and writes nothing', async () => {
      await harness.grant(harness.limited.id, 'settings', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.put(`/${NODE_A}`).send({ retentionDays: 90 });
      expect(res.status).toBe(403);
      expect(await harness.db.assetNodes.getAllAsync()).toEqual([]);
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.put(`/${NODE_A}`).send({ retentionDays: 90 });
      expect([401, 403]).toContain(res.status);
      expect(await harness.db.assetNodes.getAllAsync()).toEqual([]);
    });

    it.each([['abc'], ['-1'], ['4294967296'], ['1.5']])('rejects nodeNum %s', async (bad) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put(`/${bad}`).send({ retentionDays: 90 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_NODE_NUM');
    });

    it('accepts the top of the unsigned 32-bit range', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put('/4294967295').send({ retentionDays: 1 });
      expect(res.status).toBe(200);
    });

    it.each([[{}], [{ retentionDays: 0 }], [{ retentionDays: 366 }], [{ retentionDays: 1.5 }], [{ retentionDays: '30' }], [{ retentionDays: null }]])(
      'rejects body %j',
      async (body) => {
        const agent = await harness.loginAs(harness.admin);
        const res = await agent.put(`/${NODE_A}`).send(body);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('INVALID_ASSET_RETENTION');
        expect(await harness.db.assetNodes.getAllAsync()).toEqual([]);
      },
    );
  });

  describe('DELETE /:nodeNum', () => {
    it('clears the flag for a settings:write user', async () => {
      await harness.db.assetNodes.setAsync(NODE_A, 90);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete(`/${NODE_A}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(await harness.db.assetNodes.getAllAsync()).toEqual([]);
    });

    it('refuses a user without settings:write', async () => {
      await harness.db.assetNodes.setAsync(NODE_A, 90);
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.delete(`/${NODE_A}`);
      expect(res.status).toBe(403);
      expect(await harness.db.assetNodes.getAllAsync()).toHaveLength(1);
    });

    it('rejects a bad nodeNum', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.delete('/nope');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /', () => {
    beforeEach(async () => {
      await harness.db.assetNodes.setAsync(NODE_A, 30);
      await harness.db.assetNodes.setAsync(NODE_B, 60);
      // A flag for a node no source has heard of is never visible to non-admins… or admins.
      await harness.db.assetNodes.setAsync(0x0c0c0c0c, 90);
    });

    it('returns every visible asset to an admin', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      const nums = res.body.data.map((a: { nodeNum: number }) => a.nodeNum).sort();
      expect(nums).toEqual([NODE_A, NODE_B].sort());
      expect(res.body.data.find((a: { nodeNum: number }) => a.nodeNum === NODE_A)).toMatchObject({ retentionDays: 30 });
    });

    it('filters to nodes on the caller\'s permitted sources', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      expect(res.body.data.map((a: { nodeNum: number }) => a.nodeNum)).toEqual([NODE_A]);
    });

    it('returns nothing to a user with no permitted source', async () => {
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });
  });

  describe('GET /:nodeNum/estimate', () => {
    async function seedTelemetry(nodeNum: number, sourceId: string, ageMs: number): Promise<void> {
      const ts = Date.now() - ageMs;
      await harness.db.telemetry.insertTelemetry(
        {
          nodeId: `!${nodeNum.toString(16).padStart(8, '0')}`,
          nodeNum,
          telemetryType: 'batteryLevel',
          timestamp: ts,
          value: 50,
          unit: '%',
          createdAt: ts,
        },
        sourceId,
      );
    }

    beforeEach(async () => {
      await harness.db.purgeAllTelemetryAsync();
      await seedTelemetry(NODE_A, harness.sourceA, 1 * HOUR);
      await seedTelemetry(NODE_A, harness.sourceA, 2 * HOUR);
      await seedTelemetry(NODE_A, harness.sourceB, 3 * HOUR);
      await seedTelemetry(NODE_A, harness.sourceA, 30 * HOUR); // outside the 24 h window
    });

    it('multiplies the last 24 h row count by the requested retention', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/${NODE_A}/estimate?retentionDays=10`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ nodeNum: NODE_A, rowsLast24h: 3, retentionDays: 10, estimatedRows: 30 });
    });

    it('falls back to the stored retention', async () => {
      await harness.db.assetNodes.setAsync(NODE_A, 2);
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/${NODE_A}/estimate`);
      expect(res.body.data.estimatedRows).toBe(6);
    });

    it('only counts rows on the caller\'s permitted sources', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get(`/${NODE_A}/estimate?retentionDays=10`);
      expect(res.body.data.rowsLast24h).toBe(1);
      expect(res.body.data.estimatedRows).toBe(10);
    });

    it('reports null when there is no recent data', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/${NODE_B}/estimate?retentionDays=90`);
      expect(res.body.data.estimatedRows).toBeNull();
    });

    it('rejects a bad retention', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get(`/${NODE_A}/estimate?retentionDays=0`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ASSET_RETENTION');
    });
  });
});
