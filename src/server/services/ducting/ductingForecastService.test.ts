import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DuctingForecastService, forecastHourFor } from './ductingForecastService.js';
import { buildFilterUrl, latestPublishedCycle, GFS_PRESSURE_LEVELS_HPA, type FetchLike } from './gfsClient.js';

const FIXTURE = readFileSync(
  fileURLToPath(new URL('./__fixtures__/gfs-2026101812-f003-tampa.grb2', import.meta.url)),
);
const TAMPA = { minLat: 27, maxLat: 28, minLon: -83, maxLon: -82 };
const NOW = new Date('2026-10-18T18:00:00Z');

const reply = (status: number, body: Buffer | string) => ({
  ok: status >= 200 && status < 300,
  status,
  arrayBuffer: async () => {
    const b = typeof body === 'string' ? Buffer.from(body) : body;
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
  },
});
const NOT_YET = '<html><p>This data is not yet available.</p></html>';

describe('gfsClient (#5734)', () => {
  it('picks the newest cycle that should be published', () => {
    expect(latestPublishedCycle(new Date('2026-10-18T16:59:00Z')).toISOString()).toBe('2026-10-18T06:00:00.000Z');
    expect(latestPublishedCycle(new Date('2026-10-18T17:00:00Z')).toISOString()).toBe('2026-10-18T12:00:00.000Z');
    expect(latestPublishedCycle(new Date('2026-10-19T02:00:00Z')).toISOString()).toBe('2026-10-18T18:00:00.000Z');
  });

  it('asks the filter for the cycle, hour, fields, levels and box', () => {
    const url = new URL(buildFilterUrl(new Date('2026-10-18T12:00:00Z'), 3, TAMPA));
    expect(url.searchParams.get('dir')).toBe('/gfs.20261018/12/atmos');
    expect(url.searchParams.get('file')).toBe('gfs.t12z.pgrb2.0p25.f003');
    for (const v of ['TMP', 'RH', 'HGT', 'PRES']) expect(url.searchParams.get(`var_${v}`)).toBe('on');
    for (const p of GFS_PRESSURE_LEVELS_HPA) expect(url.searchParams.get(`lev_${p}_mb`)).toBe('on');
    expect(url.searchParams.get('lev_surface')).toBe('on');
    expect(url.searchParams.get('lev_2_m_above_ground')).toBe('on');
    expect([...['toplat', 'bottomlat', 'leftlon', 'rightlon'].map((k) => url.searchParams.get(k))]).toEqual([
      '28',
      '27',
      '-83',
      '-82',
    ]);
  });
});

describe('forecastHourFor', () => {
  const cycle = new Date('2026-10-18T12:00:00Z');
  it('maps "hours from now" to the nearest 3 h step from the cycle', () => {
    expect(forecastHourFor(cycle, NOW, 0)).toBe(6);
    expect(forecastHourFor(cycle, new Date('2026-10-18T17:20:00Z'), 0)).toBe(6);
    expect(forecastHourFor(cycle, new Date('2026-10-18T16:20:00Z'), 0)).toBe(3);
    expect(forecastHourFor(cycle, NOW, 72)).toBe(78);
    expect(forecastHourFor(cycle, new Date('2026-10-30T00:00:00Z'), 72)).toBe(120);
  });
});

describe('DuctingForecastService', () => {
  it('indexes every column of a real GFS cut', async () => {
    const http = vi.fn<FetchLike>().mockResolvedValue(reply(200, FIXTURE));
    const f = await new DuctingForecastService(http).getForecast(TAMPA, 0, new Date('2026-10-18T17:00:00Z'));
    expect(f.cycle).toBe('2026-10-18T12:00:00.000Z');
    expect(f.forecastHour).toBe(6);
    expect(f.validTime).toBe('2026-10-18T18:00:00.000Z');
    expect(f.grid).toEqual({ lat1: 28, lon1: -83, dLat: 0.25, dLon: 0.25, ni: 5, nj: 5 });
    expect(f.class).toHaveLength(25);
    expect(f.class.every((c) => c !== null)).toBe(true);
    expect(Object.values(f.summary).reduce((a, b) => a + b, 0)).toBe(25);
    expect(f.minGradientNPerKm.every((g) => g !== null && g > -1000 && g < 200)).toBe(true);
  });

  it('serves repeats from cache and shares one fetch between concurrent callers', async () => {
    const http = vi.fn<FetchLike>().mockResolvedValue(reply(200, FIXTURE));
    const svc = new DuctingForecastService(http);
    const [a, b] = await Promise.all([svc.getForecast(TAMPA, 0, NOW), svc.getForecast(TAMPA, 0, NOW)]);
    await svc.getForecast(TAMPA, 0, NOW);
    expect(a).toBe(b);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it('falls back a cycle when the newest is not published, then stops re-probing it', async () => {
    const http = vi.fn<FetchLike>(async (url) =>
      url.includes('%2F12%2Fatmos') ? reply(403, NOT_YET) : reply(200, FIXTURE),
    );
    const svc = new DuctingForecastService(http);
    const f = await svc.getForecast(TAMPA, 0, NOW);
    expect(f.cycle).toBe('2026-10-18T06:00:00.000Z');
    expect(f.forecastHour).toBe(12);
    expect(http).toHaveBeenCalledTimes(2);
    // The next request within 15 minutes skips the unpublished cycle.
    await svc.getForecast(TAMPA, 3, new Date(NOW.getTime() + 60_000));
    expect(http.mock.calls.slice(2).every(([u]) => !u.includes('%2F12%2Fatmos'))).toBe(true);
  });

  it('gives up with GfsUnavailableError after three cycles', async () => {
    const http = vi.fn<FetchLike>().mockResolvedValue(reply(404, NOT_YET));
    await expect(new DuctingForecastService(http).getForecast(TAMPA, 0, NOW)).rejects.toMatchObject({
      name: 'GfsUnavailableError',
    });
    expect(http).toHaveBeenCalledTimes(3);
  });
});
