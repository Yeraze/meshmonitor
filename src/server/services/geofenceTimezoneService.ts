/**
 * Geofence Timezone Service
 *
 * Periodically reads a designated source node's GPS position and computes
 * the local timezone. When the source node moves more than a configurable
 * distance from the last-applied position, the service records the new
 * timezone in settings so the operator (or a follow-up service / restart
 * hook) can apply it.
 *
 * Designed for mobile MeshMonitor deployments (RV / boat / overlanding
 * setups) where the source node moves between timezones but the server's
 * TZ env stays static — causing log timestamps and scheduled tasks to
 * drift relative to local time.
 *
 * This first-pass implementation is opt-in (default off) and scope-limited:
 *   - Reads source node GPS, computes IANA tz via geo-tz
 *   - Persists detected timezone to settings (geofenceTzDetected)
 *   - Persists last-applied lat/lon for debouncing
 *   - Does NOT auto-restart the server (TZ env is startup-only in the
 *     current architecture — the restart strategy is the harder design
 *     question deferred to a follow-up PR)
 *
 * Modeled after autoDeleteByDistanceService for consistency.
 *
 * Settings keys:
 *   - geofenceTzEnabled (boolean) — default false
 *   - geofenceTzSourceNodeId (string) — the !hex node id whose GPS drives TZ
 *   - geofenceTzThresholdMiles (number) — distance threshold, default 20
 *   - geofenceTzDetected (string, written by service) — last detected IANA tz
 *   - geofenceTzLastLat / geofenceTzLastLon (number, written by service)
 *   - geofenceTzLastCheckedAt (number, ms, written by service)
 */

import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';
import { calculateDistance, kmToMiles } from '../../utils/distance.js';

interface DetectionResult {
  detected: boolean;
  reason: string;
  timezone?: string;
  latitude?: number;
  longitude?: number;
  distanceMiles?: number;
}

class GeofenceTimezoneService {
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastRunAt: number | null = null;
  private isRunning = false;
  private readonly DEFAULT_INTERVAL_MINUTES = 15;
  private readonly DEFAULT_THRESHOLD_MILES = 20;

