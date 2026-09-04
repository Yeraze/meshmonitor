/**
 * GET /api/nodes/identity-changes — Meshtastic 2.8 node-number change
 * detection (issue #5032).
 *
 * Uses the real-middleware harness (`createRouteTestApp`) so `requirePermission`
 * runs actual per-source SQL rather than a hand-rolled lambda. The two things
 * this endpoint must never do are (a) report across sources and (b) answer for
 * a source the caller has no grant on — both are asserted here against real
 * permission rows.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import nodesRoutes from './nodesRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { nodeNumFromPublicKey } from '../../services/lowEntropyKeyService.js';

// Non-DB mocks: nodesRoutes reaches for live managers at import/request time
// and must not attempt real TCP connections under test.
vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

const KEY = Buffer.alloc(32, 0xab).toString('base64');
const DERIVED = nodeNumFromPublicKey(KEY)!;
const OLD_NUM = 0x433d1ba4;

const NOW = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

describe('GET /nodes/identity-changes', () => {
  let harness: RouteTestHarness;

  /** Seed a pre-2.8 row and its post-2.8 successor on one source. */
  async function seedUpgradePair(sourceId: string) {
    const now = NOW();
    await harness.db.nodes.upsertNode(
      {
        nodeNum: OLD_NUM,
        nodeId: `!${OLD_NUM.toString(16)}`,
        longName: 'Base Station',
        shortName: 'BASE',
        publicKey: KEY,
        firmwareVersion: '2.7.11.ee68575',
        // Fell silent two days ago — well past minQuiet, well inside lookback.
        lastHeard: now - 2 * DAY,
      },
      sourceId,
    );
    await harness.db.nodes.upsertNode(
      {
        nodeNum: DERIVED,
        nodeId: `!${DERIVED.toString(16)}`,
        longName: 'Base Station',
        shortName: 'BASE',
        publicKey: KEY,
        firmwareVersion: '2.8.0.47db0e3',
        lastHeard: now - 60,
      },
      sourceId,
    );
  }

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', nodesRoutes) });
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
  });

  afterEach(async () => {
    await harness.db.nodes.deleteNodeRecord(OLD_NUM, harness.sourceA);
    await harness.db.nodes.deleteNodeRecord(DERIVED, harness.sourceA);
    await harness.db.nodes.deleteNodeRecord(OLD_NUM, harness.sourceB);
    await harness.db.nodes.deleteNodeRecord(DERIVED, harness.sourceB);
    await harness.cleanup();
  });

  it('reports the CRC-verified predecessor for an upgraded node', async () => {
    await seedUpgradePair(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(`/nodes/identity-changes?sourceId=${harness.sourceA}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sourceId).toBe(harness.sourceA);
    const detections = res.body.data.detections;
    expect(detections).toHaveLength(1);
    expect(detections[0].successor.nodeNum).toBe(DERIVED);
    expect(detections[0].predecessor.nodeNum).toBe(OLD_NUM);
    expect(detections[0].basis).toBe('derivedNodeNum');
    expect(detections[0].confidence).toBe('high');
  });

  it('never echoes a node public key to the client', async () => {
    await seedUpgradePair(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(`/nodes/identity-changes?sourceId=${harness.sourceA}`);

    // `hasPublicKey` is the only key-derived fact that crosses the wire.
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(res.body.data.detections[0].successor.hasPublicKey).toBe(true);
  });

  it('does not pair nodes that live on different sources', async () => {
    // The pair is split: predecessor on A, successor on B. Two different
    // meshes — a key or name collision across them means nothing (#3745).
    const now = NOW();
    await harness.db.nodes.upsertNode(
      {
        nodeNum: OLD_NUM,
        nodeId: `!${OLD_NUM.toString(16)}`,
        longName: 'Base Station',
        shortName: 'BASE',
        publicKey: KEY,
        lastHeard: now - 2 * DAY,
      },
      harness.sourceA,
    );
    await harness.db.nodes.upsertNode(
      {
        nodeNum: DERIVED,
        nodeId: `!${DERIVED.toString(16)}`,
        longName: 'Base Station',
        shortName: 'BASE',
        publicKey: KEY,
        lastHeard: now - 60,
      },
      harness.sourceB,
    );

    const agent = await harness.loginAs(harness.admin);
    const onA = await agent.get(`/nodes/identity-changes?sourceId=${harness.sourceA}`);
    const onB = await agent.get(`/nodes/identity-changes?sourceId=${harness.sourceB}`);

    expect(onA.body.data.detections).toHaveLength(0);
    expect(onB.body.data.detections).toHaveLength(0);
  });

  it('requires a sourceId', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get('/nodes/identity-changes');
    expect(res.status).toBe(400);
  });

  it('denies a source the caller has no nodes:read grant on', async () => {
    await seedUpgradePair(harness.sourceB);
    const agent = await harness.loginAs(harness.limited);

    const res = await agent.get(`/nodes/identity-changes?sourceId=${harness.sourceB}`);

    expect(res.status).toBe(403);
  });
});
