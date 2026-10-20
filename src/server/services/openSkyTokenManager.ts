/**
 * OpenSky Network OAuth2 client-credentials tokens (#5877).
 *
 * OpenSky issues a Bearer token (~30 min) for a client id + secret. The token
 * lives in memory only: never in the database, never in a log line. It is
 * reused until `REFRESH_MARGIN_MS` before it expires, and `invalidate()` drops
 * it so the client can fetch a fresh one after a 401.
 *
 * The token host goes through `safeFetch` like every other outbound call.
 */
import { safeFetch } from '../utils/ssrfGuard.js';
import { AdsbFeedError, ADSB_REQUEST_TIMEOUT_MS, ADSB_USER_AGENT, type AdsbHttpResponse } from './adsbFeedClient.js';
import { OPENSKY_TOKEN_URL } from '../../utils/openSky.js';

/** Refresh this long before the token's stated expiry. */
export const REFRESH_MARGIN_MS = 60_000;
/** Used when the token response has no usable `expires_in`. */
export const DEFAULT_TOKEN_LIFETIME_S = 1_800;

export interface OpenSkyCredentials {
  clientId: string;
  clientSecret: string;
}

export type TokenHttpFn = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<AdsbHttpResponse>;

export interface OpenSkyTokenManagerDeps {
  http?: TokenHttpFn;
  now?: () => number;
  timeoutMs?: number;
}

interface CachedToken {
  key: string;
  token: string;
  refreshAt: number;
}

const defaultHttp: TokenHttpFn = (url, init) => safeFetch(url, init);

export class OpenSkyTokenManager {
  private readonly http: TokenHttpFn;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private cached: CachedToken | null = null;
  private pending: { key: string; promise: Promise<string> } | null = null;

  constructor(deps: OpenSkyTokenManagerDeps = {}) {
    this.http = deps.http ?? defaultHttp;
    this.now = deps.now ?? (() => Date.now());
    this.timeoutMs = deps.timeoutMs ?? ADSB_REQUEST_TIMEOUT_MS;
  }

  /** A valid token for these credentials, from cache when it is not near expiry. */
  getToken(creds: OpenSkyCredentials): Promise<string> {
    const key = `${creds.clientId}\u0000${creds.clientSecret}`;
    if (this.cached && this.cached.key === key && this.now() < this.cached.refreshAt) {
      return Promise.resolve(this.cached.token);
    }
    // Concurrent callers share one token request.
    if (this.pending && this.pending.key === key) return this.pending.promise;
    const promise = this.fetchToken(key, creds).finally(() => {
      if (this.pending?.promise === promise) this.pending = null;
    });
    this.pending = { key, promise };
    return promise;
  }

  /** Drop the cached token (after a 401), so the next `getToken` asks again. */
  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(key: string, creds: OpenSkyCredentials): Promise<string> {
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
    }).toString();

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      let res: AdsbHttpResponse;
      try {
        res = await this.http(OPENSKY_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': ADSB_USER_AGENT,
          },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) throw new AdsbFeedError(`OpenSky token request timed out after ${this.timeoutMs} ms`, 'timeout', null, true);
        throw new AdsbFeedError(`OpenSky token request failed: ${err instanceof Error ? err.message : err}`, 'network', null, true);
      }

      if (res.status < 200 || res.status >= 300) {
        // 400/401 = bad credentials. Back off like any other failure, so a
        // wrong secret does not ask again on every flagged node.
        throw new AdsbFeedError(`OpenSky token request returned HTTP ${res.status}`, 'auth', res.status, true);
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch {
        throw new AdsbFeedError('OpenSky token response was not JSON', 'parse', res.status, true);
      }
      const { access_token: token, expires_in: expiresIn } = (json ?? {}) as { access_token?: unknown; expires_in?: unknown };
      if (typeof token !== 'string' || !token) {
        throw new AdsbFeedError('OpenSky token response had no access_token', 'parse', res.status, true);
      }
      const lifetimeMs =
        (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_LIFETIME_S) * 1000;
      // A very short lifetime still gets half of itself, never zero.
      const usableMs = Math.max(lifetimeMs - REFRESH_MARGIN_MS, lifetimeMs / 2);
      this.cached = { key, token, refreshAt: this.now() + usableMs };
      return token;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const openSkyTokenManager = new OpenSkyTokenManager();
