/**
 * Solar manual overrides — routes (#3195).
 *
 * Real-middleware harness (createRouteTestApp): real session, real
 * optionalAuth/requirePermission, the live DatabaseService against `:memory:`
 * SQLite. Two properties matter most:
 *
 *  - writing a classification needs `settings:write`; read access must not
 *    imply it;
 *  - the overrides table is global and keyed by nodeNum, so the solar-nodes
 *    response must only surface overrides for nodes the viewer can see —
 *    otherwise a user scoped to one source learns node numbers from another.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import analysisRoutes from './analysisRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';

const NODE_A = 0x0a0a0a0a;
const NODE_B = 0x0b0b0b0b;

describe('analysisRoutes — solar overrides (#3195)', () => {
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
  async function clearOverrides(): Promise<void> {
    for (const o of await harness.db.solarNodeOverrides.getAllAsync()) {
      await harness.db.solarNodeOverrides.clearAsync(o.nodeNum);
    }
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', analysisRoutes) });
    await clearOverrides();
    await seedNode(NODE_A, harness.sourceA, 'Alpha');
    await seedNode(NODE_B, harness.sourceB, 'Bravo');
  });

  afterEach(async () => {
    await clearOverrides();
    await harness.cleanup();
  });

  describe('PUT /solar-overrides/:nodeNum', () => {
    it('lets an admin mark, flip, and clear a node', async () => {
      const agent = await harness.loginAs(harness.admin);

      const mark = await agent.put(`/solar-overrides/${NODE_A}`).send({ isSolar: true });
      expect(mark.status).toBe(200);
      expect(mark.body.success).toBe(true);
      expect((await harness.db.solarNodeOverrides.getMapAsync()).get(NODE_A)).toBe(true);

      await agent.put(`/solar-overrides/${NODE_A}`).send({ isSolar: false });
      expect((await harness.db.solarNodeOverrides.getMapAsync()).get(NODE_A)).toBe(false);

      const clear = await agent.put(`/solar-overrides/${NODE_A}`).send({ isSolar: null });
      expect(clear.status).toBe(200);
      expect((await harness.db.solarNodeOverrides.getMapAsync()).has(NODE_A)).toBe(false);
    });

    it('records who made the change', async () => {
      const agent = await harness.loginAs(harness.admin);
      await agent.put(`/solar-overrides/${NODE_A}`).send({ isSolar: true });
      const [row] = await harness.db.solarNodeOverrides.getAllAsync();
      expect(row.updatedBy).toBe(harness.admin.username);
    });

    it('allows a settings:write user', async () => {
      await harness.grant(harness.limited.id, 'settings', 'write', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.put(`/solar-overrides/${NODE_A}`).send({ isSolar: true });
      expect(res.status).toBe(200);
    });

    it('refuses a settings:read user and writes nothing', async () => {
      await harness.grant(harness.limited.id, 'settings', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.put(`/solar-overrides/${NODE_A}`).send({ isSolar: true });
      expect(res.status).toBe(403);
      expect(await harness.db.solarNodeOverrides.getAllAsync()).toEqual([]);
    });

    it('refuses an anonymous caller', async () => {
      const agent = await harness.loginAs(null);
      const res = await agent.put(`/solar-overrides/${NODE_A}`).send({ isSolar: true });
      expect([401, 403]).toContain(res.status);
      expect(await harness.db.solarNodeOverrides.getAllAsync()).toEqual([]);
    });

    it.each([['abc'], ['-1'], ['4294967296'], ['1.5']])('rejects nodeNum %s', async (bad) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put(`/solar-overrides/${bad}`).send({ isSolar: true });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_NODE_NUM');
    });

    it('accepts the top of the unsigned 32-bit range', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put('/solar-overrides/4294967295').send({ isSolar: true });
      expect(res.status).toBe(200);
    });

    it.each([[{}], [{ isSolar: 'yes' }], [{ isSolar: 1 }]])('rejects body %j', async (body) => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.put(`/solar-overrides/${NODE_A}`).send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SOLAR_OVERRIDE');
    });
  });

  describe('GET /solar-nodes manual_overrides', () => {
    beforeEach(async () => {
      await harness.db.solarNodeOverrides.setAsync(NODE_A, true, 'admin');
      await harness.db.solarNodeOverrides.setAsync(NODE_B, false, 'admin');
    });

    it('shows an admin every override, named', async () => {
      const agent = await harness.loginAs(harness.admin);
      const res = await agent.get('/solar-nodes');
      expect(res.status).toBe(200);
      const overrides = res.body.manual_overrides as Array<{ node_num: number; node_name: string; is_solar: boolean }>;
      expect(overrides).toEqual(expect.arrayContaining([
        { node_num: NODE_A, node_name: 'Alpha', is_solar: true },
        { node_num: NODE_B, node_name: 'Bravo', is_solar: false },
      ]));
      // A node marked solar with no telemetry is still reported, so the flag is visible.
      expect(res.body.solar_nodes.map((n: { node_num: number }) => n.node_num)).toContain(NODE_A);
    });

    it('hides overrides for nodes on a source the viewer cannot read', async () => {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/solar-nodes');
      expect(res.status).toBe(200);
      const nums = (res.body.manual_overrides as Array<{ node_num: number }>).map((o) => o.node_num);
      expect(nums).toContain(NODE_A);
      expect(nums).not.toContain(NODE_B);
    });
  });
});
