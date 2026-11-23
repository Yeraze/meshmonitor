/**
 * Open-Meteo per-node sunlight (#6523).
 *
 * Every hour the scheduler collects the effective position of every node heard
 * in the last ACTIVE_NODE_DAYS (all sources, Meshtastic and MeshCore), snaps
 * each to the configured grid, and fetches hourly `shortwave_radiation` (W/m²)
 * and `cloud_cover` (%) for cells whose stored data is older than the refresh
 * interval. Results land in the global `solar_irradiance` cell cache.
 *
 * Budget safety:
 *  - "Due" is read from each cell's stored `fetchedAt`, so a restart, a
 *    settings save or a manual trigger never re-fetches a fresh cell.
 *  - Without an API key (free tier, < 10,000 calls/day) the cell list is cut to
 *    what fits FREE_DAILY_BUDGET at the configured refresh, most recently
 *    heard nodes first.
 *  - Requests go out in chunks, paced under the free tier's 600/minute.
 *  - Any HTTP error (429 included) ends the tick; nothing retries until the
 *    next hourly tick.
 *
 * Privacy: a node whose position override is marked private is never sent.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { validateCron, scheduleCron, type CronJob } from '../utils/cronScheduler.js';
import { getEffectiveDbNodePosition } from '../utils/nodeEnhancer.js';
import { isBogusPosition } from '../../utils/nullIsland.js';
import { ALL_SOURCES, type SolarIrradianceRow } from '../../db/repositories/index.js';

/** Grid sizes offered in Settings, in degrees (0.1° ≈ 11 km). */
export const SOLAR_GRID_SIZES = [0.05, 0.1, 0.25, 0.5, 1] as const;
export const DEFAULT_SOLAR_GRID_SIZE = 0.1;
/** Refresh intervals offered in Settings, in hours. */
export const SOLAR_REFRESH_HOURS = [1, 2, 3, 6, 12, 24] as const;
export const DEFAULT_SOLAR_REFRESH_HOURS = 3;
/** Free tier allows < 10,000 calls/day; keep a margin for manual use. */
export const FREE_DAILY_BUDGET = 9000;
/** A node counts toward the mesh if heard within this many days. */
export const ACTIVE_NODE_DAYS = 7;
/** Coordinates per Open-Meteo request. */
const CHUNK_SIZE = 50;
/** Pause between chunks: 50 calls / 6 s = 500/min, under the 600/min cap. */
const CHUNK_PAUSE_MS = 6000;
/** Stored rows older than this are swept. */
const RETENTION_DAYS = 30;
/** A cell refetches when its data is older than the interval minus this slack. */
const REFRESH_SLACK_S = 300;

export interface SolarCell {
  key: string;
  latitude: number;
  longitude: number;
}

export interface SolarSettings {
  enabled: boolean;
  gridSize: number;
  refreshHours: number;
  apiKey: string;
}

/** Snap a position to its grid cell (cell centre). */
export function cellFor(latitude: number, longitude: number, gridSize: number): SolarCell {
  const centre = (v: number) => Number((Math.floor(v / gridSize) * gridSize + gridSize / 2).toFixed(4));
  const lat = centre(latitude);
  const lon = centre(longitude);
  return { key: `${gridSize}:${lat}:${lon}`, latitude: lat, longitude: lon };
}

/** Open-Meteo calls per day for `cells` refreshed every `refreshHours`. */
export function callsPerDay(cells: number, refreshHours: number): number {
  return Math.ceil((cells * 24) / refreshHours);
}

/** Most cells the free tier can refresh every `refreshHours`. */
export function freeTierCellCap(refreshHours: number): number {
  return Math.floor((FREE_DAILY_BUDGET * refreshHours) / 24);
}

function pick<T extends number>(raw: string | null, allowed: readonly T[], fallback: T): T {
  const n = Number(raw);
  return (allowed as readonly number[]).includes(n) ? (n as T) : fallback;
}

export async function loadSolarSettings(): Promise<SolarSettings> {
  const get = (k: string) => databaseService.settings.getSetting(k);
  const [enabled, grid, refresh, apiKey] = await Promise.all([
    get('solarMonitoringEnabled'),
    get('solarMonitoringGridSize'),
    get('solarMonitoringRefreshHours'),
    get('solar_open_meteo_api_token'),
  ]);
  return {
    enabled: enabled === '1' || enabled === 'true',
    gridSize: pick(grid, SOLAR_GRID_SIZES, DEFAULT_SOLAR_GRID_SIZE),
    refreshHours: pick(refresh, SOLAR_REFRESH_HOURS, DEFAULT_SOLAR_REFRESH_HOURS),
    apiKey: (apiKey ?? '').trim(),
  };
}

/**
 * Effective positions of every active node on every source, most recently
 * heard first. Private overrides and bogus (Null Island / out of range)
 * positions are skipped.
 */
