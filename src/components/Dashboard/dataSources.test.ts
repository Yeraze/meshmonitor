/**
 * Tests for the Dashboard data-source adapters (meshtastic + meshcore).
 * Regression coverage for #3139 — verifies the MeshCore adapter maps
 * its native node shape into the NodeInfo shape the Dashboard consumes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/api', () => ({
  default: { get: vi.fn() },
}));
vi.mock('../../utils/deviceRole', () => ({
  // Stand-in that returns a recognisable label per Meshtastic role int
  getDeviceRoleName: (r: number | string) => `role-${r}`,
}));

import api from '../../services/api';
import { meshcoreDashboardSource, meshtasticDashboardSource } from './dataSources';

const mockedApiGet = api.get as unknown as ReturnType<typeof vi.fn>;

describe('meshcoreDashboardSource', () => {
  beforeEach(() => {
    mockedApiGet.mockReset();
  });

  it('fetches per-source MeshCore nodes and adapts them into NodeInfo', async () => {
    mockedApiGet.mockResolvedValueOnce({
      data: [
        {
          publicKey: 'abcd1234',
          name: 'Repeater A',
          advType: 2,
          lastHeard: 1_700_000_000,
          rssi: -90,
          snr: 5.5,
          latitude: 30.1,
          longitude: -90.1,
        },
        {
          publicKey: 'ef567890',
          name: 'Companion B',
          advType: 1,
          // no location — should not synthesize a position
        },
      ],
    });

    const nodes = await meshcoreDashboardSource.fetchNodes('src-1');

    expect(mockedApiGet).toHaveBeenCalledWith('/api/sources/src-1/meshcore/nodes');
    expect(nodes).toHaveLength(2);

    expect(nodes[0]).toMatchObject({
      nodeNum: 0,
      user: {
        id: 'abcd1234',
        longName: 'Repeater A',
        role: 2,
      },
      lastHeard: 1_700_000_000,
      rssi: -90,
      snr: 5.5,
      position: { latitude: 30.1, longitude: -90.1 },
    });

    expect(nodes[1].position).toBeUndefined();
  });

  it('returns an empty array when no sourceId is provided', async () => {
    const nodes = await meshcoreDashboardSource.fetchNodes(null);
    expect(nodes).toEqual([]);
    expect(mockedApiGet).not.toHaveBeenCalled();
  });

  it('tolerates an unwrapped array response (no { data } envelope)', async () => {
    mockedApiGet.mockResolvedValueOnce([
      { publicKey: 'pk1', name: 'N1', advType: 1 },
    ]);
    const nodes = await meshcoreDashboardSource.fetchNodes('src-1');
    expect(nodes).toHaveLength(1);
    expect(nodes[0].user?.id).toBe('pk1');
  });

  it('keys nodes by publicKey (via user.id)', () => {
    const node = { nodeNum: 0, user: { id: 'pk-xyz' } };
    expect(meshcoreDashboardSource.nodeKey(node)).toBe('pk-xyz');
  });

  it('uses longName for display, falling back to shortName then the fallback id', () => {
    expect(meshcoreDashboardSource.getDisplayName(
      { nodeNum: 0, user: { id: 'pk', longName: 'Full Name', shortName: 'FN' } },
      'pk',
    )).toBe('Full Name');

    expect(meshcoreDashboardSource.getDisplayName(
      { nodeNum: 0, user: { id: 'pk', shortName: 'FN' } },
      'pk',
    )).toBe('FN');

    expect(meshcoreDashboardSource.getDisplayName(undefined, 'fallback-id')).toBe('fallback-id');
  });

  it('labels MeshCore advType correctly (companion/repeater/room)', () => {
    expect(meshcoreDashboardSource.getRoleName({ nodeNum: 0, user: { id: 'a', role: 1 } })).toBe('Companion');
    expect(meshcoreDashboardSource.getRoleName({ nodeNum: 0, user: { id: 'a', role: 2 } })).toBe('Repeater');
    expect(meshcoreDashboardSource.getRoleName({ nodeNum: 0, user: { id: 'a', role: 3 } })).toBe('Room Server');
    expect(meshcoreDashboardSource.getRoleName({ nodeNum: 0, user: { id: 'a', role: 0 } })).toBe('Unknown');
    expect(meshcoreDashboardSource.getRoleName(undefined)).toBeNull();
    expect(meshcoreDashboardSource.getRoleName({ nodeNum: 0, user: { id: 'a' } })).toBeNull();
  });

  it('hides custom widgets (no nodeStatus/traceroute for MeshCore yet)', () => {
    expect(meshcoreDashboardSource.showCustomWidgets).toBe(false);
  });

  it('marks ch1..ch4 LPP env sensors as solar-default-on', () => {
    expect(meshcoreDashboardSource.solarDefaultTypes.has('mc_battery_volts_ch1')).toBe(true);
    expect(meshcoreDashboardSource.solarDefaultTypes.has('mc_battery_volts_ch4')).toBe(true);
    expect(meshcoreDashboardSource.solarDefaultTypes.has('mc_temperature_ch1')).toBe(true);
    expect(meshcoreDashboardSource.solarDefaultTypes.has('mc_humidity_ch2')).toBe(true);
    expect(meshcoreDashboardSource.solarDefaultTypes.has('mc_status_uptime_secs')).toBe(false);
  });
});

describe('meshtasticDashboardSource (regression — default unchanged)', () => {
  beforeEach(() => {
    mockedApiGet.mockReset();
  });

  it('still hits /api/nodes with the source-query suffix', async () => {
    mockedApiGet.mockResolvedValueOnce([
      { nodeNum: 1, user: { id: '!aabb' } },
    ]);
    const nodes = await meshtasticDashboardSource.fetchNodes('src-2');
    expect(mockedApiGet).toHaveBeenCalledWith('/api/nodes?sourceId=src-2');
    expect(nodes).toHaveLength(1);
  });

  it('shows custom widgets (Meshtastic preserves the prior behaviour)', () => {
    expect(meshtasticDashboardSource.showCustomWidgets).toBe(true);
  });

  it('keys nodes by user.id', () => {
    expect(meshtasticDashboardSource.nodeKey({ nodeNum: 1, user: { id: '!abcd' } })).toBe('!abcd');
  });
});
