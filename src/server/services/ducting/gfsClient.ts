/**
 * Fetches a regional GFS cut from the NOAA NOMADS grib filter (#5734 spike).
 *
 * The filter cuts one forecast file down to the fields, levels and bounding
 * box asked for, so a 10x10 degree box at 0.25 degrees is ~50 KB per forecast
 * hour instead of the ~500 MB global file. GFS output is public domain and
 * needs no key.
 *
 * NOMADS blocks clients that hammer it, so callers must cache results; this
 * module makes exactly one request per call (plus one per older cycle tried
 * when the newest is not published yet).
 */
import { decodeGrib2, type Grib2Message } from './grib2.js';

export const NOMADS_FILTER_URL = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl';

/** Isobaric levels sampled, hPa. 700 hPa is ~3 km, the top of the layer we index. */
export const GFS_PRESSURE_LEVELS_HPA = [1000, 975, 950, 925, 900, 850, 800, 750, 700] as const;

/** A cycle's 0-120 h files are complete about this long after the cycle time. */
const CYCLE_PUBLISH_LAG_MS = 5 * 3600_000;
const CYCLE_MS = 6 * 3600_000;
const MAX_CYCLES_TRIED = 3;
const REQUEST_TIMEOUT_MS = 30_000;

export interface BBox {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

export class GfsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GfsUnavailableError';
  }
}

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Newest cycle that should be fully published at `now`. */
export function latestPublishedCycle(now: Date): Date {
  const t = now.getTime() - CYCLE_PUBLISH_LAG_MS;
  return new Date(Math.floor(t / CYCLE_MS) * CYCLE_MS);
}

export function buildFilterUrl(cycle: Date, forecastHour: number, bbox: BBox): string {
  const ymd = `${cycle.getUTCFullYear()}${pad2(cycle.getUTCMonth() + 1)}${pad2(cycle.getUTCDate())}`;
  const hh = pad2(cycle.getUTCHours());
  const params = new URLSearchParams({
    dir: `/gfs.${ymd}/${hh}/atmos`,
    file: `gfs.t${hh}z.pgrb2.0p25.f${String(forecastHour).padStart(3, '0')}`,
  });
  for (const v of ['TMP', 'RH', 'HGT', 'PRES']) params.set(`var_${v}`, 'on');
  for (const p of GFS_PRESSURE_LEVELS_HPA) params.set(`lev_${p}_mb`, 'on');
  params.set('lev_surface', 'on');
  params.set('lev_2_m_above_ground', 'on');
  params.set('subregion', '');
  params.set('toplat', String(bbox.maxLat));
  params.set('bottomlat', String(bbox.minLat));
  params.set('leftlon', String(bbox.minLon));
  params.set('rightlon', String(bbox.maxLon));
  return `${NOMADS_FILTER_URL}?${params.toString()}`;
}

function isGrib(buf: Buffer): boolean {
  return buf.length >= 4 && buf.toString('latin1', 0, 4) === 'GRIB';
}

export interface GfsSlice {
  cycle: Date;
  forecastHour: number;
  messages: Grib2Message[];
}

/**
 * Fetch one forecast hour for `bbox`, from the newest published cycle. When
 * `cycle` is given only that cycle is tried. NOMADS answers a cycle that is
 * not published yet with an HTML page (HTTP 403/404), so anything that is not
 * GRIB moves on to the cycle before.
 */
export async function fetchGfsSlice(opts: {
  bbox: BBox;
  forecastHour: number;
  now?: Date;
  cycle?: Date;
  fetchImpl?: FetchLike;
}): Promise<GfsSlice> {
  const http = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const first = opts.cycle ?? latestPublishedCycle(opts.now ?? new Date());
  const tries = opts.cycle ? 1 : MAX_CYCLES_TRIED;
  let lastProblem = 'no cycle tried';
  for (let i = 0; i < tries; i++) {
    const cycle = new Date(first.getTime() - i * CYCLE_MS);
    const url = buildFilterUrl(cycle, opts.forecastHour, opts.bbox);
    const res = await http(url, {
      headers: { 'User-Agent': 'MeshMonitor (tropospheric ducting; github.com/Yeraze/meshmonitor)' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = Buffer.from(await res.arrayBuffer());
    if (res.ok && isGrib(body)) {
      return { cycle, forecastHour: opts.forecastHour, messages: decodeGrib2(body) };
    }
    lastProblem = `cycle ${cycle.toISOString()} answered HTTP ${res.status}${isGrib(body) ? '' : ' without GRIB data'}`;
  }
  throw new GfsUnavailableError(`GFS data is not available: ${lastProblem}`);
}
