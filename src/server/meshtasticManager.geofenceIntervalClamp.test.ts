/**
 * Geofence "while inside" interval: clamped where the timer is armed.
 *
 * Node treats a timer delay above 2^31-1 ms (~35,791 minutes) as 1 ms. A
 * stored `whileInsideIntervalMinutes` of 999999 therefore armed a setInterval
 * that fired the trigger, and sent its message, every millisecond. These tests
 * drive the real `initGeofenceEngine` against a stored value and inspect the
 * delay handed to setInterval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetSettingForSource = vi.fn();

vi.mock('./tcpTransport.js', () => ({
  TcpTransport: class {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    send = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    off = vi.fn();
    isConnected = () => true;
    setStaleConnectionTimeout = vi.fn();
    setConnectTimeout = vi.fn();
    setReconnectTiming = vi.fn();
  },
}));

vi.mock('../services/database.js', () => {
  const shared = {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    settings: {
      getSetting: vi.fn().mockResolvedValue(null),
      setSetting: vi.fn().mockResolvedValue(undefined),
      getSettingForSource: (...args: unknown[]) => mockGetSettingForSource(...args),
    },
    getAllTraceroutesForRecalculationAsync: vi.fn().mockResolvedValue([]),
    getAllGeofenceCooldownsAsync: vi.fn().mockResolvedValue([]),
    sources: { getSource: vi.fn().mockResolvedValue(null) },
    nodes: {
      getNode: vi.fn().mockResolvedValue(null),
      upsertNode: vi.fn().mockResolvedValue(undefined),
      getActiveNodes: vi.fn().mockResolvedValue([]),
      getAllNodes: vi.fn().mockResolvedValue([]),
    },
  };
  return { default: shared, databaseService: shared };
});

vi.mock('./services/signFlipCorrection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/signFlipCorrection.js')>();
  return { ...actual, getCachedSignFlipContext: vi.fn().mockResolvedValue(null) };
});

import { MeshtasticManager } from './meshtasticManager.js';
import { MAX_TIMER_DELAY_MS } from './utils/schedulerInterval.js';

function trigger(whileInsideIntervalMinutes: unknown) {
  return {
    id: 'geo-1',
    name: 'Clamp test',
    enabled: true,
    shape: { type: 'circle', center: { lat: 26, lng: -80 }, radiusKm: 1 },
    event: 'while_inside',
    whileInsideIntervalMinutes,
    nodeFilter: { type: 'all' },
    responseType: 'text',
    response: 'hi',
    channel: 'none',
  };
}

async function armWith(value: unknown): Promise<number[]> {
  mockGetSettingForSource.mockImplementation(async (_src: string, key: string) =>
    key === 'geofenceTriggers' ? JSON.stringify([trigger(value)]) : null,
  );
  const spy = vi.spyOn(globalThis, 'setInterval');
  const mgr = new MeshtasticManager('src-geo', { host: '127.0.0.1', port: 4403 });
  spy.mockClear();
  await (mgr as unknown as { initGeofenceEngine(): Promise<void> }).initGeofenceEngine();
  const delays = spy.mock.calls.map((c) => Number(c[1]));
  (mgr as unknown as { geofenceWhileInsideTimers: Map<string, NodeJS.Timeout> })
    .geofenceWhileInsideTimers.forEach((t) => clearInterval(t));
  spy.mockRestore();
  return delays;
}

describe('geofence while_inside interval clamp', () => {
  beforeEach(() => mockGetSettingForSource.mockReset());
  afterEach(() => vi.restoreAllMocks());

  it('clamps a stored 999999 minutes to 1440 and never arms a 1 ms interval', async () => {
    const delays = await armWith(999999);
    expect(delays).toEqual([1440 * 60 * 1000]);
    for (const d of delays) {
      expect(d).toBeGreaterThan(1);
      expect(d).toBeLessThanOrEqual(MAX_TIMER_DELAY_MS);
    }
  });

  it('keeps an in-range value unchanged', async () => {
    expect(await armWith(5)).toEqual([5 * 60 * 1000]);
  });

  it('raises a sub-minimum value to 1 minute', async () => {
    expect(await armWith(0)).toEqual([60 * 1000]);
  });

  it('does not arm a timer when the interval is absent', async () => {
    expect(await armWith(undefined)).toEqual([]);
  });
});
