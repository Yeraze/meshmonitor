/**
 * Version Check Service
 *
 * Single server-side poller that detects new MeshMonitor releases. Replaces the
 * browser-driven GitHub fetch that used to live in the `/version/check` route
 * and the duplicated scheduled fetch in server.ts (Auto-Upgrade Retirement, 4.13).
 *
 * Responsibilities:
 *  - Poll GitHub's "latest release" API every 6 hours (first check ~60s after
 *    boot), skipped entirely when `versionCheckDisabled`.
 *  - Cache the result so the `/version/check` endpoint is a cheap cache read.
 *  - Fire the existing `upgrade-available` automation event HEADLESSLY (no open
 *    browser required) via `notifyUpgradeAvailable`. The helper dedupes by
 *    version; we add a local guard so a repeated poll for the same version does
 *    not re-invoke it.
 *
 * This service NEVER triggers an upgrade — detection/notification only.
 */
import { createRequire } from 'module';
import { logger } from '../../utils/logger.js';
import { getEnvironmentConfig } from '../config/environment.js';
import { compareVersions, checkDockerImageExists } from '../utils/systemInfo.js';
import { notifyUpgradeAvailable } from './automation/automationEngineSingleton.js';

const require = createRequire(import.meta.url);
const packageJson = require('../../../package.json');

const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/Yeraze/meshmonitor/releases/latest';
const POLL_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const INITIAL_DELAY_MS = 60 * 1000; // First check ~60s after boot
const ON_DEMAND_REFRESH_MS = 5 * 60 * 1000; // getStatus() refreshes if cache is older than this

export interface VersionCheckStatus {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  publishedAt: string | null;
  imageReady: boolean;
  checkedAt: number;
  /** Present only when the last check failed (GitHub unreachable / non-OK). */
  error?: string;
}

class VersionCheckService {
  private cache: VersionCheckStatus | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<VersionCheckStatus> | null = null;
  /** Last version we handed to notifyUpgradeAvailable, to avoid re-firing. */
  private lastNotifiedVersion: string | null = null;

  private isDisabled(): boolean {
    return getEnvironmentConfig().versionCheckDisabled;
  }

  /**
   * Start the background poller. No-op when `versionCheckDisabled`. Idempotent.
   */
  start(): void {
    if (this.isDisabled()) {
      logger.debug('Version check disabled (VERSION_CHECK_DISABLED=true); poller not started');
      return;
    }
    if (this.timer) return;

    const initial = setTimeout(() => {
      this.refresh().catch((err) => logger.debug('Initial version check failed:', err));
    }, INITIAL_DELAY_MS);
    if (typeof initial.unref === 'function') initial.unref();

    this.timer = setInterval(() => {
      this.refresh().catch((err) => logger.debug('Scheduled version check failed:', err));
    }, POLL_INTERVAL_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the poller (test / shutdown). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Return the cached status, triggering an on-demand refresh when the cache is
   * missing or older than ~5 min. This preserves the freshness the old
   * `/version/check` endpoint provided (it cached successful checks for 5 min).
   */
  async getStatus(): Promise<VersionCheckStatus> {
    if (!this.cache || Date.now() - this.cache.checkedAt >= ON_DEMAND_REFRESH_MS) {
      return this.refresh();
    }
    return this.cache;
  }

  /** Synchronous peek at the cache without triggering a refresh. */
  getCached(): VersionCheckStatus | null {
    return this.cache;
  }

  /**
   * Force a refresh from GitHub. Concurrent callers share a single in-flight
   * request. A failed check is tolerated: it resolves to an `error`-bearing
   * status and does not overwrite the last-good cache values for version fields.
   */
  async refresh(): Promise<VersionCheckStatus> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private failureStatus(error: string): VersionCheckStatus {
    return {
      updateAvailable: false,
      currentVersion: packageJson.version,
      latestVersion: this.cache?.latestVersion ?? null,
      releaseUrl: this.cache?.releaseUrl ?? null,
      releaseName: this.cache?.releaseName ?? null,
      publishedAt: this.cache?.publishedAt ?? null,
      imageReady: false,
      checkedAt: Date.now(),
      error,
    };
  }

  private async doRefresh(): Promise<VersionCheckStatus> {
    const currentVersion = packageJson.version;
    try {
      const response = await fetch(GITHUB_LATEST_RELEASE_URL);
      if (!response.ok) {
        logger.warn(`GitHub API returned ${response.status} for version check`);
        // Do not cache transient failures — keep the last-good cache intact.
        return this.failureStatus('Unable to check for updates');
      }

      const release = await response.json();
      const latestVersion = String(release.tag_name ?? '').replace(/^v/, '');
      const current = currentVersion.replace(/^v/, '');
      const isNewerVersion = latestVersion !== '' && compareVersions(latestVersion, current) > 0;
      const imageReady = await checkDockerImageExists(latestVersion, release.published_at);
      const updateAvailable = isNewerVersion && imageReady;

      const status: VersionCheckStatus = {
        updateAvailable,
        currentVersion,
        latestVersion,
        releaseUrl: release.html_url ?? null,
        releaseName: release.name ?? null,
        publishedAt: release.published_at ?? null,
        imageReady,
        checkedAt: Date.now(),
      };
      this.cache = status;

      // Fire the `upgrade-available` automation event headlessly. The helper
      // also dedupes by version; the local guard avoids the redundant call.
      if (updateAvailable && latestVersion !== this.lastNotifiedVersion) {
        this.lastNotifiedVersion = latestVersion;
        notifyUpgradeAvailable({
          latestVersion,
          currentVersion,
          releaseUrl: release.html_url,
          releaseName: release.name,
        }).catch((err) =>
          logger.error('Failed to raise upgrade-available automation event:', err),
        );
      }

      return status;
    } catch (error) {
      logger.error('Error checking for version updates:', error);
      return this.failureStatus('Unable to check for updates');
    }
  }

  /** Test-only: clear all in-memory state. */
  __resetForTests(): void {
    this.stop();
    this.cache = null;
    this.inFlight = null;
    this.lastNotifiedVersion = null;
  }
}

export const versionCheckService = new VersionCheckService();
