/**
 * GET /api/unified/telemetry applies the same per-node rules as the per-node
 * route GET /api/telemetry/:nodeId (#5896): a node heard on a channel the
 * caller cannot view on the map there is left out, and the position rows
 * (latitude/longitude/altitude) of a private-position node are dropped unless
 * the caller holds `nodes_private:read` on that source. It used to check only
 * `nodes:read` per source.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';

const PRIVATE_NODE = 0x6d000001; // channel 0, private position
const CH3_NODE = 0x6d000002; // channel 3
const PUBLIC_NODE = 0x6d000003; // channel 0, public position

const hex = (n: number) => `!${n.toString(16).padStart(8, '0')}`;

describe('GET /api/unified/telemetry: channel access and private positions', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      useOptionalAuth: false,
      mount: (app) => app.use('/api/unified', unifiedRoutes),
    });
    const src = harness.sourceA;
    await harness.db.nodes.deleteAllNodes(src);
    await harness.db.telemetry.deleteAllTelemetry(src);
    await harness.db.nodes.upsertNode(
      { nodeNum: PRIVATE_NODE, nodeId: hex(PRIVATE_NODE), longName: 'Private', channel: 0, positionOverrideIsPrivate: true },
      src,
    );
    await harness.db.nodes.upsertNode({ nodeNum: CH3_NODE, nodeId: hex(CH3_NODE), longName: 'Ch3', channel: 3 }, src);
    await harness.db.nodes.upsertNode({ nodeNum: PUBLIC_NODE, nodeId: hex(PUBLIC_NODE), longName: 'Public', channel: 0 }, src);
    const now = Date.now();
    for (const nodeNum of [PRIVATE_NODE, CH3_NODE, PUBLIC_NODE]) {
      for (const [telemetryType, value] of [['latitude', 28.1], ['longitude', -80.6], ['altitude', 12], ['batteryLevel', 90]] as const) {
        await harness.db.telemetry.insertTelemetry(
          { nodeId: hex(nodeNum), nodeNum, telemetryType, value, timestamp: now - 1000, createdAt: now },
          src,
        );
      }
    }
  });

  afterEach(async () => {
    await harness.db.telemetry.deleteAllTelemetry(harness.sourceA);
    await harness.db.nodes.deleteAllNodes(harness.sourceA);
    await harness.cleanup();
  });

  const read = async (user: SeededUser): Promise<string[]> => {
    const agent = await harness.loginAs(user);
    const res = await agent.get('/api/unified/telemetry');
    expect(res.status).toBe(200);
    return (res.body as Array<{ nodeId: string; telemetryType: string }>)
      .filter((t) => [PRIVATE_NODE, CH3_NODE, PUBLIC_NODE].map(hex).includes(t.nodeId))
      .map((t) => `${t.nodeId}:${t.telemetryType}`)
      .sort();
  };

  const all = (nodeNum: number) =>
    ['altitude', 'batteryLevel', 'latitude', 'longitude'].map((t) => `${hex(nodeNum)}:${t}`);

  it('an admin sees every node and every type', async () => {
    expect(await read(harness.admin)).toEqual([...all(PRIVATE_NODE), ...all(CH3_NODE), ...all(PUBLIC_NODE)].sort());
  });

  it('a non-admin without nodes_private:read gets no position rows for a private node, and nothing from a channel they cannot view', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    expect(await read(harness.limited)).toEqual([`${hex(PRIVATE_NODE)}:batteryLevel`, ...all(PUBLIC_NODE)].sort());
  });

  it('nodes_private:read on the source restores the private node\'s position rows', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    await harness.grant(harness.limited.id, 'nodes_private', 'read', harness.sourceA);
    expect(await read(harness.limited)).toEqual([...all(PRIVATE_NODE), ...all(PUBLIC_NODE)].sort());
  });

  // Moved from the mocked unifiedRoutes.test.ts (#4700): the source gate is
  // `nodes:read`, not a nonexistent `telemetry` resource.
  it('gates each source on nodes:read: a channel grant alone reads nothing', async () => {
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    expect(await read(harness.limited)).toEqual([]);
  });

  it('skips sources the caller cannot read', async () => {
    await harness.db.nodes.upsertNode({ nodeNum: PUBLIC_NODE, nodeId: hex(PUBLIC_NODE), longName: 'Public', channel: 0 }, harness.sourceB);
    await harness.db.telemetry.insertTelemetry(
      { nodeId: hex(PUBLIC_NODE), nodeNum: PUBLIC_NODE, telemetryType: 'batteryLevel', value: 50, timestamp: Date.now() - 500, createdAt: Date.now() },
      harness.sourceB,
    );
    try {
      await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
      await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
      const agent = await harness.loginAs(harness.limited);
      const res = await agent.get('/api/unified/telemetry');
      expect(res.status).toBe(200);
      const sources = new Set((res.body as Array<{ sourceId: string }>).map((t) => t.sourceId));
      expect([...sources]).toEqual([harness.sourceA]);
    } finally {
      await harness.db.telemetry.deleteAllTelemetry(harness.sourceB);
      await harness.db.nodes.deleteAllNodes(harness.sourceB);
    }
  });

  it('a channel grant on another source does not open this one', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceB);
    await harness.grant(harness.limited.id, 'channel_3', 'viewOnMap', harness.sourceB);
    expect(await read(harness.limited)).toEqual([]);
  });
});
