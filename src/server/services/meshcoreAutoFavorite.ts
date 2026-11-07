/**
 * MeshCore Auto Favorite (#6224) — parity with the Meshtastic auto-favorite.
 *
 * When enabled on a source, a periodic sweep favourites every contact heard
 * within a stale window and un-favourites the ones the automation previously
 * favourited once they go stale. Favouriting writes the firmware favourite bit
 * to the companion (via `MeshCoreManager.setNodeFavorite`), which also protects
 * a contact from the device's contact-table eviction (#4838).
 *
 * Two safety properties:
 *   - It only ever un-favourites nodes IT favourited. The set it manages is
 *     tracked in the `meshcoreAutoFavoriteNodes` per-source setting, so a node
 *     the user favourited by hand (not in that set) is never touched.
 *   - The last-sweep cadence lives in settings, not an instance field, and the
 *     sweep is idempotent, so a restart or a settings save never causes a burst
 *     of device writes beyond the normal per-cycle set.
 *
 * Writes go to the companion over its own link (serial/TCP), not the LoRa mesh,
 * so there is no airtime cost; the cadence still defaults slow (6h) to keep
 * device interaction light.
 */
import { logger } from '../../utils/logger.js';
import databaseService from '../../services/database.js';

/** Default sweep cadence (hours). */
export const AUTO_FAVORITE_DEFAULT_INTERVAL_HOURS = 6;
export const AUTO_FAVORITE_MIN_INTERVAL_HOURS = 1;
export const AUTO_FAVORITE_MAX_INTERVAL_HOURS = 48;
/** Default stale window (hours): a contact not heard within this is dropped. */
export const AUTO_FAVORITE_DEFAULT_STALE_HOURS = 72;
export const AUTO_FAVORITE_MIN_STALE_HOURS = 1;
export const AUTO_FAVORITE_MAX_STALE_HOURS = 24 * 30;

/** Minimal contact shape the planner needs. */
export interface AutoFavoriteContact {
  publicKey: string;
  lastSeen?: number | null;
  isFavorite?: boolean;
}

export interface AutoFavoritePlan {
  /** Active, not-yet-favourited contacts to favourite now. */
  toFavorite: string[];
  /** Previously auto-favourited contacts that went stale — un-favourite now. */
  toUnfavorite: string[];
  /** The new tracked set to persist (what the automation now owns). */
  newTracked: string[];
}

/**
 * Pure sweep planner, exported for unit tests. Given the current contacts, the
 * previously-tracked set, the stale window, and whether the feature is enabled,
 * decides which contacts to favourite / un-favourite and the new tracked set.
 *
 * Disabled ⇒ un-favourite everything the automation owns and track nothing.
 * Only tracked nodes are ever un-favourited, so manual favourites are safe.
 */
export function planAutoFavoriteSweep(opts: {
  contacts: AutoFavoriteContact[];
  tracked: string[];
  staleHours: number;
  now: number;
  enabled: boolean;
}): AutoFavoritePlan {
  const tracked = new Set(opts.tracked.map((k) => k.toLowerCase()));
  if (!opts.enabled) {
    return { toFavorite: [], toUnfavorite: [...tracked], newTracked: [] };
  }
  const staleMs = Math.max(opts.staleHours, AUTO_FAVORITE_MIN_STALE_HOURS) * 3_600_000;
  const isActive = (c: AutoFavoriteContact) =>
    typeof c.lastSeen === 'number' && c.lastSeen > 0 && opts.now - c.lastSeen <= staleMs;

  const activeKeys = new Set(
    opts.contacts.filter(isActive).map((c) => c.publicKey.toLowerCase()),
  );
  // Favourite active contacts that are not already favourited (manual or auto).
  const toFavorite = opts.contacts
    .filter((c) => isActive(c) && !c.isFavorite)
    .map((c) => c.publicKey.toLowerCase());
  // Un-favourite tracked nodes that are no longer active.
  const toUnfavorite = [...tracked].filter((k) => !activeKeys.has(k));
  // Keep tracking still-active tracked nodes plus the newly favourited ones.
  const newTracked = [
    ...new Set([...[...tracked].filter((k) => activeKeys.has(k)), ...toFavorite]),
  ];
  return { toFavorite, toUnfavorite, newTracked };
}

/** Manager surface the sweep runner needs (kept thin for testability). */
export interface AutoFavoriteManager {
  sourceId: string;
  getContacts: () => AutoFavoriteContact[];
  setNodeFavorite: (publicKey: string, isFavorite: boolean) => Promise<void>;
}

/**
 * Run one sweep for a source: read settings, plan, apply favourite/un-favourite
 * writes, and persist the new tracked set. Returns a small summary. Never
 * throws — a single failed device write is logged and the rest continue.
 */
