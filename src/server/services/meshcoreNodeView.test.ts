import { describe, it, expect, vi, beforeEach } from 'vitest';

const getNodesBySource = vi.fn();
const getNodesHeardSince = vi.fn();
const getPositionOverridesBySource = vi.fn();
vi.mock('../../services/database.js', () => ({
  default: {
    meshcore: {
      getNodesBySource: (...a: unknown[]) => getNodesBySource(...a),
      getNodesHeardSince: (...a: unknown[]) => getNodesHeardSince(...a),
      getPositionOverridesBySource: (...a: unknown[]) => getPositionOverridesBySource(...a),
    },
    settings: { getSetting: vi.fn().mockResolvedValue(null), getLocalNodeNumForSource: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('./signFlipCorrection.js', () => ({ applySignFlipToMeshCoreRows: async (rows: unknown[]) => rows }));

import { loadMeshCoreNodesForViewer } from './meshcoreNodeView.js';
import type { NodeViewAccess } from '../utils/nodeEnhancer.js';

const access = (o: { admin?: boolean; viewOnMap?: boolean; priv?: boolean }): NodeViewAccess => ({
  isAdmin: !!o.admin,
  permissions: { isAdmin: !!o.admin, can: (r: string, a: string) => !!(o.admin || (r === 'nodes' && a === 'viewOnMap' && o.viewOnMap)) } as never,
  canViewNode: () => true,
  canViewPrivate: () => !!(o.admin || o.priv),
  sources: 'all',
});

const K1 = 'a'.repeat(64);
const K2 = 'b'.repeat(64);
const rows = () => [
  { publicKey: K1, latitude: 10, longitude: 20, lastHeard: 5 },
  { publicKey: K2, latitude: 11, longitude: 21, lastHeard: 4 },
];

describe('loadMeshCoreNodesForViewer', () => {
  beforeEach(() => {
    getNodesBySource.mockReset().mockResolvedValue(rows());
    getNodesHeardSince.mockReset().mockResolvedValue(rows());
    getPositionOverridesBySource.mockReset().mockResolvedValue(new Map());
  });

  it('keeps positions with viewOnMap', async () => {
    const out = await loadMeshCoreNodesForViewer('s', access({ viewOnMap: true }), { positions: true });
    expect(out[0].latitude).toBe(10);
  });

  it('strips positions without viewOnMap, and when positions:false even for admins', async () => {
    const noGrant = await loadMeshCoreNodesForViewer('s', access({}), { positions: true });
    expect('latitude' in noGrant[0]).toBe(false);
    const admin = await loadMeshCoreNodesForViewer('s', access({ admin: true }), { positions: false });
    expect('latitude' in admin[0]).toBe(false);
    expect('longitude' in admin[1]).toBe(false);
  });

  it('applies an enabled override, hiding a private one without nodes_private:read', async () => {
    getPositionOverridesBySource.mockResolvedValue(new Map([[K1, { enabled: true, isPrivate: true, latitude: 1, longitude: 2, altitude: null }]]));
    const hidden = await loadMeshCoreNodesForViewer('s', access({ viewOnMap: true }), { positions: true });
    const shown = await loadMeshCoreNodesForViewer('s', access({ viewOnMap: true, priv: true }), { positions: true });
    expect(hidden[0].latitude).toBe(10);
    expect(shown[0].latitude).toBe(1);
  });

  it('uses the heard-since read when a window is given', async () => {
    await loadMeshCoreNodesForViewer('s', access({ admin: true }), { positions: false, heardSinceMs: 99, limit: 7 });
    expect(getNodesHeardSince).toHaveBeenCalledWith('s', 99, 7);
    expect(getNodesBySource).not.toHaveBeenCalled();
  });
});
