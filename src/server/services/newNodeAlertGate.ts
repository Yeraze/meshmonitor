/**
 * New-node alert gate (#6306): a learning window plus an hourly cap, per source.
 *
 * A source that hears every advert in range (a logging MeshCore Repeater) has no
 * device-side "already known" set, so a fresh install would raise one alert per
 * node it learns. This gate holds alerts back in two ways:
 * - a learning window ({@link LEARN_MS}) after the source first logs the mesh,
 *   when nothing alerts;
 * - after that, at most {@link CAP_PER_HOUR} alerts per source per hour. Alerts
 *   over the cap are dropped and counted; the next alert that is allowed reports
 *   the count so the body can say "(+N more)".
 *
 * It is protocol-neutral (no MeshCore types) so another source type can adopt it
 * with one call. Today only Repeater sources use it.
 *
 * Mesh impact: sends nothing over the air.
 *
 * Safety timers (CLAUDE.md "Does a save reset a safety timer?"): both pieces of
 * state live in per-source settings, not in memory. A restart, reconnect, source
 * edit or notification-prefs save never touches them. Only {@link rearm}
 * (a full node purge) writes the learning window again, and it can only extend
 * the suppression.
 */
import databaseService from '../../services/database.js';
import { logger } from '../../utils/logger.js';
import { HourlyLogLimiter } from '../utils/hourlyLogLimiter.js';

/** Learning window: 4 default 12 h flood-advert cycles. Maintainer decision (#6306). */
export const LEARN_MS = 48 * 60 * 60_000;
/** Most alerts per source per fixed hour. Maintainer decision (#6306). */
export const CAP_PER_HOUR = 10;
/** Length of the fixed (non-sliding) cap window. */
export const CAP_WINDOW_MS = 60 * 60_000;

/** Per-source setting: epoch ms when the learning window ends. */
export const SETTING_LEARN_UNTIL = 'newNodeAlertLearnUntil';
/** Per-source setting: JSON {@link RateState}. */
export const SETTING_RATE = 'newNodeAlertRate';

export interface RateState {
  /** Start of the current fixed hour, epoch ms. */
  windowStart: number;
  /** Alerts allowed in this hour. */
  sent: number;
  /** Alerts dropped over the cap and not yet reported on an alert. */
  suppressed: number;
}

export interface AdmitResult {
  allow: boolean;
  reason?: 'learning' | 'capped';
  /** Nodes dropped over the cap since the last allowed alert (only when `allow`). */
  suppressedSinceLast?: number;
}

export interface NewNodeAlertGateDeps {
  now(): number;
  getSourceSetting(sourceId: string, key: string): Promise<string | null>;
  setSourceSetting(sourceId: string, key: string, value: string): Promise<void>;
  /** Earliest node row (epoch ms) of the source, or null when it has none. */
  getEarliestNodeCreatedAt(sourceId: string): Promise<number | null>;
}

function realDeps(): NewNodeAlertGateDeps {
  return {
    now: () => Date.now(),
    getSourceSetting: (sourceId, key) => databaseService.settings.getSettingForSource(sourceId, key),
    setSourceSetting: (sourceId, key, value) => databaseService.settings.setSourceSetting(sourceId, key, value),
    getEarliestNodeCreatedAt: (sourceId) => databaseService.meshcore.getEarliestNodeCreatedAt(sourceId),
  };
}

function parseEpoch(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parse the stored hourly counter; corrupt or missing data gives null. */
export function parseRateState(raw: string | null | undefined): RateState | null {
  if (!raw) return null;
  try {
    const p: unknown = JSON.parse(raw);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const { windowStart, sent, suppressed } = p as Record<string, unknown>;
    const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!ok(windowStart) || !ok(sent) || !ok(suppressed)) return null;
    return { windowStart, sent, suppressed };
  } catch {
    return null;
  }
}