export async function runAutoFavoriteSweep(
  mgr: AutoFavoriteManager,
  now: number = Date.now(),
): Promise<{ favorited: number; unfavorited: number }> {
  const sourceId = mgr.sourceId;
  const get = (key: string) => databaseService.settings.getSettingForSource(sourceId, key);

  const enabled = (await get('meshcoreAutoFavoriteEnabled')) === 'true';
  const staleHours = clampStaleHours(await get('meshcoreAutoFavoriteStaleHours'));
  let tracked: string[] = [];
  try {
    tracked = JSON.parse((await get('meshcoreAutoFavoriteNodes')) || '[]');
    if (!Array.isArray(tracked)) tracked = [];
  } catch {
    tracked = [];
  }

  // Nothing to do and nothing owned — skip without reading contacts.
  if (!enabled && tracked.length === 0) return { favorited: 0, unfavorited: 0 };

  const plan = planAutoFavoriteSweep({ contacts: mgr.getContacts(), tracked, staleHours, now, enabled });

  let favorited = 0;
  for (const publicKey of plan.toFavorite) {
    try {
      await mgr.setNodeFavorite(publicKey, true);
      favorited += 1;
    } catch (err) {
      logger.warn(`[MeshCoreAutoFavorite:${sourceId}] favourite ${publicKey.substring(0, 12)}… failed: ${(err as Error).message}`);
    }
  }
  let unfavorited = 0;
  for (const publicKey of plan.toUnfavorite) {
    try {
      await mgr.setNodeFavorite(publicKey, false);
      unfavorited += 1;
    } catch (err) {
      logger.warn(`[MeshCoreAutoFavorite:${sourceId}] un-favourite ${publicKey.substring(0, 12)}… failed: ${(err as Error).message}`);
    }
  }

  await databaseService.settings.setSourceSetting(
    sourceId,
    'meshcoreAutoFavoriteNodes',
    JSON.stringify(plan.newTracked),
  );

  if (favorited || unfavorited) {
    logger.info(`[MeshCoreAutoFavorite:${sourceId}] sweep: +${favorited} favourited, -${unfavorited} un-favourited`);
  }
  return { favorited, unfavorited };
}

export function clampIntervalHours(value: string | null | undefined): number {
  const n = parseInt(value || '', 10);
  if (!Number.isFinite(n)) return AUTO_FAVORITE_DEFAULT_INTERVAL_HOURS;
  return Math.min(Math.max(n, AUTO_FAVORITE_MIN_INTERVAL_HOURS), AUTO_FAVORITE_MAX_INTERVAL_HOURS);
}

export function clampStaleHours(value: string | null | undefined): number {
  const n = parseInt(value || '', 10);
  if (!Number.isFinite(n)) return AUTO_FAVORITE_DEFAULT_STALE_HOURS;
  return Math.min(Math.max(n, AUTO_FAVORITE_MIN_STALE_HOURS), AUTO_FAVORITE_MAX_STALE_HOURS);
}

/**
 * Per-source scheduler. Owned by the MeshCoreManager, mirroring
 * DistanceDeleteScheduler: `start()` reads this source's settings and arms a
 * timer (no-op when disabled); a settings save calls `start()` again to re-arm.
 */
export class MeshCoreAutoFavoriteScheduler {
  private interval: ReturnType<typeof setInterval> | null = null;
  private initialTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sourceId: string,
    private readonly run: () => Promise<unknown>,
  ) {}

  async start(): Promise<void> {
    this.stop();
    const enabled = await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoFavoriteEnabled');
    if (enabled !== 'true') {
      logger.debug(`[MeshCoreAutoFavorite:${this.sourceId}] disabled`);
      return;
    }
    const intervalHours = clampIntervalHours(
      await databaseService.settings.getSettingForSource(this.sourceId, 'meshcoreAutoFavoriteIntervalHours'),
    );
    const intervalMs = intervalHours * 60 * 60 * 1000;
    logger.info(`[MeshCoreAutoFavorite:${this.sourceId}] scheduler starting (interval: ${intervalHours}h)`);

    // First sweep 2 minutes after arming (lets the contact list settle), then
    // every intervalMs. unref so the timer never keeps the process alive.
    this.initialTimeout = setTimeout(() => {
      this.run().catch((err) => logger.error(`[MeshCoreAutoFavorite:${this.sourceId}] initial sweep failed:`, err));
    }, 120_000);
    if (typeof this.initialTimeout.unref === 'function') this.initialTimeout.unref();

    this.interval = setInterval(() => {
      this.run().catch((err) => logger.error(`[MeshCoreAutoFavorite:${this.sourceId}] sweep failed:`, err));
    }, intervalMs);
    if (typeof this.interval.unref === 'function') this.interval.unref();
  }

  stop(): void {
    if (this.initialTimeout) {
      clearTimeout(this.initialTimeout);
      this.initialTimeout = null;
    }
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  get running(): boolean {
    return this.interval !== null;
  }
}
