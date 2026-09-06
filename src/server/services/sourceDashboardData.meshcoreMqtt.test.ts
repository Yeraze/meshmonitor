/**
 * buildSourceNodes — a `meshcore_mqtt` ingest source reaches the MeshCore
 * branch (issue #5094).
 *
 * #5040 Phase 5.5 widened the MANAGER narrow inside this function to
 * `isAnyMeshCoreManager`, and left a comment saying ingest nodes now reach the
 * map. The outer `source.type === 'meshcore'` gate above it meant they never
 * did: rows landed in `meshcore_nodes`, the DB showed them, the UI did not.
 * Reported from the field on 4.16.0-RC4.
 *
 * The regression these tests protect is the OUTER gate, so they drive
 * buildSourceNodes with `type: 'meshcore_mqtt'` — the exact shape the router
 * passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSourceNodes } from './sourceDashboardData.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { User } from '../../types/auth.js';

const INGEST_NODE = {
  publicKey: 'b'.repeat(64),
  name: 'Observed Repeater',
  latitude: 39.5,
  longitude: -104.5,
  advType: 1,
  lastHeard: Date.now(),
};

vi.mock('../sourceManagerRegistry.js', () => {
  // sourceType 'meshcore_mqtt' — isAnyMeshCoreManager accepts it, the
  // device-only isMeshCoreManager does not.
  const ingestStub = {
    sourceId: 'rt-source-a',
    sourceType: 'meshcore_mqtt' as const,
    getAllNodes: async () => [INGEST_NODE],
  };
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => (sourceId === 'rt-source-a' ? ingestStub : undefined),
      getAllManagers: () => [ingestStub],
    },
  };
});

describe('buildSourceNodes — meshcore_mqtt ingest source (#5094)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const ingestRow = { id: 'rt-source-a', name: 'Region Feed', type: 'meshcore_mqtt' };

  /** One row carries both flags — permissions are unique per (user, resource, source). */
  const grantReadAndViewOnMap = () =>
    harness.db.auth.createPermission({
      userId: harness.limited.id,
      resource: 'nodes',
      canRead: true,
      canViewOnMap: true,
      canWrite: false,
      sourceId: 'rt-source-a',
      grantedAt: Date.now(),
      grantedBy: null,
    });

  it('returns positioned ingest nodes instead of falling through to the Meshtastic branch', async () => {
    await grantReadAndViewOnMap();

    const result = await buildSourceNodes(ingestRow, harness.limited as unknown as User);

    expect(result).toHaveLength(1);
    const node = result[0] as Record<string, unknown>;
    expect(node.longName).toBe('Observed Repeater');
    expect(node.latitude).toBe(39.5);
    expect(node.longitude).toBe(-104.5);
  });

  it('applies the same nodes:viewOnMap gate device-backed MeshCore sources get', async () => {
    // nodes:read alone must not publish positions — the permission model does
    // not loosen just because the source has no radio.
    await harness.db.auth.createPermission({
      userId: harness.limited.id,
      resource: 'nodes',
      canRead: true,
      canViewOnMap: false,
      canWrite: false,
      sourceId: 'rt-source-a',
      grantedAt: Date.now(),
      grantedBy: null,
    });

    const result = await buildSourceNodes(ingestRow, harness.limited as unknown as User);
    expect(result).toEqual([]);
  });

  it('builds the mc: node id from the ingest source, not a Meshtastic nodeNum', async () => {
    // Falling through to the Meshtastic branch produced numeric node ids from
    // an empty `nodes` table — i.e. nothing at all. The `mc:` prefix is the
    // cheapest proof the MeshCore branch actually ran.
    await grantReadAndViewOnMap();

    const result = await buildSourceNodes(ingestRow, harness.limited as unknown as User);
    const node = result[0] as Record<string, unknown>;
    expect(String(node.nodeId)).toBe(`mc:rt-source-a:${'b'.repeat(12)}`);
  });
});
