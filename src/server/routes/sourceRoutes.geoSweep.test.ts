/**
 * PUT /api/sources/:id — config-change geo sweep trigger (MQTT Geo-Ignore
 * epic, Phase 3, WP3).
 *
 * Uses the real-middleware harness (createRouteTestApp) against the live
 * :memory: singleton DB — see src/server/test-helpers/routeTestApp.ts for
 * the design rationale, and src/server/routes/sourceRoutes.permissions.test.ts
 * for the template this file follows.
 *
 * `sourceManagerRegistry` is mocked (non-DB, allowed per CLAUDE.md) so
 * addManager/removeManager no-op and getManager returns a fake sink object —
 * the route's config-change branch is the thing under test, not the real
 * MQTT connection lifecycle. `mqttGeoSweepService` itself is NOT mocked: it
 * runs for real against the harness DB so the assertions prove actual
 * ignore/purge/lift behavior, not a mocked call.
 *
 * Config semantics (read from the PUT handler, sourceRoutes.ts ~L446-511):
 * `updates.config = preserveSourceCredentials(existing.type, existing.config,
 * config)` — `config` in the request body WHOLESALE REPLACES the stored
 * config (preserveSourceCredentials only round-trips the upstream password
 * when omitted). Every PUT body below therefore sends a complete mqtt_bridge
 * config object, not a partial patch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import databaseService, { type DbMessage, type DbTelemetry } from '../../services/database.js';

// ── Non-DB mocks (allowed per CLAUDE.md) ───────────────────────────────────

const mockGetManager = vi.fn();
const mockAddManager = vi.fn();
const mockRemoveManager = vi.fn();

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: (...args: unknown[]) => mockGetManager(...args),
    addManager: (...args: unknown[]) => mockAddManager(...args),
    removeManager: (...args: unknown[]) => mockRemoveManager(...args),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

// Matches the ON_BBOX convention used across the geo-ignore test suite
// (mqttGeoSweepService.test.ts, mqttIngestion.perSource.test.ts).
const OLD_BBOX = { minLat: 10, maxLat: 20, minLng: 10, maxLng: 20 };
const NEW_BBOX = { minLat: 43, maxLat: 45, minLng: -80, maxLng: -77 };

const NODE_IN = { num: 0x40000001, lat: 44, lng: -78 }; // inside NEW_BBOX
const NODE_OUT = { num: 0x40000002, lat: 49.2, lng: -123 }; // outside both bboxes
const NODE_MANUAL = { num: 0x40000003, lat: 49.2, lng: -123 }; // outside; manually ignored
const STALE_GEO_NODE_NUM = 0x40000099; // geo-ignored under OLD_BBOX; no live node row

function nodeIdFor(num: number): string {
  return `!${num.toString(16).padStart(8, '0')}`;
}

function bridgeConfig(
  geo: typeof NEW_BBOX | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    upstream: { url: 'mqtt://upstream.example:1883' },
    subscriptions: ['msh/#'],
    downlinkFilters: geo ? { geo } : {},
    ...extra,
  };
}

describe('PUT /api/sources/:id — mqtt_bridge geo sweep on config change', () => {
  let harness: RouteTestHarness;
  const BRIDGE_ID = 'rt-geo-bridge';
  let fakeManager: { recordGeoSweepStats: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    harness = await createRouteTestApp({
      mount: (app) => app.use('/', sourceRoutes),
    });

    // PUT /:id uses requirePermission('sources', 'write') with no
    // sourceIdFrom option, so this is a GLOBAL permission check
    // (scopedSourceId stays undefined) — grant without a sourceId.
    await harness.grant(harness.limited.id, 'sources', 'write');

    fakeManager = { recordGeoSweepStats: vi.fn() };
    mockGetManager.mockReset().mockReturnValue(fakeManager);
    mockAddManager.mockReset().mockResolvedValue(undefined);
    mockRemoveManager.mockReset().mockResolvedValue(undefined);

    await databaseService.sources.deleteSource(BRIDGE_ID).catch(() => {});
    await databaseService.sources.createSource({
      id: BRIDGE_ID,
      name: 'Geo Bridge',
      type: 'mqtt_bridge',
      config: bridgeConfig(OLD_BBOX),
      enabled: true,
    });

    // NODE_IN: inside NEW_BBOX, never ignored.
    await databaseService.upsertNodeAsync(
      {
        nodeNum: NODE_IN.num,
        nodeId: nodeIdFor(NODE_IN.num),
        longName: 'Node In',
        shortName: 'NIN',
        latitude: NODE_IN.lat,
        longitude: NODE_IN.lng,
        hwModel: 1,
        lastHeard: Math.floor(Date.now() / 1000),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
      BRIDGE_ID,
    );

    // NODE_OUT: outside NEW_BBOX, not yet ignored — plus a message + telemetry
    // row to prove the purge cascade actually runs.
    await databaseService.upsertNodeAsync(
      {
        nodeNum: NODE_OUT.num,
        nodeId: nodeIdFor(NODE_OUT.num),
        longName: 'Node Out',
        shortName: 'NOUT',
        latitude: NODE_OUT.lat,
        longitude: NODE_OUT.lng,
        hwModel: 1,
        lastHeard: Math.floor(Date.now() / 1000),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
      BRIDGE_ID,
    );
    await databaseService.messages.insertMessage(
      {
        id: `${BRIDGE_ID}_${NODE_OUT.num}_0xaaaa0001`,
        fromNodeNum: NODE_OUT.num,
        toNodeNum: 0xffffffff,
        fromNodeId: nodeIdFor(NODE_OUT.num),
        toNodeId: '!ffffffff',
        text: 'seed message',
        channel: 0,
        portnum: 1,
        timestamp: Date.now(),
        createdAt: Date.now(),
      } as DbMessage,
      BRIDGE_ID,
    );
    await databaseService.insertTelemetryAsync(
      {
        nodeId: nodeIdFor(NODE_OUT.num),
        nodeNum: NODE_OUT.num,
        telemetryType: 'batteryLevel',
        timestamp: Date.now(),
        value: 77,
        unit: '%',
        createdAt: Date.now(),
      } as DbTelemetry,
      BRIDGE_ID,
    );

    // NODE_MANUAL: outside NEW_BBOX, but a human already blocklisted it —
    // the sweep must never lift or purge a manual entry.
    await databaseService.upsertNodeAsync(
      {
        nodeNum: NODE_MANUAL.num,
        nodeId: nodeIdFor(NODE_MANUAL.num),
        longName: 'Node Manual',
        shortName: 'NMAN',
        latitude: NODE_MANUAL.lat,
        longitude: NODE_MANUAL.lng,
        hwModel: 1,
        lastHeard: Math.floor(Date.now() / 1000),
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any,
      BRIDGE_ID,
    );
    await databaseService.ignoredNodes.addIgnoredNodeAsync(
      NODE_MANUAL.num,
      BRIDGE_ID,
      nodeIdFor(NODE_MANUAL.num),
      'Node Manual',
      'NMAN',
    );

    // Pre-existing geo-ignore entry from a previous (OLD_BBOX) sweep, for a
    // node that's already been purged (no live node row). Only a LIFT pass
    // can remove this — it proves the config-change sweep actually runs
    // with lift:true, not just the add-only start()-sweep shape.
    await databaseService.ignoredNodes.addGeoIgnoreAsync(
      STALE_GEO_NODE_NUM,
      BRIDGE_ID,
      nodeIdFor(STALE_GEO_NODE_NUM),
      'Stale Geo Node',
      'SGN',
    );
  });

  afterEach(async () => {
    await harness.cleanup();
    await databaseService.sources.deleteSource(BRIDGE_ID).catch(() => {});
  });

  it('bbox changed: purges/ignores newly-out node, lifts stale geo entry, leaves manual + in-bbox untouched', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .put(`/${BRIDGE_ID}`)
      .send({ enabled: true, config: bridgeConfig(NEW_BBOX) });

    expect(res.status).toBe(200);

    const ignored = await databaseService.ignoredNodes.getIgnoredNodesAsync(BRIDGE_ID);

    // NODE_OUT: newly geo-ignored + purged (node row, message, telemetry).
    const nodeOutEntry = ignored.find((r) => r.nodeNum === NODE_OUT.num);
    expect(nodeOutEntry?.reason).toBe('geo');
    expect(await databaseService.nodes.getNode(NODE_OUT.num, BRIDGE_ID)).toBeNull();
    expect(
      await databaseService.messages.getMessage(`${BRIDGE_ID}_${NODE_OUT.num}_0xaaaa0001`),
    ).toBeNull();
    const telOut = await databaseService.telemetry.getTelemetryByNode(
      nodeIdFor(NODE_OUT.num),
      100,
      undefined,
      undefined,
      0,
      undefined,
      BRIDGE_ID,
    );
    expect(telOut).toHaveLength(0);

    // NODE_IN: untouched.
    expect(ignored.find((r) => r.nodeNum === NODE_IN.num)).toBeUndefined();
    expect(await databaseService.nodes.getNode(NODE_IN.num, BRIDGE_ID)).not.toBeNull();

    // NODE_MANUAL: still present, still reason 'manual' — never lifted/purged.
    const manualEntry = ignored.find((r) => r.nodeNum === NODE_MANUAL.num);
    expect(manualEntry?.reason).toBe('manual');
    expect(await databaseService.nodes.getNode(NODE_MANUAL.num, BRIDGE_ID)).not.toBeNull();

    // Stale geo entry: lifted (gone).
    expect(ignored.find((r) => r.nodeNum === STALE_GEO_NODE_NUM)).toBeUndefined();

    // Sink wiring: the (fake) live manager received the sweep stats.
    expect(fakeManager.recordGeoSweepStats).toHaveBeenCalledTimes(1);
    expect(fakeManager.recordGeoSweepStats).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: BRIDGE_ID, ignored: 1, purged: 1, lifted: 1 }),
    );
  });

  it('geo removed entirely: all remaining geo entries lifted, no new ignores', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .put(`/${BRIDGE_ID}`)
      .send({ enabled: true, config: bridgeConfig(null) });

    expect(res.status).toBe(200);

    const ignored = await databaseService.ignoredNodes.getIgnoredNodesAsync(BRIDGE_ID);

    // No geo bbox → classifyPosition never returns 'out' → no new ignores.
    expect(ignored.find((r) => r.nodeNum === NODE_OUT.num)).toBeUndefined();
    expect(await databaseService.nodes.getNode(NODE_OUT.num, BRIDGE_ID)).not.toBeNull();
    expect(ignored.find((r) => r.nodeNum === NODE_IN.num)).toBeUndefined();

    // Stale geo entry lifted.
    expect(ignored.find((r) => r.nodeNum === STALE_GEO_NODE_NUM)).toBeUndefined();

    // Manual entry survives — the lift pass only touches reason='geo' rows.
    const manualEntry = ignored.find((r) => r.nodeNum === NODE_MANUAL.num);
    expect(manualEntry?.reason).toBe('manual');

    expect(fakeManager.recordGeoSweepStats).toHaveBeenCalledTimes(1);
    expect(fakeManager.recordGeoSweepStats).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: BRIDGE_ID, ignored: 0, lifted: 1 }),
    );
  });

  it('non-geo field changed only: no sweep runs, stale geo entry survives', async () => {
    const agent = await harness.loginAs(harness.limited);
    const res = await agent
      .put(`/${BRIDGE_ID}`)
      // Same OLD_BBOX geo as the seeded config — only `mode` differs.
      .send({ enabled: true, config: bridgeConfig(OLD_BBOX, { mode: 'publish_only' }) });

    expect(res.status).toBe(200);

    const ignored = await databaseService.ignoredNodes.getIgnoredNodesAsync(BRIDGE_ID);

    // Stale geo entry survives — geo config was unchanged, so no lift pass ran.
    const staleEntry = ignored.find((r) => r.nodeNum === STALE_GEO_NODE_NUM);
    expect(staleEntry?.reason).toBe('geo');

    // Manual entry untouched too.
    expect(ignored.find((r) => r.nodeNum === NODE_MANUAL.num)?.reason).toBe('manual');

    // No sweep triggered by this PUT, so the sink was never invoked from the
    // config-change branch (still the beforeEach's fresh mock — nothing else
    // in this test path calls recordGeoSweepStats).
    expect(fakeManager.recordGeoSweepStats).not.toHaveBeenCalled();
  });
});
