/**
 * Regression test for #5413 (auto-pathfinding call site): Auto-Pathfinding's
 * repeater leg calls `getNeighbours()` to populate the same
 * `meshcore_neighbors` table the neighbours autopoll scheduler and manual
 * "poll now" button write to. Like those two paths, it used to omit `count`
 * and silently fall back to `getNeighbours`'s own default of 10, so a run
 * could overwrite a fuller neighbour set (already corrected elsewhere) with
 * a truncated one for any repeater reporting more than 10 neighbours.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeshCoreManager, MeshCoreDeviceType, MAX_NEIGHBOURS_COUNT } from './meshcoreManager.js';
import { logger } from '../utils/logger.js';
import databaseService from '../services/database.js';

function mockPathfindingSettings() {
  return vi.spyOn(databaseService.settings, 'getSettingForSource').mockImplementation(
    async (_sourceId: string | null | undefined, key: string) => {
      switch (key) {
        case 'meshcoreAutoPathfindingEnabled':
          return 'true';
        case 'meshcoreAutoPathfindingPathDiscoveryEnabled':
          return 'false';
        case 'meshcoreAutoPathfindingNeighborsEnabled':
          return 'true';
        case 'meshcoreAutoPathfindingIntervalMinutes':
          return '3';
        case 'meshcoreAutoPathfindingRepeatHours':
          return '1';
        default:
          return null;
      }
    }
  );
}

function makeRepeaterContacts(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    publicKey: `repeater-${i}`,
    advName: `Repeater ${i}`,
    name: `Repeater ${i}`,
    advType: MeshCoreDeviceType.REPEATER,
  }));
}

describe('MeshCoreManager Auto-Pathfinding neighbours request size (#5413)', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    // Deterministic jitter: initialJitterMs = Math.random() * maxJitterMs.
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(databaseService, 'getMeshcorePathfindingFilterSettingsAsync').mockResolvedValue({
      enabled: false, targetKeys: [], contactsEnabled: false, regexEnabled: false, nameRegex: '.*',
      lastHeardEnabled: false, lastHeardHours: 168, hopsEnabled: false, hopsMin: 0, hopsMax: 10,
      signalEnabled: false, rssiMin: -200, snrMin: -100,
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('requests MAX_NEIGHBOURS_COUNT for a repeater target, not the getNeighbours default of 10', async () => {
    const m = new MeshCoreManager('test-source');
    mockPathfindingSettings();
    (m as any).connected = true;
    (m as any).canTransmit = vi.fn().mockReturnValue(true);
    (m as any).getContacts = vi.fn().mockReturnValue(makeRepeaterContacts(1));
    const getNeighbours = vi.fn().mockResolvedValue({ total: 0, neighbours: [] });
    (m as any).getNeighbours = getNeighbours;

    await m.startAutoPathfinding();
    // Fire the jitter timeout (0ms) to start the run.
    await vi.advanceTimersByTimeAsync(0);

    expect(getNeighbours).toHaveBeenCalledWith('repeater-0', { count: MAX_NEIGHBOURS_COUNT });
    expect(getNeighbours).not.toHaveBeenCalledWith('repeater-0', undefined);
  });
});
