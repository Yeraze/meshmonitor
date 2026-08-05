/**
 * buildSourceNodes — MeshCore contacts require nodes:viewOnMap, not just
 * nodes:read, before positions reach the Dashboard/Unified/Map Analysis maps
 * (issue #4559).
 *
 * Before this fix, the MeshCore branch of buildSourceNodes() returned every
 * positioned contact once the caller had nodes:read — mirroring Meshtastic's
 * nodes:read gate but skipping the additional per-channel viewOnMap gate
 * Meshtastic applies via filterNodesByChannelPermission/maskNodeLocationByChannel.
 * MeshCore has no per-channel granularity here, so this uses a single
 * per-source nodes:viewOnMap check instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildSourceNodes } from './sourceDashboardData.js';
import { createRouteTestApp, type RouteTestHarness } from '../test-helpers/routeTestApp.js';
import type { User } from '../../types/auth.js';

const STUB_CONTACT = {
  publicKey: 'a'.repeat(64),
  name: 'Repeater One',
  latitude: 40.0,
  longitude: -105.0,
  advType: 1,
  lastHeard: Math.floor(Date.now() / 1000),
};

vi.mock('../sourceManagerRegistry.js', () => {
  const stub = {
    sourceId: 'rt-source-a',
    sourceType: 'meshcore' as const,
    getAllNodes: async () => [STUB_CONTACT],
  };
  return {
    sourceManagerRegistry: {
      getManager: (sourceId: string) => (sourceId === 'rt-source-a' ? stub : undefined),
      getAllManagers: () => [stub],
    },
  };
});

describe('buildSourceNodes — MeshCore nodes:viewOnMap gate (#4559)', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestApp({ mount: () => {} });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  const sourceRow = { id: 'rt-source-a', name: 'MeshCore Source', type: 'meshcore' };

  it('returns no contacts for a user with nodes:read but not nodes:viewOnMap', async () => {
    await harness.grant(harness.limited.id, 'nodes', 'read', harness.sourceA);
    const result = await buildSourceNodes(sourceRow, harness.limited as unknown as User);
    expect(result).toEqual([]);
  });

  it('returns positioned contacts once nodes:viewOnMap is also granted', async () => {
    await harness.db.auth.createPermission({
      userId: harness.limited.id,
      resource: 'nodes',
      canRead: true,
      canViewOnMap: true,
      canWrite: false,
      sourceId: 'rt-source-a',
      grantedAt: Date.now(),
      grantedBy: null,
    });

    const result = await buildSourceNodes(sourceRow, harness.limited as unknown as User);
    expect(result).toHaveLength(1);
    expect((result[0] as any).latitude).toBe(40.0);
    expect((result[0] as any).longitude).toBe(-105.0);
  });

  it('anonymous caller with no grant at all sees nothing', async () => {
    const result = await buildSourceNodes(sourceRow, harness.anonymous as unknown as User);
    expect(result).toEqual([]);
  });

  it('admin bypasses the gate with no explicit grant', async () => {
    const result = await buildSourceNodes(sourceRow, harness.admin as unknown as User);
    expect(result).toHaveLength(1);
  });
});
