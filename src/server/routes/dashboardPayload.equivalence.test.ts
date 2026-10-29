/**
 * Dashboard payload slimming — equivalence with the full node route.
 *
 * The dashboard bundles (GET /api/unified/dashboard, GET /api/sources/:id/dashboard)
 * leave DASHBOARD_OMITTED_NODE_FIELDS out of each node, and read the nodes table
 * without those columns. Everything else must be what GET /api/sources/:id/nodes
 * returns for the same caller: the same nodes (channel filter), the same masked
 * positions (position-channel mask), and the same position-override handling
 * (private override stripped for a caller without nodes_private, applied for an
 * admin). These tests compare the two routes field by field for an admin and
 * for a limited user, using the real permission tables.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import sourceRoutes from './sourceRoutes.js';
import unifiedRoutes from './unifiedRoutes.js';
import { createRouteTestApp, type RouteTestHarness, type SeededUser } from '../test-helpers/routeTestApp.js';
import { DASHBOARD_OMITTED_NODE_FIELDS } from '../../utils/dashboardNodeFields.js';

vi.mock('../sourceManagerRegistry.js', () => ({
  sourceManagerRegistry: {
    getManager: vi.fn().mockReturnValue(null),
    getAllManagers: vi.fn().mockReturnValue([]),
    startManager: vi.fn(),
    stopManager: vi.fn(),
  },
}));

vi.mock('../meshtasticManager.js', () => ({
  MeshtasticManager: vi.fn().mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
}));

const nowSec = Math.floor(Date.now() / 1000);

/** Node rows covering each branch buildSourceNodes takes. */
function seedRows(): Array<Record<string, unknown>> {
  return [
    // Plain node on channel 0 with the housekeeping fields the bundle omits.
    {
      nodeNum: 0x1001, nodeId: '!00001001', longName: 'Plain', shortName: 'PLN', channel: 0,
      latitude: 30.1, longitude: -90.1, altitude: 12, positionChannel: 0,
      macaddr: 'AA:BB:CC:DD:EE:01', firmwareVersion: '2.7.0', hwModel: 9, role: 1,
      lastHeard: nowSec - 60, snr: 5.5, rssi: -80, hopsAway: 1, batteryLevel: 80,
      keyMismatchDetected: true, keySecurityIssueDetails: 'mismatch', isExcessivePackets: true,
      packetRatePerHour: 99, rebootCount: 3, hasRemoteAdmin: true, isFavorite: true,
      notes: 'kept field',
    },
    // Channel 1: the limited user has no viewOnMap there, so it is filtered out.
    { nodeNum: 0x1002, nodeId: '!00001002', longName: 'OtherChan', channel: 1, latitude: 31, longitude: -91, lastHeard: nowSec - 120 },
    // Position heard on channel 1: masked for the limited user, kept for admin.
    { nodeNum: 0x1003, nodeId: '!00001003', longName: 'MaskedPos', channel: 0, latitude: 32, longitude: -92, positionChannel: 1, lastHeard: nowSec - 30 },
    // Private override: applied for admin, stripped for the limited user.
    {
      nodeNum: 0x1004, nodeId: '!00001004', longName: 'PrivOverride', channel: 0, latitude: 33, longitude: -93,
      positionOverrideEnabled: true, latitudeOverride: 40, longitudeOverride: -100, altitudeOverride: 5,
      positionOverrideIsPrivate: true, lastHeard: nowSec - 10,
    },
    // Public override: applied for everyone.
    {
      nodeNum: 0x1005, nodeId: '!00001005', longName: 'PubOverride', channel: 0, latitude: 34, longitude: -94,
      positionOverrideEnabled: true, latitudeOverride: 41, longitudeOverride: -101,
      positionOverrideIsPrivate: false, lastHeard: nowSec - 5,
    },
    // No position at all.
    { nodeNum: 0x1006, nodeId: '!00001006', longName: 'NoPos', channel: 0, lastHeard: nowSec - 3600 },
  ];
}

const byNum = (a: any, b: any) => Number(a.nodeNum) - Number(b.nodeNum);

function stripOmitted(node: Record<string, unknown>): Record<string, unknown> {
  const out = { ...node };
  for (const k of DASHBOARD_OMITTED_NODE_FIELDS) delete out[k];
  return out;
}