export class NewNodeAlertGate {
  /** Serialises the read-check-write of one source's state. */
  private chains = new Map<string, Promise<unknown>>();
  private logLimiter = new HourlyLogLimiter();

  constructor(private deps: NewNodeAlertGateDeps = realDeps()) {}

  private serialise<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(sourceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.chains.set(sourceId, tail);
    void tail.then(() => {
      if (this.chains.get(sourceId) === tail) this.chains.delete(sourceId);
    });
    return next;
  }

  /**
   * End of the learning window. Read from the setting; when unset, written once as
   * (earliest node row, or now) + {@link LEARN_MS}, so a source that has been
   * logging for weeks is armed at once and a new one learns for the full window.
   */
  private async resolveLearnUntil(sourceId: string, now: number): Promise<number> {
    const stored = parseEpoch(await this.deps.getSourceSetting(sourceId, SETTING_LEARN_UNTIL));
    if (stored !== null) return stored;
    const earliest = await this.deps.getEarliestNodeCreatedAt(sourceId);
    const base = earliest !== null && earliest > 0 && earliest <= now ? earliest : now;
    const until = base + LEARN_MS;
    await this.deps.setSourceSetting(sourceId, SETTING_LEARN_UNTIL, String(until));
    return until;
  }

  /** Read-only: end of the learning window, or null when it is not set yet. */
  async learningUntil(sourceId: string): Promise<number | null> {
    return parseEpoch(await this.deps.getSourceSetting(sourceId, SETTING_LEARN_UNTIL));
  }

  /**
   * Decide whether one new node may raise an alert. A `learning` or `capped` result
   * means drop it. Allowed alerts are counted before the caller sends, so a crash
   * after this call can only under-alert.
   */
  admit(sourceId: string): Promise<AdmitResult> {
    return this.serialise(sourceId, async () => {
      const now = this.deps.now();
      const until = await this.resolveLearnUntil(sourceId, now);
      if (now < until) return { allow: false, reason: 'learning' as const };

      let state = parseRateState(await this.deps.getSourceSetting(sourceId, SETTING_RATE));
      // A fresh hour starts when the window has run out. A clock that stepped
      // back (now < windowStart) keeps the current window: resetting it would
      // reopen the cap.
      if (!state || now - state.windowStart >= CAP_WINDOW_MS) {
        state = { windowStart: now, sent: 0, suppressed: state?.suppressed ?? 0 };
      }

      if (state.sent >= CAP_PER_HOUR) {
        state.suppressed += 1;
        await this.deps.setSourceSetting(sourceId, SETTING_RATE, JSON.stringify(state));
        this.logLimiter.log(
          `new-node-cap:${sourceId}`,
          'warn',
          `[NewNodeAlertGate] Source ${sourceId} hit the ${CAP_PER_HOUR}/hour new-node alert cap; extra alerts are dropped`,
        );
        return { allow: false, reason: 'capped' as const };
      }

      const suppressedSinceLast = state.suppressed;
      state.sent += 1;
      state.suppressed = 0;
      await this.deps.setSourceSetting(sourceId, SETTING_RATE, JSON.stringify(state));
      return suppressedSinceLast > 0 ? { allow: true, suppressedSinceLast } : { allow: true };
    });
  }

  /**
   * Restart the learning window from now. Used by a full node purge only. Never
   * shortens a window that is still open.
   */
  rearm(sourceId: string): Promise<void> {
    return this.serialise(sourceId, async () => {
      const now = this.deps.now();
      const current = parseEpoch(await this.deps.getSourceSetting(sourceId, SETTING_LEARN_UNTIL));
      const until = Math.max(now + LEARN_MS, current ?? 0);
      await this.deps.setSourceSetting(sourceId, SETTING_LEARN_UNTIL, String(until));
      logger.info(`[NewNodeAlertGate] Re-armed the new-node learning window for source ${sourceId}`);
    });
  }
}

export const newNodeAlertGate = new NewNodeAlertGate();
