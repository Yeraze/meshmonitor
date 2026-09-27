/**
 * One HTTP client for the public ADS-B feeds (#5374, ADSB_MATCH_SPEC.md "Feed
 * endpoints"). adsb.lol and adsb.fi both answer a point query with the same
 * ADSBx v2 / readsb JSON (`{ ac, msg, now, total, ctime, ptime }`), so one
 * parser serves both.
 *
 * The HTTP call is injectable so tests never touch the network. The default
 * goes through `safeFetch` (SSRF-guarded), like `elevationProvider.ts`.
 *
 * Errors come back as `AdsbFeedError` with `backoff` set when the caller
 * should stop asking for a while (429, 403, 5xx, timeout, network failure).
 */
import { createRequire } from 'module';
import { safeFetch } from '../utils/ssrfGuard.js';
import type { AdsbAircraft } from '../../utils/adsbMatch.js';
import type { AdsbFeedInfo } from '../../utils/adsbFeeds.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json') as { version?: string };

export const ADSB_REQUEST_TIMEOUT_MS = 10_000;
/** adsb.lol's announced API-key header. Sent only when a key is configured. */
export const ADSB_API_KEY_HEADER = 'X-API-Key';
export const ADSB_USER_AGENT = `MeshMonitor/${packageJson.version ?? 'dev'} (+https://github.com/Yeraze/meshmonitor)`;

export interface AdsbHttpResponse {
  status: number;
  json(): Promise<unknown>;
}

export type AdsbHttpFn = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<AdsbHttpResponse>;

export type AdsbFeedErrorKind = 'http' | 'timeout' | 'network' | 'parse';

export class AdsbFeedError extends Error {
  constructor(
    message: string,
    readonly kind: AdsbFeedErrorKind,
    readonly status: number | null,
    /** True when the caller should back off the feed. */
    readonly backoff: boolean,
  ) {
    super(message);
    this.name = 'AdsbFeedError';
  }
}

const defaultHttp: AdsbHttpFn = (url, init) => safeFetch(url, init);

/** Pull the aircraft list out of a feed body. Throws on a body that is not the expected shape. */
export function parseFeedResponse(body: unknown): AdsbAircraft[] {
  if (!body || typeof body !== 'object') {
    throw new AdsbFeedError('ADS-B feed returned a non-object body', 'parse', null, false);
  }
  const ac = (body as { ac?: unknown }).ac;
  // readsb omits `ac` (or sends null) when nothing is in range.
  if (ac == null) return [];
  if (!Array.isArray(ac)) {
    throw new AdsbFeedError('ADS-B feed body has a non-array "ac"', 'parse', null, false);
  }
  return ac.filter((a): a is AdsbAircraft => !!a && typeof a === 'object');
}

export interface FetchAircraftOptions {
  token?: string | null;
  http?: AdsbHttpFn;
  timeoutMs?: number;
}

/** Every aircraft the feed reports within `nm` nautical miles of (lat, lon). */
export async function fetchAircraftNear(
  feed: AdsbFeedInfo,
  lat: number,
  lon: number,
  nm: number,
  opts: FetchAircraftOptions = {},
): Promise<AdsbAircraft[]> {
  const http = opts.http ?? defaultHttp;
  const timeoutMs = opts.timeoutMs ?? ADSB_REQUEST_TIMEOUT_MS;
  const headers: Record<string, string> = {
    'User-Agent': ADSB_USER_AGENT,
    Accept: 'application/json',
  };
  const token = opts.token?.trim();
  if (token) headers[ADSB_API_KEY_HEADER] = token;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let res: AdsbHttpResponse;
    try {
      res = await http(feed.pointUrl(lat, lon, nm), { headers, signal: controller.signal });
    } catch (err) {
      if (timedOut) throw new AdsbFeedError(`${feed.name} timed out after ${timeoutMs} ms`, 'timeout', null, true);
      throw new AdsbFeedError(`${feed.name} request failed: ${err instanceof Error ? err.message : err}`, 'network', null, true);
    }

    if (res.status < 200 || res.status >= 300) {
      const backoff = res.status === 429 || res.status === 403 || res.status >= 500;
      throw new AdsbFeedError(`${feed.name} returned HTTP ${res.status}`, 'http', res.status, backoff);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      if (timedOut) throw new AdsbFeedError(`${feed.name} timed out after ${timeoutMs} ms`, 'timeout', null, true);
      throw new AdsbFeedError(`${feed.name} returned invalid JSON`, 'parse', res.status, false);
    }
    return parseFeedResponse(body);
  } finally {
    clearTimeout(timer);
  }
}
