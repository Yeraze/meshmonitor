/**
 * telemetryRoutes — GET /telemetry/:nodeId serving the #5101 Phase 3 WP3
 * computed transport-traffic series (`systemNodesHeard{Rf,Udp,Mqtt}`,
 * `systemPacketsRx{Rf,Udp,Mqtt}`).
 *
 * This route needed no code changes for WP3 — `RAW_VALUE_TYPES` (WP1,
 * src/db/repositories/telemetry.ts) already routes these six types around the
 * averaging query, and per-source scoping is the route's existing behaviour.
 * This file is the test-only WP3 deliverable proving that "just works" for
 * these specific types, end to end, with the real middleware harness.
 *
 * Uses the real-middleware harness (createRouteTestApp) per project policy
 * for new route tests: real session + optionalAuth + real permission SQL.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import telemetryRoutes from './telemetryRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import { TRANSPORT_SERIES_TYPES, TRANSPORT_SERIES_COMPONENT_TYPES } from '../../utils/transportSeries.js';
import { ALL_SOURCES } from '../../db/repositories/index.js';

const NODE_ID = '!aabbccdd';
const NODE_NUM = 0xaabbccdd;

/** One value per (kind, class), distinct and easy to eyeball. */
const VALUES: Record<'nodesHeard' | 'packetsRx', Record<'rf' | 'udp' | 'mqtt', number>> = {
  nodesHeard: { rf: 3, udp: 1, mqtt: 2 },
  packetsRx: { rf: 30, udp: 10, mqtt: 20 },
};

describe('GET /telemetry/:nodeId — transport-traffic series (#5101 P3 WP3)', () => {
  let harness: RouteTestHarness;

  /**
   * Seed one row per component type for one source, using `VALUES` (source A)
   * or `VALUES` shifted by +500 (any other source, via `valueOffset`) so the
   * two sources' rows are trivially distinguishable by magnitude.
   */
  const seedTransportSeries = async (sourceId: string, valueOffset = 0) => {
    const now = Date.now();
    let packetId = 1000;
    for (const kind of ['nodesHeard', 'packetsRx'] as const) {
      for (const cls of ['rf', 'udp', 'mqtt'] as const) {
        await harness.db.telemetry.insertTelemetry(
          {
            nodeId: NODE_ID,
            nodeNum: NODE_NUM,
            telemetryType: TRANSPORT_SERIES_TYPES[kind][cls],
            timestamp: now,
            value: VALUES[kind][cls] + valueOffset,
            createdAt: now,
            packetId: packetId++,
          },
          sourceId,
        );
      }
    }
  };

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: (app) => app.use('/', telemetryRoutes) });
  });

  afterEach(async () => {
    await harness.db.telemetry.deleteTelemetryByNode(NODE_NUM, ALL_SOURCES);
    await harness.cleanup();
  });

  it('returns all six component rows, unaveraged (raw integers), for an admin', async () => {
    await seedTransportSeries(harness.sourceA);
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(
      `/telemetry/${encodeURIComponent(NODE_ID)}?sourceId=${harness.sourceA}&hours=168`,
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    const byType = new Map<string, number>(
      res.body.map((r: { telemetryType: string; value: number }) => [r.telemetryType, r.value]),
    );
    for (const type of TRANSPORT_SERIES_COMPONENT_TYPES) {
      expect(byType.has(type)).toBe(true);
      expect(Number.isInteger(byType.get(type))).toBe(true);
    }
    // Raw, not averaged: exact seeded values survive untouched.
    expect(byType.get(TRANSPORT_SERIES_TYPES.nodesHeard.rf)).toBe(3);
    expect(byType.get(TRANSPORT_SERIES_TYPES.nodesHeard.udp)).toBe(1);
    expect(byType.get(TRANSPORT_SERIES_TYPES.nodesHeard.mqtt)).toBe(2);
    expect(byType.get(TRANSPORT_SERIES_TYPES.packetsRx.rf)).toBe(30);
    expect(byType.get(TRANSPORT_SERIES_TYPES.packetsRx.udp)).toBe(10);
    expect(byType.get(TRANSPORT_SERIES_TYPES.packetsRx.mqtt)).toBe(20);
  });

  it('does not leak another source\'s transport-series rows', async () => {
    await seedTransportSeries(harness.sourceA, 0);
    await seedTransportSeries(harness.sourceB, 500); // sourceB's values are all >= 500
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(
      `/telemetry/${encodeURIComponent(NODE_ID)}?sourceId=${harness.sourceA}&hours=168`,
    );
    expect(res.status).toBe(200);
    const values = (res.body as Array<{ telemetryType: string; value: number }>)
      .filter((r) => TRANSPORT_SERIES_COMPONENT_TYPES.includes(r.telemetryType))
      .map((r) => r.value);
    expect(values).toHaveLength(6);
    expect(values.every((v) => v < 500)).toBe(true);
  });

  it('403s for a user without info or dashboard read', async () => {
    await seedTransportSeries(harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(
      `/telemetry/${encodeURIComponent(NODE_ID)}?sourceId=${harness.sourceA}&hours=168`,
    );
    expect(res.status).toBe(403);
  });

  it('allows a user granted info read + channel view on the node source', async () => {
    await seedTransportSeries(harness.sourceA);
    await harness.grant(harness.limited.id, 'info', 'read', harness.sourceA);
    // Node has no stored row → channel defaults to 0; grant channel_0 view.
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
    const agent = await harness.loginAs(harness.limited);
    const res = await agent.get(
      `/telemetry/${encodeURIComponent(NODE_ID)}?sourceId=${harness.sourceA}&hours=168`,
    );
    expect(res.status).toBe(200);
    const byType = new Map<string, number>(
      res.body.map((r: { telemetryType: string; value: number }) => [r.telemetryType, r.value]),
    );
    expect(byType.get(TRANSPORT_SERIES_TYPES.nodesHeard.udp)).toBe(1);
  });

  it('400s when sourceId is missing', async () => {
    const agent = await harness.loginAs(harness.admin);
    const res = await agent.get(`/telemetry/${encodeURIComponent(NODE_ID)}?hours=168`);
    expect(res.status).toBe(400);
  });
});
