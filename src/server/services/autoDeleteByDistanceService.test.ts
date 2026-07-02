/**
 * Tests for the per-source re-entrancy guard on autoDeleteByDistanceService
 * (issue #3901). Each source may run its own delete cycle concurrently; only a
 * SECOND in-flight cycle for the SAME source is skipped. (Previously a single
 * global `isRunning` boolean let one source's cycle block every other source.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSettingForSource = vi.fn();
const getAllNodes = vi.fn();
const addDistanceDeleteLogEntry = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    settings: { getSettingForSource: (...a: unknown[]) => getSettingForSource(...a) },
    nodes: { getAllNodes: (...a: unknown[]) => getAllNodes(...a) },
    misc: { addDistanceDeleteLogEntry: (...a: unknown[]) => addDistanceDeleteLogEntry(...a) },
    deleteNodeAsync: vi.fn(),
    setNodeIgnoredAsync: vi.fn(),
  },
}));

vi.mock('../utils/resolveSourceManager.js', () => ({
  resolveSourceManager: () => ({ sendIgnoredNode: vi.fn() }),
}));

vi.mock('../utils/nodeEnhancer.js', () => ({
  getEffectiveDbNodePosition: (n: { latitude?: number | null; longitude?: number | null }) => ({
    latitude: n.latitude ?? null,
    longitude: n.longitude ?? null,
  }),
}));

import { autoDeleteByDistanceService } from './autoDeleteByDistanceService.js';

describe('autoDeleteByDistanceService — per-source run guard (#3901)', () => {
  beforeEach(() => {
    getSettingForSource.mockReset();
    getAllNodes.mockReset().mockResolvedValue([]);
    addDistanceDeleteLogEntry.mockReset().mockResolvedValue(undefined);
  });

  it('lets a different source run while one source is in-flight, and skips the same source', async () => {
    // Source A hangs on its FIRST settings read, keeping its cycle "running".
    let aCalls = 0;
    let releaseA!: () => void;
    getSettingForSource.mockImplementation((sourceId: string, key: string) => {
      if (sourceId === 'A' && aCalls++ === 0) {
        return new Promise<string>((res) => { releaseA = () => res('0'); });
      }
      const vals: Record<string, string> = {
        autoDeleteByDistanceLat: '0',
        autoDeleteByDistanceLon: '0',
        autoDeleteByDistanceThresholdKm: '100',
        autoDeleteByDistanceAction: 'delete',
      };
      return Promise.resolve(vals[key] ?? null);
    });

    const pA1 = autoDeleteByDistanceService.runDeleteCycle('A'); // parks in-flight

    // Same source while A is still running → skipped, no scan.
    const skipped = await autoDeleteByDistanceService.runDeleteCycle('A');
    expect(skipped).toEqual({ deletedCount: 0 });
    expect(getAllNodes).not.toHaveBeenCalledWith('A');

    // Different source proceeds concurrently.
    const bResult = await autoDeleteByDistanceService.runDeleteCycle('B');
    expect(bResult).toEqual({ deletedCount: 0 });
    expect(getAllNodes).toHaveBeenCalledWith('B');

    // Release A and let it finish cleanly.
    releaseA();
    await pA1;
  });

  it('clears the guard after a cycle completes, so the same source can run again', async () => {
    getSettingForSource.mockImplementation((_sourceId: string, key: string) => {
      const vals: Record<string, string> = {
        autoDeleteByDistanceLat: '0',
        autoDeleteByDistanceLon: '0',
        autoDeleteByDistanceThresholdKm: '100',
        autoDeleteByDistanceAction: 'delete',
      };
      return Promise.resolve(vals[key] ?? null);
    });

    await autoDeleteByDistanceService.runDeleteCycle('A');
    await autoDeleteByDistanceService.runDeleteCycle('A');

    // Both sequential runs actually scanned (neither spuriously skipped).
    expect(getAllNodes.mock.calls.filter((c) => c[0] === 'A')).toHaveLength(2);
  });
});
