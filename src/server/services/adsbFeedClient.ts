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
 *
 * A feed can override the request and the parser (`AdsbFeedInfo.buildRequest`
 * / `parse`). OpenSky (#5877) uses both, plus OAuth2: the caller passes an
 * `oauth` hook, the client sends `Authorization: Bearer`, and on a 401 it
 * drops the token and retries once with a fresh one. An OAuth2 feed never
 * receives the shared `adsb_api_token`.
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
  headers?: { get(name: string): string | null };
}

export type AdsbHttpFn = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<AdsbHttpResponse>;

export type AdsbFeedErrorKind = 'http' | 'timeout' | 'network' | 'parse' | 'auth';

export class AdsbFeedError extends Error {
  constructor(
    message: string,
    readonly kind: AdsbFeedErrorKind,
    readonly status: number | null,
    /** True when the caller should back off the feed. */
    readonly backoff: boolean,
    /** A 429's retry delay, in ms, for a feed that sends one (`retryAfterHeader`). */
    readonly retryAfterMs: number | null = null,
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

/** Bearer-token hook for an `auth: 'oauth2'` feed. */
export interface AdsbOAuthHook {
  getToken(): Promise<string>;
  /** Drop the cached token; the next `getToken` fetches a fresh one. */
  invalidate(): void;
}

/** Seconds in a Retry-After style header → ms, or null when absent/invalid. */
export function parseRetryAfterMs(res: AdsbHttpResponse, header: string): number | null {
  const raw = res.headers?.get(header);
  if (raw == null || raw.trim() === '') return null;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.ceil(seconds * 1000);
}

export interface FetchAircraftOptions {
  /** Shared API key, sent as X-API-Key to `api-key` feeds only. */
  token?: string | null;
  /** Required for an `oauth2` feed. */
  oauth?: AdsbOAuthHook | null;
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
  const req = feed.buildRequest
    ? feed.buildRequest(lat, lon, nm)
    : { url: feed.pointUrl(lat, lon, nm), headers: {} as Record<string, string> };
  const headers: Record<string, string> = {
    ...req.headers,
    'User-Agent': ADSB_USER_AGENT,
    Accept: 'application/json',
  };
  const oauth = feed.auth === 'oauth2' ? opts.oauth ?? null : null;
  if (feed.auth === 'oauth2') {
    if (!oauth) throw new AdsbFeedError(`${feed.name} needs client credentials`, 'auth', null, false);
    headers.Authorization = `Bearer ${await oauth.getToken()}`;
  } else {
    const token = opts.token?.trim();
    if (token) headers[ADSB_API_KEY_HEADER] = token;
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const send = async (): Promise<AdsbHttpResponse> => {
      try {
        return await http(req.url, { headers, signal: controller.signal });
      } catch (err) {
        if (timedOut) throw new AdsbFeedError(`${feed.name} timed out after ${timeoutMs} ms`, 'timeout', null, true);
        throw new AdsbFeedError(`${feed.name} request failed: ${err instanceof Error ? err.message : err}`, 'network', null, true);
      }
    };

    let res = await send();
    if (res.status === 401 && oauth) {
      // The token expired or was revoked early: one fresh token, one retry.
      oauth.invalidate();
      headers.Authorization = `Bearer ${await oauth.getToken()}`;
      res = await send();
    }

    if (res.status < 200 || res.status >= 300) {
      // A 401 that survived a fresh token means the credentials are refused.
      const backoff = res.status === 429 || res.status === 403 || res.status >= 500 || (res.status === 401 && !!oauth);
      const retryAfterMs =
        res.status === 429 && feed.retryAfterHeader ? parseRetryAfterMs(res, feed.retryAfterHeader) : null;
      throw new AdsbFeedError(`${feed.name} returned HTTP ${res.status}`, 'http', res.status, backoff, retryAfterMs);
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      if (timedOut) throw new AdsbFeedError(`${feed.name} timed out after ${timeoutMs} ms`, 'timeout', null, true);
      throw new AdsbFeedError(`${feed.name} returned invalid JSON`, 'parse', res.status, false);
    }
    if (!feed.parse) return parseFeedResponse(body);
    try {
      return feed.parse(body);
    } catch (err) {
      if (err instanceof AdsbFeedError) throw err;
      throw new AdsbFeedError(`${feed.name}: ${err instanceof Error ? err.message : err}`, 'parse', res.status, false);
    }
  } finally {
    clearTimeout(timer);
  }
}