  /**
   * Start the geofence-timezone service.
   * No-op if already started — call stop() first to restart.
   */
  public start(intervalMinutes: number = this.DEFAULT_INTERVAL_MINUTES): void {
    if (this.checkInterval) {
      logger.warn('⚠️  Geofence-timezone service is already running');
      return;
    }

    logger.info(
      `🌐 Starting geofence-timezone service (interval: ${intervalMinutes} minutes)`
    );

    // First check after 2 minutes — gives DB / sources time to settle.
    setTimeout(() => {
      this.runCheckCycle().catch((err) =>
        logger.error('❌ Geofence-timezone: initial check failed:', err)
      );
    }, 120_000);

    this.checkInterval = setInterval(() => {
      this.runCheckCycle().catch((err) =>
        logger.error('❌ Geofence-timezone: scheduled check failed:', err)
      );
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop the service. Does not abort an in-progress run.
   */
  public stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
      logger.info('⏹️  Geofence-timezone service stopped');
    }
  }

  /**
   * Manual trigger from API / settings change.
   */
  public async runNow(): Promise<DetectionResult> {
    return this.runCheckCycle();
  }

  /**
   * Service status (for /api/services or admin UI).
   */
  public getStatus(): { running: boolean; lastRunAt?: number } {
    return {
      running: this.checkInterval !== null,
      lastRunAt: this.lastRunAt ?? undefined,
    };
  }

  /**
   * Core detection logic. Idempotent — safe to call multiple times.
   * Returns whether a new timezone was detected this cycle.
   */
  public async runCheckCycle(): Promise<DetectionResult> {
    if (this.isRunning) {
      logger.debug('⏭️  Geofence-timezone: skipping, already running');
      return { detected: false, reason: 'already_running' };
    }
    this.isRunning = true;

    try {
      const enabled = await databaseService.settings.getSettingAsBoolean(
        'geofenceTzEnabled',
        false
      );
      if (!enabled) {
        logger.debug('⏭️  Geofence-timezone: disabled in settings');
        return { detected: false, reason: 'disabled' };
      }

      const sourceNodeId = await databaseService.settings.getSetting(
        'geofenceTzSourceNodeId'
      );
      if (!sourceNodeId) {
        logger.debug('⏭️  Geofence-timezone: no source node configured');
        return { detected: false, reason: 'no_source_node' };
      }

      const thresholdMilesStr = await databaseService.settings.getSetting(
        'geofenceTzThresholdMiles'
      );
      const thresholdMiles = thresholdMilesStr
        ? parseFloat(thresholdMilesStr)
        : this.DEFAULT_THRESHOLD_MILES;

      // Fetch the configured source node — supports both !hex string ids
      // and bare node-num strings.
      const node = await this.fetchSourceNode(sourceNodeId);
      if (!node) {
        logger.debug(
          `⏭️  Geofence-timezone: source node ${sourceNodeId} not found in DB`
        );
        return { detected: false, reason: 'node_not_found' };
      }

      const lat = node.latitude ?? null;
      const lon = node.longitude ?? null;
      if (lat == null || lon == null) {
        logger.debug(
          `⏭️  Geofence-timezone: source node ${sourceNodeId} has no GPS position yet`
        );
        return { detected: false, reason: 'no_gps' };
      }

      // Distance check against last-applied position (debounce)
      const lastLatStr = await databaseService.settings.getSetting(
        'geofenceTzLastLat'
      );
      const lastLonStr = await databaseService.settings.getSetting(
        'geofenceTzLastLon'
      );
      const lastTzStored = await databaseService.settings.getSetting(
        'geofenceTzDetected'
      );

      const lastLat = lastLatStr ? parseFloat(lastLatStr) : null;
      const lastLon = lastLonStr ? parseFloat(lastLonStr) : null;

      let distanceMiles = 0;
      if (lastLat != null && lastLon != null && !isNaN(lastLat) && !isNaN(lastLon)) {
        distanceMiles = kmToMiles(calculateDistance(lastLat, lastLon, lat, lon));
      }

      const tz = await this.lookupTimezone(lat, lon);
      if (!tz) {
        logger.warn(
          `⚠️  Geofence-timezone: tz lookup returned no result for (${lat}, ${lon})`
        );
        return { detected: false, reason: 'tz_lookup_failed' };
      }

      const tzChanged = tz !== lastTzStored;
      const distanceTriggered =
        lastLat == null || lastLon == null || distanceMiles >= thresholdMiles;

      const now = Date.now();
      this.lastRunAt = now;
      await databaseService.settings.setSetting(
        'geofenceTzLastCheckedAt',
        String(now)
      );

      if (!tzChanged && !distanceTriggered) {
        logger.debug(
          `✅ Geofence-timezone: no change (tz=${tz}, distance=${distanceMiles.toFixed(2)}mi, threshold=${thresholdMiles}mi)`
        );
        return {
          detected: false,
          reason: 'no_change',
          timezone: tz,
          latitude: lat,
          longitude: lon,
          distanceMiles,
        };
      }

      // Persist new detection
      await databaseService.settings.setSetting('geofenceTzDetected', tz);
      await databaseService.settings.setSetting('geofenceTzLastLat', String(lat));
      await databaseService.settings.setSetting('geofenceTzLastLon', String(lon));

      logger.info(
        `🌐 Geofence-timezone: detected new tz=${tz} (${lat.toFixed(4)}, ${lon.toFixed(4)}, moved ${distanceMiles.toFixed(2)}mi). NOTE: server restart required for TZ env to take effect — see issue #2924.`
      );

      return {
        detected: true,
        reason: tzChanged ? 'tz_changed' : 'distance_threshold',
        timezone: tz,
        latitude: lat,
        longitude: lon,
        distanceMiles,
      };
    } catch (error) {
      logger.error('❌ Geofence-timezone: error during check cycle:', error);
      return { detected: false, reason: 'error' };
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Resolve the configured source node by either !hex id or bare node-num.
   * Exposed for testability.
   */
  public async fetchSourceNode(idOrNum: string): Promise<{
    latitude?: number | null;
    longitude?: number | null;
  } | null> {
    try {
      // Prefer node-id form (!aabbccdd) — most common UX
      if (idOrNum.startsWith('!')) {
        return await databaseService.nodes.getNodeByNodeId(idOrNum);
      }
      // Otherwise treat as a node-num
      const num = parseInt(idOrNum, 10);
      if (isNaN(num)) return null;
      return await databaseService.nodes.getNode(num);
    } catch (err) {
      logger.warn('⚠️  Geofence-timezone: fetchSourceNode failed:', err);
      return null;
    }
  }

  /**
   * Look up IANA timezone for a (lat, lon) pair using geo-tz.
   * Imported lazily so the heavy boundary dataset only loads when the
   * service is actually used.
   *
   * Exposed (not private) so tests can stub it without monkey-patching
   * the geo-tz module loader.
   */
  public async lookupTimezone(lat: number, lon: number): Promise<string | null> {
    try {
      const geoTz = await import('geo-tz');
      const find = (geoTz as unknown as { find: (lat: number, lon: number) => string[] }).find;
      const zones = find(lat, lon);
      if (Array.isArray(zones) && zones.length > 0) {
        return zones[0];
      }
      return null;
    } catch (err) {
      logger.error('❌ Geofence-timezone: tz lookup error:', err);
      return null;
    }
  }
}

export const geofenceTimezoneService = new GeofenceTimezoneService();
export { GeofenceTimezoneService };