export async function collectActivePositions(): Promise<Array<{ latitude: number; longitude: number }>> {
  const out: Array<{ latitude: number; longitude: number; heard: number }> = [];

  const nodes = await databaseService.nodes.getActiveNodes(ACTIVE_NODE_DAYS, ALL_SOURCES);
  for (const n of nodes) {
    if (n.positionOverrideEnabled && n.positionOverrideIsPrivate) continue;
    const pos = getEffectiveDbNodePosition(n);
    if (pos.latitude == null || pos.longitude == null || isBogusPosition(pos.latitude, pos.longitude)) continue;
    out.push({ latitude: pos.latitude, longitude: pos.longitude, heard: Number(n.lastHeard ?? 0) * 1000 });
  }

  // MeshCore lastHeard is milliseconds.
  const cutoffMs = Date.now() - ACTIVE_NODE_DAYS * 86_400_000;
  const mcNodes = await databaseService.meshcore.getAllNodes();
  for (const n of mcNodes) {
    const heard = Number(n.lastHeard ?? 0);
    if (heard < cutoffMs) continue;
    if (n.positionOverrideEnabled && n.positionOverrideIsPrivate) continue;
    const useOverride = !!n.positionOverrideEnabled && n.latitudeOverride != null && n.longitudeOverride != null;
    const lat = useOverride ? n.latitudeOverride : n.latitude;
    const lon = useOverride ? n.longitudeOverride : n.longitude;
    if (lat == null || lon == null || isBogusPosition(lat, lon)) continue;
    out.push({ latitude: lat, longitude: lon, heard });
  }

  return out.sort((a, b) => b.heard - a.heard).map(({ latitude, longitude }) => ({ latitude, longitude }));
}

/** Distinct cells for `positions`, in first-seen order. */
export function distinctCells(positions: Array<{ latitude: number; longitude: number }>, gridSize: number): SolarCell[] {
  const cells = new Map<string, SolarCell>();
  for (const p of positions) {
    const c = cellFor(p.latitude, p.longitude, gridSize);
    if (!cells.has(c.key)) cells.set(c.key, c);
  }
  return [...cells.values()];
}

interface OpenMeteoLocation {
  hourly?: { time?: number[]; shortwave_radiation?: Array<number | null>; cloud_cover?: Array<number | null> };
}

/** Turn one location's response into rows. */
export function toRows(loc: OpenMeteoLocation): SolarIrradianceRow[] {
  const h = loc.hourly;
  if (!h?.time) return [];
  return h.time.map((t, i) => ({
    timestamp: Number(t),
    shortwaveRadiation: h.shortwave_radiation?.[i] ?? null,
    cloudCover: h.cloud_cover?.[i] ?? null,
  }));
}

export function buildUrl(cells: SolarCell[], apiKey: string): string {
  const host = apiKey ? 'https://customer-api.open-meteo.com' : 'https://api.open-meteo.com';
  const params = new URLSearchParams({
    latitude: cells.map(c => c.latitude).join(','),
    longitude: cells.map(c => c.longitude).join(','),
    hourly: 'shortwave_radiation,cloud_cover',
    past_days: '1',
    forecast_days: '2',
    // Epoch seconds: no local-time strings to misparse (the forecast.solar bug).
    timeformat: 'unixtime',
  });
  if (apiKey) params.set('apikey', apiKey);
  return `${host}/v1/forecast?${params.toString()}`;
}

class OpenMeteoSolarService {
  private cronJob: CronJob | null = null;
  private running = false;
  /** Test seam: replaced with a no-op wait in unit tests. */
  sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  initialize(): void {
    if (this.cronJob) return;
    const expr = '7 * * * *';
    if (!validateCron(expr)) return;
    this.cronJob = scheduleCron(expr, () => { void this.refresh(); }, { timezone: 'Etc/UTC' });
    // Startup run is safe: fresh cells are skipped by their stored fetchedAt.
    void this.refresh();
  }

  stop(): void {
    this.cronJob?.stop();
    this.cronJob = null;
  }

  /** One refresh pass. Returns how many cells were fetched. */
  async refresh(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const settings = await loadSolarSettings();
      if (!settings.enabled) return 0;

      let cells = distinctCells(await collectActivePositions(), settings.gridSize);
      if (!settings.apiKey) {
        const cap = freeTierCellCap(settings.refreshHours);
        if (cells.length > cap) {
          logger.warn(`☀️  Solar: ${cells.length} cells exceed the free-tier budget at a ${settings.refreshHours}h refresh; fetching the ${cap} most recently heard`);
          cells = cells.slice(0, cap);
        }
      }

      const now = Math.floor(Date.now() / 1000);
      const last = await databaseService.solarIrradiance.getLastFetchedAt(cells.map(c => c.key));
      const minAge = settings.refreshHours * 3600 - REFRESH_SLACK_S;
      const due = cells.filter(c => now - (last.get(c.key) ?? 0) >= minAge);

      let fetched = 0;
      for (let i = 0; i < due.length; i += CHUNK_SIZE) {
        if (i > 0) await this.sleep(CHUNK_PAUSE_MS);
        const chunk = due.slice(i, i + CHUNK_SIZE);
        const res = await fetch(buildUrl(chunk, settings.apiKey));
        if (!res.ok) {
          logger.error(`❌ Solar: Open-Meteo returned HTTP ${res.status}; stopping until the next hourly tick`);
          break;
        }
        const body = (await res.json()) as OpenMeteoLocation | OpenMeteoLocation[];
        const locations = Array.isArray(body) ? body : [body];
        for (let j = 0; j < chunk.length; j++) {
          await databaseService.solarIrradiance.replaceCellRows(chunk[j].key, toRows(locations[j] ?? {}), now);
          fetched++;
        }
      }

      await databaseService.solarIrradiance.deleteOlderThan(now - RETENTION_DAYS * 86_400);
      if (fetched > 0) logger.debug(`☀️  Solar: refreshed ${fetched}/${cells.length} cells`);
      return fetched;
    } catch (err) {
      logger.error('❌ Solar: Open-Meteo refresh failed:', err);
      return 0;
    } finally {
      this.running = false;
    }
  }
}

export const openMeteoSolarService = new OpenMeteoSolarService();
