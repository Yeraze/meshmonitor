/**
 * Regression test for issue #5413: the MeshCore neighbours table only ever
 * showed 10 entries for a repeater, even when it reported more.
 *
 * `pollNeighborsAndStore` — shared by the neighbours autopoll scheduler
 * (#4618) and the manual per-node "poll now" route — used to call
 * `getNeighbours(publicKey)` with no `count` override, silently falling back
 * to `getNeighbours`'s own default of 10. The interactive "Neighbours" button
 * in the Contact Details panel already requests up to `MAX_NEIGHBOURS_COUNT`
 * (20 from the UI, clamped to 50 server-side), so the stored/autopoll path
 * should request the same ceiling rather than a lower, unrelated default.
 */
import { describe, it, expect, vi } from 'vitest';

const insertNeighborsBatch = vi.fn().mockResolvedValue(undefined);

vi.mock('../services/database.js', () => ({
  default: {
    meshcore: {
      insertNeighborsBatch: (...args: unknown[]) => insertNeighborsBatch(...args),
    },
  },
}));

import { MeshCoreManager, MeshCoreDeviceType, MAX_NEIGHBOURS_COUNT } from './meshcoreManager.js';

const KEY = 'a'.repeat(64);

function makeManager() {
  const m = new MeshCoreManager('test-source') as any;
  m.deviceType = MeshCoreDeviceType.COMPANION;
  m.connected = true;
  m.ensureSavedLogin = vi.fn().mockResolvedValue(undefined);
  m.requireTransmit = vi.fn();
  return m;
}

describe('MeshCoreManager.pollNeighborsAndStore — request size (#5413)', () => {
  it('requests MAX_NEIGHBOURS_COUNT, not the getNeighbours default of 10', async () => {
    const m = makeManager();
    const bridgeCalls: Array<{ cmd: string; params: any }> = [];
    m.sendBridgeCommand = vi.fn(async (cmd: string, params: any) => {
      bridgeCalls.push({ cmd, params });
      return { id: '1', success: true, data: { total: 12, neighbours: [] } };
    });

    await m.pollNeighborsAndStore(KEY);

    expect(bridgeCalls).toHaveLength(1);
    expect(bridgeCalls[0].cmd).toBe('get_neighbours');
    expect(bridgeCalls[0].params.count).toBe(MAX_NEIGHBOURS_COUNT);
    expect(bridgeCalls[0].params.count).toBeGreaterThan(10);
  });

  it('reports the full total reported by the repeater, not just what a count=10 page would hold', async () => {
    const m = makeManager();
    m.sendBridgeCommand = vi.fn().mockResolvedValue({
      id: '1',
      success: true,
      data: { total: 15, neighbours: [] },
    });

    const result = await m.pollNeighborsAndStore(KEY);

    expect(result?.total).toBe(15);
  });
});