describe('dashboard bundles: slim nodes match GET /:id/nodes minus the omitted fields', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({
      // unifiedRoutes applies its own optionalAuth.
      useOptionalAuth: false,
      mount: (app) => {
        app.use('/api/unified', unifiedRoutes);
        app.use('/api/sources', sourceRoutes);
      },
    });
    for (const row of seedRows()) {
      await harness.db.nodes.upsertNode(row as any, harness.sourceA);
    }
    // Limited user: nodes on sourceA, map view of channel 0 only.
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    await harness.grant(harness.limited.id, 'channel_0', 'viewOnMap', harness.sourceA);
  });

  afterEach(async () => {
    await harness.db.nodes.deleteAllNodes(harness.sourceA).catch(() => {});
    await harness.cleanup();
  });

  async function fetchAll(user: SeededUser) {
    const agent = await harness.loginAs(user);
    const full = await agent.get(`/api/sources/${harness.sourceA}/nodes`);
    const unified = await agent.get(`/api/unified/dashboard?sources=${harness.sourceA}`);
    const perSource = await agent.get(`/api/sources/${harness.sourceA}/dashboard`);
    expect(full.status).toBe(200);
    expect(unified.status).toBe(200);
    expect(perSource.status).toBe(200);
    return {
      full: [...full.body].sort(byNum),
      unified: [...unified.body[0].nodes].sort(byNum),
      perSource: [...perSource.body.nodes].sort(byNum),
    };
  }

  it('admin: same nodes, same visible fields, omitted fields gone', async () => {
    const { full, unified, perSource } = await fetchAll(harness.admin);

    expect(full.map((n: any) => n.nodeNum)).toEqual([0x1001, 0x1002, 0x1003, 0x1004, 0x1005, 0x1006]);
    expect(unified).toEqual(full.map(stripOmitted));
    expect(perSource).toEqual(unified);

    // The full route still carries the omitted fields; the bundle does not.
    const fullPlain = full.find((n: any) => n.nodeNum === 0x1001);
    const slimPlain = unified.find((n: any) => n.nodeNum === 0x1001);
    for (const k of ['macaddr', 'keyMismatchDetected', 'createdAt', 'updatedAt', 'rebootCount', 'positionChannel']) {
      expect(fullPlain).toHaveProperty(k);
      expect(slimPlain).not.toHaveProperty(k);
    }
    // Fields the dashboard reads are still there.
    expect(slimPlain).toMatchObject({ longName: 'Plain', notes: 'kept field', isFavorite: true, latitude: 30.1 });

    // Override applied for admin, private or not.
    expect(unified.find((n: any) => n.nodeNum === 0x1004)).toMatchObject({ latitude: 40, longitude: -100, positionIsOverride: true });
    expect(unified.find((n: any) => n.nodeNum === 0x1005)).toMatchObject({ latitude: 41, longitude: -101, positionIsOverride: true });
  });

  it('limited user: same channel filter, mask and private-override strip as the full route', async () => {
    const { full, unified, perSource } = await fetchAll(harness.limited);

    // Channel 1 node filtered out by both.
    expect(full.map((n: any) => n.nodeNum)).toEqual([0x1001, 0x1003, 0x1004, 0x1005, 0x1006]);
    expect(unified).toEqual(full.map(stripOmitted));
    expect(perSource).toEqual(unified);

    // Position heard on a channel the user can't view is masked.
    const masked = unified.find((n: any) => n.nodeNum === 0x1003);
    expect(masked.latitude).toBeUndefined();
    expect(masked.longitude).toBeUndefined();
    // Private override not applied, and its coordinates are not leaked.
    const priv = unified.find((n: any) => n.nodeNum === 0x1004);
    expect(priv).toMatchObject({ latitude: 33, longitude: -93 });
    expect(priv.positionIsOverride).toBeUndefined();
    expect(JSON.stringify(priv)).not.toContain('-100');
    // Public override applied.
    expect(unified.find((n: any) => n.nodeNum === 0x1005)).toMatchObject({ latitude: 41, longitude: -101, positionIsOverride: true });
  });

  it('a user without nodes:read gets no nodes from either bundle', async () => {
    await harness.revokeAll(harness.limited.id);
    const agent = await harness.loginAs(harness.limited);
    const unified = await agent.get(`/api/unified/dashboard?sources=${harness.sourceA}`);
    const perSource = await agent.get(`/api/sources/${harness.sourceA}/dashboard`);
    expect(unified.body[0].nodes).toEqual([]);
    expect(perSource.body.nodes).toEqual([]);
  });
});
