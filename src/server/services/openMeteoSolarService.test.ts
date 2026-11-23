/**
 * Open-Meteo per-node sunlight fetcher (#6523).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const settings = new Map<string, string>();
const lastFetched = new Map<string, number>();
const replaced: Array<{ key: string; rows: unknown[] }> = [];
let mtNodes: Array<Record<string, unknown>> = [];
let mcNodes: Array<Record<string, unknown>> = [];

vi.mock('../../services/database.js', () => ({
  default: {
    settings: {
      getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
      setSetting: vi.fn(async (k: string, v: string) => { settings.set(k, v); }),
    },
    nodes: { getActiveNodes: vi.fn(async () => mtNodes) },
    meshcore: { getAllNodes: vi.fn(async () => mcNodes) },
    solarIrradiance: {
      getLastFetchedAt: vi.fn(async (keys: string[]) => new Map(keys.filter(k => lastFetched.has(k)).map(k => [k, lastFetched.get(k)!]))),
      replaceCellRows: vi.fn(async (key: string, rows: unknown[], fetchedAt: number) => {
        replaced.push({ key, rows });
        lastFetched.set(key, fetchedAt);
      }),
      deleteOlderThan: vi.fn(async () => {}),
    },
  },
}));

vi.mock('./signFlipCorrection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./signFlipCorrection.js')>()),
  getCachedSignFlipContext: vi.fn(async () => null),
}));

import {
  cellFor,
  callsPerDay,
  freeTierCellCap,
  buildUrl,
  toRows,
  distinctCells,
  collectActivePositions,
  openMeteoSolarService,
} from './openMeteoSolarService.js';

const NOW_S = 1_795_305_600;

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

function location(t: number) {
  return { hourly: { time: [t, t + 3600], shortwave_radiation: [0, 250.5], cloud_cover: [100, null] } };
}

function mtNode(lat: number, lon: number, extra: Record<string, unknown> = {}) {
  return { latitude: lat, longitude: lon, lastHeard: NOW_S - 60, ...extra };
}

describe('pure helpers', () => {
  it('cellFor snaps to the cell centre and keys by grid', () => {
    expect(cellFor(40.0123, -89.9876, 0.1)).toEqual({ key: '0.1:40.05:-89.95', latitude: 40.05, longitude: -89.95 });
    expect(cellFor(40.0123, -89.9876, 1).key).toBe('1:40.5:-89.5');
    // Two nodes ~2 km apart share a 0.1° cell.
    expect(cellFor(40.01, -89.91, 0.1).key).toBe(cellFor(40.03, -89.93, 0.1).key);
  });

  it('callsPerDay and freeTierCellCap', () => {
    expect(callsPerDay(100, 3)).toBe(800);
    expect(callsPerDay(1, 24)).toBe(1);
    expect(freeTierCellCap(3)).toBe(1125);
    expect(freeTierCellCap(1)).toBe(375);
  });

  it('buildUrl uses epoch seconds and switches host + key with an API key', () => {
    const cells = [cellFor(40, -90, 0.1), cellFor(35, -106, 0.1)];
    const free = new URL(buildUrl(cells, ''));
    expect(free.host).toBe('api.open-meteo.com');
    expect(free.searchParams.get('timeformat')).toBe('unixtime');
    expect(free.searchParams.get('latitude')).toBe('40.05,35.05');
    expect(free.searchParams.get('hourly')).toBe('shortwave_radiation,cloud_cover');
    expect(free.searchParams.has('apikey')).toBe(false);
    const paid = new URL(buildUrl(cells, 'k123'));
    expect(paid.host).toBe('customer-api.open-meteo.com');
    expect(paid.searchParams.get('apikey')).toBe('k123');
  });

  it('toRows maps hourly arrays and tolerates gaps', () => {
    expect(toRows(location(100))).toEqual([
      { timestamp: 100, shortwaveRadiation: 0, cloudCover: 100 },
      { timestamp: 3700, shortwaveRadiation: 250.5, cloudCover: null },
    ]);
    expect(toRows({})).toEqual([]);
  });

  it('distinctCells keeps first-seen order', () => {
    const cells = distinctCells([{ latitude: 1, longitude: 1 }, { latitude: 5, longitude: 5 }, { latitude: 1.01, longitude: 1.01 }], 0.1);
    expect(cells.map(c => c.key)).toEqual(['0.1:1.05:1.05', '0.1:5.05:5.05']);
  });
});

describe('collectActivePositions', () => {
  beforeEach(() => { mtNodes = []; mcNodes = []; });

  it('uses overrides, skips private overrides and bogus positions, newest first, both protocols', async () => {
    mtNodes = [
      mtNode(10, 10, { lastHeard: NOW_S - 500 }),
      mtNode(11, 11, { positionOverrideEnabled: true, latitudeOverride: 20, longitudeOverride: 20, lastHeard: NOW_S - 100 }),
      mtNode(12, 12, { positionOverrideEnabled: true, positionOverrideIsPrivate: true, latitudeOverride: 30, longitudeOverride: 30 }),
      mtNode(0, 0),
      { latitude: null, longitude: null, lastHeard: NOW_S },
    ];
    mcNodes = [
      { latitude: 40, longitude: 40, lastHeard: NOW_S * 1000 - 50_000 },
      { latitude: 41, longitude: 41, lastHeard: 1000 }, // stale
      { latitude: 42, longitude: 42, lastHeard: NOW_S * 1000, positionOverrideEnabled: true, positionOverrideIsPrivate: true },
    ];
    vi.useFakeTimers();
    vi.setSystemTime(NOW_S * 1000);
    try {
      expect(await collectActivePositions()).toEqual([
        { latitude: 40, longitude: 40 },
        { latitude: 20, longitude: 20 },
        { latitude: 10, longitude: 10 },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('refresh', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    settings.clear();
    lastFetched.clear();
    replaced.length = 0;
    mtNodes = [];
    mcNodes = [];
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    openMeteoSolarService.sleep = vi.fn(async () => {});
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_S * 1000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does nothing while disabled', async () => {
    mtNodes = [mtNode(40, -90)];
    expect(await openMeteoSolarService.refresh()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches due cells and stores rows per cell, handling a single-object response', async () => {
    settings.set('solarMonitoringEnabled', '1');
    mtNodes = [mtNode(40, -90)];
    fetchMock.mockResolvedValue(okResponse(location(NOW_S)));
    expect(await openMeteoSolarService.refresh()).toBe(1);
    expect(replaced).toEqual([{ key: '0.1:40.05:-89.95', rows: toRows(location(NOW_S)) }]);
  });

  it('skips cells fetched within the refresh interval (restart / save / button safe)', async () => {
    settings.set('solarMonitoringEnabled', '1');
    settings.set('solarMonitoringRefreshHours', '3');
    mtNodes = [mtNode(40, -90), mtNode(10, 10)];
    lastFetched.set('0.1:40.05:-89.95', NOW_S - 2 * 3600); // fresh
    lastFetched.set('0.1:10.05:10.05', NOW_S - 3 * 3600); // due
    fetchMock.mockResolvedValue(okResponse([location(NOW_S)]));
    expect(await openMeteoSolarService.refresh()).toBe(1);
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get('latitude')).toBe('10.05');
  });

  it('caps cells to the free-tier budget, most recently heard first', async () => {
    settings.set('solarMonitoringEnabled', '1');
    settings.set('solarMonitoringRefreshHours', '1'); // cap 375
    mtNodes = Array.from({ length: 400 }, (_, i) => mtNode(i * 0.2 - 40, 1, { lastHeard: NOW_S - i }));
    fetchMock.mockImplementation(async (url: string) => {
      const n = new URL(url).searchParams.get('latitude')!.split(',').length;
      return okResponse(Array.from({ length: n }, () => location(NOW_S)));
    });
    expect(await openMeteoSolarService.refresh()).toBe(375);
    expect(fetchMock).toHaveBeenCalledTimes(8); // 375 / 50, rounded up
    expect(openMeteoSolarService.sleep).toHaveBeenCalledTimes(7);
    expect(replaced.some(r => r.key === cellFor(399 * 0.2 - 40, 1, 0.1).key)).toBe(false);
  });

  it('has no cap with an API key', async () => {
    settings.set('solarMonitoringEnabled', '1');
    settings.set('solarMonitoringRefreshHours', '1');
    settings.set('solar_open_meteo_api_token', 'k');
    mtNodes = Array.from({ length: 400 }, (_, i) => mtNode(i * 0.2 - 40, 1));
    fetchMock.mockImplementation(async (url: string) => {
      const n = new URL(url).searchParams.get('latitude')!.split(',').length;
      return okResponse(Array.from({ length: n }, () => location(NOW_S)));
    });
    expect(await openMeteoSolarService.refresh()).toBe(400);
  });

  const echo = async (url: string) => {
    const n = new URL(url).searchParams.get('latitude')!.split(',').length;
    return okResponse(Array.from({ length: n }, () => location(NOW_S)));
  };

  it.each([429, 503])('stops the pass on HTTP %i, with no retry', async (status) => {
    settings.set('solarMonitoringEnabled', '1');
    mtNodes = Array.from({ length: 120 }, (_, i) => mtNode(i * 0.2 - 40, 1));
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => ({}) });
    expect(await openMeteoSolarService.refresh()).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(replaced).toEqual([]);
  });

  it('skips a chunk on another 4xx and carries on', async () => {
    settings.set('solarMonitoringEnabled', '1');
    mtNodes = Array.from({ length: 120 }, (_, i) => mtNode(i * 0.2 - 40, 1));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({}) }).mockImplementation(echo);
    expect(await openMeteoSolarService.refresh()).toBe(70);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('counts calls in a persisted per-day log and stops at the daily budget', async () => {
    settings.set('solarMonitoringEnabled', '1');
    settings.set('solarOpenMeteoCallLog', JSON.stringify({ day: '2026-11-23', calls: 8960 }));
    mtNodes = Array.from({ length: 120 }, (_, i) => mtNode(i * 0.2 - 40, 1));
    fetchMock.mockImplementation(echo);
    // 8960 + 50 > 9000: nothing fits today.
    vi.setSystemTime(Date.parse('2026-11-23T12:00:00Z'));
    expect(await openMeteoSolarService.refresh()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // A new UTC day resets the counter.
    vi.setSystemTime(Date.parse('2026-11-24T00:30:00Z'));
    expect(await openMeteoSolarService.refresh()).toBe(120);
    expect(JSON.parse(settings.get('solarOpenMeteoCallLog')!)).toEqual({ day: '2026-11-24', calls: 120 });
  });

  it('an over-cap mesh whose recency order shuffles never passes 9,000 calls per UTC day', async () => {
    settings.set('solarMonitoringEnabled', '1');
    settings.set('solarMonitoringRefreshHours', '3'); // cell cap 1125
    const lats = Array.from({ length: 2000 }, (_, i) => -80 + i * 0.08);
    const callsByDay = new Map<string, number>();
    fetchMock.mockImplementation(async (url: string) => {
      const day = new Date(Date.now()).toISOString().slice(0, 10);
      const n = new URL(url).searchParams.get('latitude')!.split(',').length;
      callsByDay.set(day, (callsByDay.get(day) ?? 0) + n);
      return echo(url);
    });
    let seed = 7;
    const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const start = Date.parse('2026-11-23T00:07:00Z');
    for (let h = 0; h < 72; h++) {
      vi.setSystemTime(start + h * 3_600_000);
      const nowS = Math.floor(Date.now() / 1000);
      mtNodes = lats.map(lat => mtNode(lat, 1, { lastHeard: nowS - Math.floor(rand() * 86_400) }));
      await openMeteoSolarService.refresh();
    }
    expect(callsByDay.size).toBe(3);
    for (const calls of callsByDay.values()) expect(calls).toBeLessThanOrEqual(9000);
  });

  it('a single pass never passes the per-pass ceiling on the free tier', async () => {
    settings.set('solarMonitoringEnabled', '1');
    settings.set('solarMonitoringRefreshHours', '24'); // cap 9000 cells
    mtNodes = Array.from({ length: 6000 }, (_, i) => mtNode(-75 + (i % 1500) * 0.1, 1 + Math.floor(i / 1500) * 0.5));
    fetchMock.mockImplementation(echo);
    expect(await openMeteoSolarService.refresh()).toBe(4000);
  });

  it('ignores an invalid grid/refresh setting and falls back to defaults', async () => {
    settings.set('solarMonitoringEnabled', 'true');
    settings.set('solarMonitoringGridSize', '0.0001');
    settings.set('solarMonitoringRefreshHours', '-5');
    mtNodes = [mtNode(40, -90)];
    fetchMock.mockResolvedValue(okResponse(location(NOW_S)));
    await openMeteoSolarService.refresh();
    expect(replaced[0].key).toBe('0.1:40.05:-89.95');
  });
});
