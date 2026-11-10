/**
 * Offline reverse geocoder (#6336, phase 2 of #6287).
 *
 * Turns a position into country, top-level ISO 3166-2 subdivision and nearest
 * city, from data embedded in the server build:
 *   - Natural Earth 10m admin-1 (public domain), dissolved to top-level ISO 3166-2
 *   - GeoNames cities15000 (CC BY 4.0), in its own module so it can be dropped
 * See THIRD_PARTY_DATA.md and `src/server/data/geo/geoDataVersion.ts`.
 *
 * No network, no file I/O. The only work is gunzip and decode of the embedded
 * strings, done on first call. The decoded tables are dropped after
 * {@link IDLE_DROP_MS} without a lookup.
 *
 * Privacy: positions and places are never logged.
 *
 * Deterministic: the same position and the same pinned data give the same
 * place. Coordinates are rounded to integer units and every tie has an order.
 */

import { gunzipSync } from 'zlib';
import { logger } from '../../../utils/logger.js';
import { ADMIN1_DATA_GZ_B64 } from '../../data/geo/admin1.data.js';
import { CITIES_DATA_GZ_B64 } from '../../data/geo/cities.data.js';
import { COORD_SCALE, decodeAdmin1, decodeCities, type Admin1Data, type CitiesData } from './codec.js';
import { locateFeature, SUBDIVISION_FALLBACK_KM } from './pip.js';

export { SUBDIVISION_FALLBACK_KM };
/** Cities farther than this are never named. */
export const CITY_MAX_KM = 15;
/** Population floor in the city score, so a seat with population 0 still ranks. */
const MIN_CITY_POPULATION = 1000;
/** Drop the decoded tables after this long without a lookup. */
export const IDLE_DROP_MS = 10 * 60_000;

export interface GeoPosition {
  lat: number;
  lon: number;
}

/** Same shape as the root finder's `Place`. */
export interface GeoPlace {
  /** ISO 3166-1 alpha-2. */
  cc: string;
  /** Natural Earth name of the top-level subdivision, e.g. `Washington`. */
  subdivisionName?: string;
  /** Top-level ISO 3166-2 code, e.g. `US-WA`. */
  subdivisionIso?: string;
  /** GeoNames name of the nearest city. */
  city?: string;
}

export interface GeoSources {
  admin1: () => string;
  /** Leave out to run without the city rung. */
  cities?: () => string;
}

interface Loaded {
  admin1: Admin1Data;
  cities: CitiesData | null;
}

const EARTH_KM = 6371;

function haversineUnitsKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180 / COORD_SCALE;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function unpack(b64: string): Uint8Array {
  return new Uint8Array(gunzipSync(Buffer.from(b64, 'base64')));
}

export interface ReverseGeocoder {
  lookup(pos: GeoPosition): GeoPlace | undefined;
  /** Decode now. Returns false when the data failed to decode. */
  load(): boolean;
  /** Free the decoded tables. The next lookup decodes again. */
  drop(): void;
  isLoaded(): boolean;
}

export function createReverseGeocoder(sources: GeoSources, opts: { idleMs?: number } = {}): ReverseGeocoder {
  const idleMs = opts.idleMs ?? IDLE_DROP_MS;
  let loaded: Loaded | null = null;
  let failed = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const drop = () => {
    loaded = null;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
  };

  const touch = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(drop, idleMs);
    // Never keeps the process alive.
    idleTimer.unref?.();
  };

  const load = (): boolean => {
    if (loaded) return true;
    if (failed) return false;
    try {
      const admin1 = decodeAdmin1(unpack(sources.admin1()));
      let cities: CitiesData | null = null;
      if (sources.cities) {
        const c = decodeCities(unpack(sources.cities()));
        if (c.version !== admin1.version || c.featCity.length !== admin1.features.length + 1) {
          logger.warn('[offlineGeocoder] city data does not match the subdivision data; city rows disabled');
        } else {
          cities = c;
        }
      }
      loaded = { admin1, cities };
      return true;
    } catch (err) {
      // Data is embedded, so this is a build fault. Say so once, then stay off.
      failed = true;
      logger.error('[offlineGeocoder] embedded geo data failed to decode:', (err as Error).message);
      return false;
    }
  };

  /**
   * Best city in the feature within {@link CITY_MAX_KM}: lowest distance /
   * sqrt(population). Plain nearest names a neighbourhood inside a big city
   * (`Paris 04 Hôtel-de-Ville`, DC's `Golden Triangle`), because GeoNames
   * lists those as places too; weighting by population names the city.
   * Ties: nearer, then larger, then lower geonameid.
   */
  const bestCity = (c: CitiesData, f: number, lat: number, lon: number): string | undefined => {
    let best = -1;
    let bestScore = Infinity;
    let bestKm = Infinity;
    for (let i = c.featCity[f]; i < c.featCity[f + 1]; i++) {
      const km = haversineUnitsKm(lat, lon, c.lat[i], c.lon[i]);
      if (km > CITY_MAX_KM) continue;
      const score = km / Math.sqrt(Math.max(c.population[i], MIN_CITY_POPULATION));
      if (
        best === -1 ||
        score < bestScore ||
        (score === bestScore &&
          (km < bestKm ||
            (km === bestKm &&
              (c.population[i] > c.population[best] ||
                (c.population[i] === c.population[best] && c.id[i] < c.id[best])))))
      ) {
        best = i;
        bestScore = score;
        bestKm = km;
      }
    }
    return best === -1 ? undefined : c.names[best];
  };

  const lookup = (pos: GeoPosition): GeoPlace | undefined => {
    const { lat, lon } = pos ?? ({} as GeoPosition);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return undefined;
    }
    if (!load() || !loaded) return undefined;
    touch();
    const y = Math.round(lat * COORD_SCALE);
    const x = Math.round(lon * COORD_SCALE);
    const { admin1, cities } = loaded;
    const f = locateFeature(admin1, x, y, SUBDIVISION_FALLBACK_KM);
    if (f === -1) return undefined;
    const feat = admin1.features[f];
    const place: GeoPlace = { cc: feat.cc };
    if (feat.code) place.subdivisionIso = feat.code;
    if (feat.name) place.subdivisionName = feat.name;
    if (cities) {
      const city = bestCity(cities, f, y, x);
      if (city) place.city = city;
    }
    return place;
  };

  return { lookup, load, drop, isLoaded: () => loaded !== null };
}

const shared = createReverseGeocoder({
  admin1: () => ADMIN1_DATA_GZ_B64,
  // Delete this line (and cities.data.ts) to ship without the city rung.
  cities: () => CITIES_DATA_GZ_B64,
});

/** Place for a position, or undefined at sea or when the data is unusable. */
export function reverseGeocode(pos: GeoPosition): GeoPlace | undefined {
  return shared.lookup(pos);
}

/** Test seam. */
export const sharedReverseGeocoder: ReverseGeocoder = shared;
