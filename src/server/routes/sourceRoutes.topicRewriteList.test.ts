/**
 * #6516: an mqtt_bridge may hold a list of topic-rewrite rules per direction.
 * Pins the save-time validation: the cap, per-rule checks with an index, a
 * repeated downlink prefix, and the legacy single-object form.
 *
 * Real session + auth middleware + permission SQL via createRouteTestApp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { MAX_TOPIC_REWRITE_RULES } from '../constants/mqttBridge.js';

const registry = vi.hoisted(() => ({
  getManager: vi.fn(),
  getAllManagers: vi.fn().mockReturnValue([]),
  addManager: vi.fn(),
  removeManager: vi.fn(),
  startManager: vi.fn(),
  stopManager: vi.fn(),
  reconfigureObserver: vi.fn().mockResolvedValue(false),
}));

// Non-DB mocks only: nothing here may open a real broker connection.
vi.mock('../sourceManagerRegistry.js', () => ({ sourceManagerRegistry: registry }));

const BROKER = 'rwlist-broker';
const BRIDGE = 'rwlist-bridge';

const baseBridge = {
  upstream: { url: 'mqtt://upstream.example:1883' },
  subscriptions: ['root/branch_1/#', 'root/branch_2/#'],
  brokerSourceId: BROKER,
  autoConnect: false,
};

describe('PUT mqtt_bridge topic-rewrite lists (#6516)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    registry.getManager.mockReset().mockReturnValue(null);
    harness = await createRouteTestApp({ mount: (app) => app.use('/', sourceRoutes) });
    for (const id of [BRIDGE, BROKER]) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.db.sources.createSource({
      id: BROKER,
      name: 'Local broker',
      type: 'mqtt_broker',
      config: { listener: { port: 18831 }, autoConnect: false },
      enabled: false,
    });
    await harness.db.sources.createSource({
      id: BRIDGE,
      name: 'Bridge',
      type: 'mqtt_bridge',
      config: baseBridge,
      enabled: false,
    });
  });

  afterEach(async () => {
    for (const id of [BRIDGE, BROKER]) await harness.db.sources.deleteSource(id).catch(() => {});
    await harness.cleanup();
  });

  const save = async (extra: Record<string, unknown>) =>
    (await harness.loginAs(harness.admin)).put(`/${BRIDGE}`).send({ config: { ...baseBridge, ...extra } });

  it('stores a downlink merge and a primary + fan-out uplink list', async () => {
    const downlinkTopicRewrite = [
      { from: 'root/branch_1', to: 'local_branch' },
      { from: 'root/branch_2', to: 'local_branch' },
    ];
    const uplinkTopicRewrite = [
      { from: 'local_branch', to: 'root/branch_1' },
      { from: 'local_branch', to: 'root/branch_2' },
    ];
    const res = await save({ downlinkTopicRewrite, uplinkTopicRewrite, uplinkRewriteFanOut: true });
    expect(res.status).toBe(200);
    const stored = (await harness.db.sources.getSource(BRIDGE))?.config as Record<string, unknown>;
    expect(stored.downlinkTopicRewrite).toEqual(downlinkTopicRewrite);
    expect(stored.uplinkTopicRewrite).toEqual(uplinkTopicRewrite);
    expect(stored.uplinkRewriteFanOut).toBe(true);
  });

  it('still accepts the legacy single object', async () => {
    const res = await save({ downlinkTopicRewrite: { from: 'root', to: 'local' } });
    expect(res.status).toBe(200);
  });

  it(`rejects more than ${MAX_TOPIC_REWRITE_RULES} rules in one direction`, async () => {
    const rules = Array.from({ length: MAX_TOPIC_REWRITE_RULES + 1 }, (_, i) => ({
      from: `root/b${i}`,
      to: 'local',
    }));
    const res = await save({ downlinkTopicRewrite: rules });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most 8 rules/);
  });

  it('names the index of a bad rule', async () => {
    const res = await save({
      uplinkTopicRewrite: [
        { from: 'local', to: 'root/a' },
        { from: 'local/#', to: 'root/b' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uplinkTopicRewrite\[1\].*wildcards/);
  });

  it('rejects a downlink prefix that repeats, after trailing-slash normalising', async () => {
    const res = await save({
      downlinkTopicRewrite: [
        { from: 'root/branch_1', to: 'a' },
        { from: 'root/branch_1/', to: 'b' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/downlinkTopicRewrite\[1\]\.from repeats/);
  });

  it('rejects an exact duplicate uplink rule', async () => {
    const res = await save({
      uplinkTopicRewrite: [
        { from: 'local', to: 'root/a' },
        { from: 'local', to: 'root/a' },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uplinkTopicRewrite\[1\] repeats/);
  });

  it('rejects a non-boolean uplinkRewriteFanOut', async () => {
    const res = await save({ uplinkRewriteFanOut: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uplinkRewriteFanOut must be a boolean/);
  });

  it('rejects a rule list on a standalone bridge', async () => {
    const res = await save({
      brokerSourceId: undefined,
      downlinkTopicRewrite: [{ from: 'root', to: 'local' }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/requires a parent broker/);
  });
});
