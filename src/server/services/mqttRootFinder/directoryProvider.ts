/**
 * Live refresh of the community root directory (#6337).
 *
 * Off by default. An admin turns it on with the global
 * `mqttRootDirectoryRefreshEnabled` setting. While on, a successful Meshtastic
 * sample start calls {@link DirectoryProvider.refreshIfStale}, which may fetch
 * `https://api.meshtastic.org/resource/mqttRoots`:
 *
 *   - never at import, boot, or on a timer; only after a finder use;
 *   - at most once per 24 h after a success, once per 1 h after a failure;
 *   - one shared request for concurrent callers;
 *   - `redirect: 'error'`, 10 s timeout, 256 KB streamed body cap;
 *   - the document passes `validateDirectory`, or the current data stays.
 *
 * The request is a bare GET: no query string, no cookies, no location, no
 * broker, no user. It reveals the instance's IP and that someone used the
 * finder. The cache is in memory only; a restart serves the bundled copy until
 * the next finder use.
 */

import { safeFetch } from '../../utils/ssrfGuard.js';
import { logger } from '../../../utils/logger.js';
import { getDirectory, validateDirectory, type MqttRootDirectory } from './directory.js';

export const MQTT_ROOTS_URL = 'https://api.meshtastic.org/resource/mqttRoots';
export const DIRECTORY_TTL_MS = 24 * 60 * 60_000;
export const DIRECTORY_FAILURE_BACKOFF_MS = 60 * 60_000;
export const DIRECTORY_FETCH_TIMEOUT_MS = 10_000;
export const DIRECTORY_MAX_BYTES = 256 * 1024;
export const DIRECTORY_REFRESH_SETTING = 'mqttRootDirectoryRefreshEnabled';

export interface DirectoryStatus {
  source: 'bundled' | 'live';
  /** When the live copy was last confirmed (ms epoch). Only for `live`. */
  fetchedAt?: number;
}

export interface DirectoryProviderOptions {
  now?: () => number;
  /** Test seam; defaults to `safeFetch`. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /**
   * Whether an admin turned the refresh on. Defaults to "off": the finder
   * directory may not import the database (isolation.test.ts), so the caller
   * (the route) passes the real setting read to {@link refreshIfStale}.
   */
  isEnabled?: () => Promise<boolean>;
  bundled?: () => MqttRootDirectory;
}

class DirectoryFetchError extends Error {}

/** Read a body, giving up once it passes `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  const len = res.headers.get('content-length');
  if (len !== null && Number(len) > max) throw new DirectoryFetchError('body over size cap');
  if (!res.body) throw new DirectoryFetchError('no body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new DirectoryFetchError('body over size cap');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class DirectoryProvider {
  private readonly now: () => number;
  private readonly doFetch: (url: string, init: RequestInit) => Promise<Response>;
  private readonly isEnabled: () => Promise<boolean>;
  private readonly bundled: () => MqttRootDirectory;

  private live: MqttRootDirectory | null = null;
  private etag: string | null = null;
  private fetchedAt = 0;
  private failedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(opts: DirectoryProviderOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.doFetch = opts.fetch ?? ((url, init) => safeFetch(url, init));
    this.isEnabled = opts.isEnabled ?? (async () => false);
    this.bundled = opts.bundled ?? getDirectory;
  }

  /** The live copy when one is held, otherwise the bundled one. */
  current(): MqttRootDirectory {
    return this.live ?? this.bundled();
  }

  status(): DirectoryStatus {
    return this.live ? { source: 'live', fetchedAt: this.fetchedAt } : { source: 'bundled' };
  }

  /**
   * Fetch when the setting is on and the copy is stale. Never throws. With the
   * setting off it drops any live copy, so the bundled one is served again.
   * `isEnabled` overrides the constructor's check for this call.
   */
  refreshIfStale(isEnabled?: () => Promise<boolean>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.refresh(isEnabled ?? this.isEnabled)
      .catch(() => {})
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async refresh(isEnabled: () => Promise<boolean>): Promise<void> {
    // A failed setting read counts as off.
    const enabled = await isEnabled().catch(() => false);
    if (!enabled) {
      this.live = null;
      this.etag = null;
      this.fetchedAt = 0;
      return;
    }
    const t = this.now();
    if (this.live && t - this.fetchedAt < DIRECTORY_TTL_MS) return;
    if (this.failedAt && t - this.failedAt < DIRECTORY_FAILURE_BACKOFF_MS) return;

    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (this.live && this.etag) headers['If-None-Match'] = this.etag;
      const res = await this.doFetch(MQTT_ROOTS_URL, {
        redirect: 'error',
        signal: AbortSignal.timeout(DIRECTORY_FETCH_TIMEOUT_MS),
        headers,
      });
      if (res.status === 304 && this.live) {
        this.fetchedAt = this.now();
        this.failedAt = 0;
        return;
      }
      if (!res.ok) throw new DirectoryFetchError(`HTTP ${res.status}`);
      const text = await readCapped(res, DIRECTORY_MAX_BYTES);
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        throw new DirectoryFetchError('not JSON');
      }
      const valid = validateDirectory(raw);
      if (!valid) throw new DirectoryFetchError('failed validation');

      const bundled = this.bundled();
      const next: MqttRootDirectory = {
        // Entries replace wholesale: upstream removes entries on purpose.
        entries: valid.entries,
        neighbors: Object.keys(valid.neighbors).length ? valid.neighbors : bundled.neighbors,
        subdivisionSegments: Object.keys(valid.subdivisionSegments).length
          ? valid.subdivisionSegments
          : bundled.subdivisionSegments,
      };
      const changed = JSON.stringify(next) !== JSON.stringify(this.live ?? bundled);
      this.live = next;
      this.etag = res.headers.get('etag');
      this.fetchedAt = this.now();
      this.failedAt = 0;
      if (changed) logger.info(`MQTT root directory updated: ${next.entries.length} entries`);
    } catch (e) {
      this.failedAt = this.now();
      // The message is ours or a fetch error; neither names a user or broker.
      const why = e instanceof DirectoryFetchError ? e.message : (e as Error)?.name || 'error';
      logger.warn(`MQTT root directory refresh failed (${why}); keeping the current copy`);
    }
  }

  /** Test seam. */
  __resetForTests(): void {
    this.live = null;
    this.etag = null;
    this.fetchedAt = 0;
    this.failedAt = 0;
    this.inFlight = null;
  }
}

export const directoryProvider = new DirectoryProvider();
