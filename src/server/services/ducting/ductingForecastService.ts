/**
 * Ducting forecast for an area (#5734): fetch a GFS slice, build a
 * vertical profile per grid point, and index each column.
 *
 * Results are cached in memory per (cycle, forecast hour, box) and concurrent
 * identical requests share one fetch, so NOMADS sees at most one request per
 * cache miss. Nothing here runs on a timer: a fetch happens only when a
 * map viewer asks for a forecast step.
 */
import { indexColumns } from './gfsProfile.js';
import { fetchGfsSlice, latestPublishedCycle, GfsUnavailableError, type BBox, type FetchLike } from './gfsClient.js';
import type { DuctingClass } from './refractivity.js';

/** GFS 0.25 degree output runs to 120 h hourly; the overlay looks 72 h ahead. */
export const MAX_HOURS_AHEAD = 72;
export const FORECAST_STEP_HOURS = 3;
const MAX_FORECAST_HOUR = 120;
const CYCLE_MS = 6 * 3600_000;
const CYCLES_TRIED = 3;
/** Remember an unpublished cycle this long before probing it again. */
const UNPUBLISHED_RETRY_MS = 15 * 60_000;
/**
 * One entry is one (cycle, hour, box). Boxes are scoped to the nodes each
 * caller can see, so an install with several viewer groups holds several
 * boxes; 200 keeps ~8 full 25-step scrubbers before evictions force NOAA refetches.
 */
const CACHE_MAX_ENTRIES = 200;

export interface DuctingForecast {
  cycle: string;
  forecastHour: number;
  validTime: string;
  grid: { lat1: number; lon1: number; dLat: number; dLon: number; ni: number; nj: number };
  /** Row-major, north row first, west to east. null where a column could not be indexed. */
  minGradientNPerKm: (number | null)[];
  ductStrengthM: (number | null)[];
  layerBaseM: (number | null)[];
  layerTopM: (number | null)[];
  class: (DuctingClass | null)[];
  summary: Record<DuctingClass, number>;
}

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** The GFS forecast hour, from `cycle`, that is valid closest to `now + hoursAhead`. */
export function forecastHourFor(cycle: Date, now: Date, hoursAhead: number): number {
  const lead = (now.getTime() - cycle.getTime()) / 3600_000 + hoursAhead;
  const stepped = Math.round(lead / FORECAST_STEP_HOURS) * FORECAST_STEP_HOURS;
  return Math.min(Math.max(stepped, 0), MAX_FORECAST_HOUR);
}

export class DuctingForecastService {
  private readonly cache = new Map<string, DuctingForecast>();
  private readonly inFlight = new Map<string, Promise<DuctingForecast>>();
  private readonly unpublished = new Map<number, number>();

  constructor(private readonly fetchImpl?: FetchLike) {}

  async getForecast(bbox: BBox, hoursAhead: number, now: Date = new Date()): Promise<DuctingForecast> {
    const newest = latestPublishedCycle(now).getTime();
    let lastError: unknown = null;
    for (let i = 0; i < CYCLES_TRIED; i++) {
      const cycleMs = newest - i * CYCLE_MS;
      const skipUntil = this.unpublished.get(cycleMs);
      if (skipUntil !== undefined && skipUntil > now.getTime()) continue;
      const cycle = new Date(cycleMs);
      const forecastHour = forecastHourFor(cycle, now, hoursAhead);
      try {
        return await this.getCached(cycle, forecastHour, bbox);
      } catch (err) {
        if (!(err instanceof GfsUnavailableError)) throw err;
        this.unpublished.set(cycleMs, now.getTime() + UNPUBLISHED_RETRY_MS);
        lastError = err;
      }
    }
    throw lastError ?? new GfsUnavailableError('no recent GFS cycle is published');
  }

  private getCached(cycle: Date, forecastHour: number, bbox: BBox): Promise<DuctingForecast> {
    const key = `${cycle.toISOString()}|${forecastHour}|${bbox.minLat},${bbox.maxLat},${bbox.minLon},${bbox.maxLon}`;
    const hit = this.cache.get(key);
    if (hit) return Promise.resolve(hit);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const job = (async () => {
      const slice = await fetchGfsSlice({ bbox, forecastHour, cycle, fetchImpl: this.fetchImpl });
      const forecast = buildForecast(cycle, forecastHour, slice.messages);
      this.cache.set(key, forecast);
      while (this.cache.size > CACHE_MAX_ENTRIES) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      return forecast;
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, job);
    return job;
  }
}

export function buildForecast(
  cycle: Date,
  forecastHour: number,
  messages: Parameters<typeof indexColumns>[0],
): DuctingForecast {
  const { grid, columns } = indexColumns(messages);
  const summary: Record<DuctingClass, number> = { 'sub-refractive': 0, normal: 0, 'super-refractive': 0, ducting: 0 };
  const out: DuctingForecast = {
    cycle: cycle.toISOString(),
    forecastHour,
    validTime: new Date(cycle.getTime() + forecastHour * 3600_000).toISOString(),
    grid: { lat1: grid.lat1, lon1: grid.lon1, dLat: grid.dLat, dLon: grid.dLon, ni: grid.ni, nj: grid.nj },
    minGradientNPerKm: [],
    ductStrengthM: [],
    layerBaseM: [],
    layerTopM: [],
    class: [],
    summary,
  };
  for (const c of columns) {
    out.minGradientNPerKm.push(c ? round1(c.minGradientNPerKm) : null);
    out.ductStrengthM.push(c ? round1(c.ductStrengthM) : null);
    out.layerBaseM.push(c ? Math.round(c.layerBaseM) : null);
    out.layerTopM.push(c ? Math.round(c.layerTopM) : null);
    out.class.push(c ? c.class : null);
    if (c) summary[c.class]++;
  }
  return out;
}
