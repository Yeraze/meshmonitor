/**
 * OpenSky Network as an ADS-B feed (#5877): the pure parts. No I/O here, so
 * the Settings UI can import the feed table without pulling in server code.
 *
 *  - `pointToBbox` turns the matcher's point + radius into the bounding box
 *    `GET /api/states/all?lamin=&lomin=&lamax=&lomax=` wants;
 *  - `parseOpenSkyStates` turns OpenSky's positional `states[]` arrays into the
 *    readsb-shaped `AdsbAircraft` objects the matcher already reads.
 *
 * API: https://openskynetwork.github.io/opensky-api/rest.html
 */
import type { AdsbAircraft } from './adsbMatch.js';

export const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';
export const OPENSKY_TOKEN_URL =
  'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
/** Header OpenSky sends on a 429: seconds until the quota allows the next call. */
export const OPENSKY_RETRY_AFTER_HEADER = 'X-Rate-Limit-Retry-After-Seconds';

const KM_PER_DEG_LAT = 111;
const KM_PER_NM = 1.852;
const M_TO_FT = 1 / 0.3048;
const MS_TO_KT = 3600 / 1852;
/** Past this latitude a box edge would touch the pole: ask for every longitude. */
const POLAR_LIMIT_DEG = 89;

export interface Bbox {
  lamin: number;
  lomin: number;
  lamax: number;
  lomax: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * The box around (lat, lon) that holds every point within `nm` nautical miles.
 *
 * Δlat = r / 111 km; Δlon = Δlat / cos(lat). Near a pole (the box would reach
 * ±89°) or when Δlon covers the globe, the box takes every longitude.
 *
 * Antimeridian: OpenSky takes one box with lomin ≤ lomax, so a box that would
 * cross ±180° is clamped to it. A node at 179.9°E then misses aircraft just
 * west of 180°W. That is a narrow strip of mostly open ocean, and the match is
 * a hint, so one request beats two.
 */
export function pointToBbox(lat: number, lon: number, nm: number): Bbox {
  const dLat = (nm * KM_PER_NM) / KM_PER_DEG_LAT;
  const lamin = clamp(lat - dLat, -90, 90);
  const lamax = clamp(lat + dLat, -90, 90);
  if (Math.abs(lat) + dLat >= POLAR_LIMIT_DEG) {
    return { lamin, lomin: -180, lamax, lomax: 180 };
  }
  const dLon = dLat / Math.cos((lat * Math.PI) / 180);
  if (!Number.isFinite(dLon) || dLon >= 180) {
    return { lamin, lomin: -180, lamax, lomax: 180 };
  }
  return {
    lamin,
    lomin: clamp(lon - dLon, -180, 180),
    lamax,
    lomax: clamp(lon + dLon, -180, 180),
  };
}

function coord(v: number): string {
  // Same 4 decimals (~11 m) the readsb feeds use.
  return v.toFixed(4);
}

export function openSkyStatesUrl(lat: number, lon: number, nm: number): string {
  const b = pointToBbox(lat, lon, nm);
  return `${OPENSKY_STATES_URL}?lamin=${coord(b.lamin)}&lomin=${coord(b.lomin)}&lamax=${coord(b.lamax)}&lomax=${coord(b.lomax)}`;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * One OpenSky state vector as `AdsbAircraft`. Indexes per the REST docs:
 * 0 icao24, 1 callsign, 3 time_position, 5 lon, 6 lat, 7 baro_altitude (m),
 * 8 on_ground, 9 velocity (m/s), 10 true_track, 13 geo_altitude (m).
 * OpenSky has no type or registration, so `t` and `r` stay unset.
 */
export function normalizeOpenSkyState(state: unknown, responseTime: number | undefined): AdsbAircraft | null {
  if (!Array.isArray(state)) return null;
  const hex = typeof state[0] === 'string' ? state[0].trim().toLowerCase() : '';
  if (!hex) return null;

  const ac: AdsbAircraft = { hex };
  const callsign = typeof state[1] === 'string' ? state[1].trim() : '';
  if (callsign) ac.flight = callsign;

  const lon = num(state[5]);
  const lat = num(state[6]);
  if (lat !== undefined && lon !== undefined) {
    ac.lat = lat;
    ac.lon = lon;
  }

  const baroM = num(state[7]);
  if (state[8] === true) ac.alt_baro = 'ground';
  else if (baroM !== undefined) ac.alt_baro = Math.round(baroM * M_TO_FT);

  const geoM = num(state[13]);
  if (geoM !== undefined) ac.alt_geom = Math.round(geoM * M_TO_FT);

  const velocity = num(state[9]);
  if (velocity !== undefined) ac.gs = velocity * MS_TO_KT;

  const track = num(state[10]);
  if (track !== undefined) ac.track = track;

  const timePosition = num(state[3]);
  if (timePosition !== undefined && responseTime !== undefined) {
    ac.seen_pos = Math.max(0, responseTime - timePosition);
  }
  return ac;
}

/**
 * `{ time, states }` → aircraft. `states` is null when the box is empty.
 * Throws `Error` on a body that is not the OpenSky shape; the client wraps it.
 */
export function parseOpenSkyStates(body: unknown): AdsbAircraft[] {
  if (!body || typeof body !== 'object') throw new Error('OpenSky returned a non-object body');
  const { time, states } = body as { time?: unknown; states?: unknown };
  if (states == null) return [];
  if (!Array.isArray(states)) throw new Error('OpenSky body has a non-array "states"');
  const t = num(time);
  const out: AdsbAircraft[] = [];
  for (const s of states) {
    const ac = normalizeOpenSkyState(s, t);
    if (ac) out.push(ac);
  }
  return out;
}
