/**
 * Tests for GeofenceTimezoneService
 *
 * Verifies:
 *   - No-op when disabled (default)
 *   - No-op when no source node configured
 *   - No-op when source node has no GPS yet
 *   - Distance debouncing (no-op below threshold)
 *   - First-run detection (no prior state) writes detected tz + position
 *   - Subsequent run with tz change persists new tz
 *   - Distance triggers re-check even when tz string is same
 *
 * Strategy: stub `lookupTimezone` and `fetchSourceNode` on the service
 * instance so tests don't need a real geo-tz package or DB nodes table.
 * Settings IO is fully mocked at the databaseService boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock databaseService ─────────────────────────────────────────────
const mockGetSetting = vi.fn();
const mockGetSettingAsBoolean = vi.fn();
const mockSetSetting = vi.fn();
const mockGetNodeByNodeId = vi.fn();
const mockGetNode = vi.fn();

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: mockGetSetting,
      getSettingAsBoolean: mockGetSettingAsBoolean,
      setSetting: mockSetSetting,
    },
    nodes: {
      getNodeByNodeId: mockGetNodeByNodeId,
      getNode: mockGetNode,
    },
  },
}));

vi.mock('../../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ─── Helpers ──────────────────────────────────────────────────────────
async function loadService() {
  const mod = await import('./geofenceTimezoneService.js');
  return mod.geofenceTimezoneService;
}

function settingsMap(initial: Record<string, string | null>) {
  const store: Record<string, string | null> = { ...initial };
  mockGetSetting.mockImplementation(async (key: string) => store[key] ?? null);
  mockGetSettingAsBoolean.mockImplementation(
    async (key: string, def: boolean = false) => {
      const v = store[key];
      if (v == null) return def;
      return v === 'true' || v === '1';
    }
  );
  mockSetSetting.mockImplementation(async (key: string, value: string) => {
    store[key] = value;
  });
  return store;
}

describe('GeofenceTimezoneService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no-ops when disabled (default off)', async () => {
    settingsMap({ geofenceTzEnabled: 'false' });
    const svc = await loadService();
    const result = await svc.runNow();
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(mockSetSetting).not.toHaveBeenCalled();
  });

  it('no-ops when enabled but no source node configured', async () => {
    settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: null,
    });
    const svc = await loadService();
    const result = await svc.runNow();
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('no_source_node');
  });

  it('no-ops when source node not found in DB', async () => {
    settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: '!deadbeef',
    });
    mockGetNodeByNodeId.mockResolvedValue(null);
    const svc = await loadService();
    const result = await svc.runNow();
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('node_not_found');
  });

  it('no-ops when source node has no GPS yet', async () => {
    settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: '!deadbeef',
    });
    mockGetNodeByNodeId.mockResolvedValue({ latitude: null, longitude: null });
    const svc = await loadService();
    const result = await svc.runNow();
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('no_gps');
  });

  it('detects new timezone on first run (no prior position)', async () => {
    const store = settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: '!deadbeef',
      geofenceTzThresholdMiles: '20',
    });
    mockGetNodeByNodeId.mockResolvedValue({
      latitude: 33.5387,
      longitude: -112.185, // Glendale AZ
    });
    const svc = await loadService();
    vi.spyOn(svc, 'lookupTimezone').mockResolvedValue('America/Phoenix');

    const result = await svc.runNow();
    expect(result.detected).toBe(true);
    expect(result.timezone).toBe('America/Phoenix');
    expect(store.geofenceTzDetected).toBe('America/Phoenix');
    expect(parseFloat(store.geofenceTzLastLat as string)).toBeCloseTo(33.5387, 3);
    expect(parseFloat(store.geofenceTzLastLon as string)).toBeCloseTo(-112.185, 3);
  });

  it('debounces small movements below threshold when tz unchanged', async () => {
    const store = settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: '!deadbeef',
      geofenceTzThresholdMiles: '20',
      geofenceTzLastLat: '33.5387',
      geofenceTzLastLon: '-112.185',
      geofenceTzDetected: 'America/Phoenix',
    });
    mockGetNodeByNodeId.mockResolvedValue({
      latitude: 33.5400, // <0.1 miles north
      longitude: -112.185,
    });
    const svc = await loadService();
    vi.spyOn(svc, 'lookupTimezone').mockResolvedValue('America/Phoenix');

    const result = await svc.runNow();
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('no_change');
    // Last-applied position should NOT be updated (debounce)
    expect(store.geofenceTzLastLat).toBe('33.5387');
  });

  it('triggers re-detection when distance crosses threshold', async () => {
    const store = settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: '!deadbeef',
      geofenceTzThresholdMiles: '20',
      geofenceTzLastLat: '33.5387',
      geofenceTzLastLon: '-112.185',
      geofenceTzDetected: 'America/Phoenix',
    });
    // ~370 miles east — well over 20mi threshold
    mockGetNodeByNodeId.mockResolvedValue({
      latitude: 35.0844,
      longitude: -106.6504, // Albuquerque NM
    });
    const svc = await loadService();
    vi.spyOn(svc, 'lookupTimezone').mockResolvedValue('America/Denver');

    const result = await svc.runNow();
    expect(result.detected).toBe(true);
    expect(result.timezone).toBe('America/Denver');
    expect(result.distanceMiles).toBeGreaterThan(300);
    expect(store.geofenceTzDetected).toBe('America/Denver');
  });

  it('detects tz change even if distance is below threshold (e.g. crossing tz boundary nearby)', async () => {
    const store = settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: '!deadbeef',
      geofenceTzThresholdMiles: '50',
      // Phoenix area
      geofenceTzLastLat: '33.5387',
      geofenceTzLastLon: '-112.185',
      geofenceTzDetected: 'America/Phoenix',
    });
    // Just a few miles away but tz lookup returns different zone
    // (this can happen near the AZ/NV border in real life)
    mockGetNodeByNodeId.mockResolvedValue({
      latitude: 33.55,
      longitude: -112.20,
    });
    const svc = await loadService();
    vi.spyOn(svc, 'lookupTimezone').mockResolvedValue('America/Los_Angeles');

    const result = await svc.runNow();
    expect(result.detected).toBe(true);
    expect(result.timezone).toBe('America/Los_Angeles');
    expect(store.geofenceTzDetected).toBe('America/Los_Angeles');
  });

  it('handles tz lookup failure gracefully', async () => {
    settingsMap({
      geofenceTzEnabled: 'true',
      geofenceTzSourceNodeId: '!deadbeef',
    });
    mockGetNodeByNodeId.mockResolvedValue({ latitude: 0, longitude: 0 });
    const svc = await loadService();
    vi.spyOn(svc, 'lookupTimezone').mockResolvedValue(null);

    const result = await svc.runNow();
    expect(result.detected).toBe(false);
    expect(result.reason).toBe('tz_lookup_failed');
  });

  it('start() and stop() manage the interval timer', async () => {
    settingsMap({ geofenceTzEnabled: 'false' });
    const svc = await loadService();
    expect(svc.getStatus().running).toBe(false);
    svc.start(15);
    expect(svc.getStatus().running).toBe(true);
    svc.stop();
    expect(svc.getStatus().running).toBe(false);
  });

  it('start() is idempotent — second call is a no-op', async () => {
    const svc = await loadService();
    svc.start(15);
    svc.start(15); // should warn but not throw
    expect(svc.getStatus().running).toBe(true);
    svc.stop();
  });
});

describe('GeofenceTimezoneService — distance math sanity', () => {
  it('Haversine distance reference: Phoenix → Albuquerque ~330mi', async () => {
    // Independent sanity-check that the underlying distance function
    // returns sane values for known endpoints. This is the reason a tz
    // change at ABQ from a Phoenix-anchored last-applied position
    // crosses any reasonable threshold.
    const { calculateDistance, kmToMiles } = await import('../../utils/distance.js');
    const km = calculateDistance(33.5387, -112.185, 35.0844, -106.6504);
    const miles = kmToMiles(km);
    // Real great-circle distance ~330 miles
    expect(miles).toBeGreaterThan(300);
    expect(miles).toBeLessThan(400);
  });

  it('Haversine distance reference: NYC → LA ~2450mi', async () => {
    const { calculateDistance, kmToMiles } = await import('../../utils/distance.js');
    const km = calculateDistance(40.7128, -74.006, 34.0522, -118.2437);
    const miles = kmToMiles(km);
    expect(miles).toBeGreaterThan(2400);
    expect(miles).toBeLessThan(2500);
  });
});
