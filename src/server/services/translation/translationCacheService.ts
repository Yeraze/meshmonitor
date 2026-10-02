/**
 * Translation cache lifecycle (#5520): installs the DB-backed cache and runs
 * the prune job — once shortly after startup, then hourly.
 *
 * Maintainer decisions (TRANSLATION_CACHE_SPEC.md "Expiry"):
 *  - unreferenced entries expire 30 days after LAST use;
 *  - at most 10,000 non-pinned entries, least recently used pruned first;
 *  - entries referenced by a message are never pruned, and entries referenced
 *    by >= 2 messages are pinned. Nothing for admins to tune.
 *
 * DB-only, no mesh traffic. Cutoff-based and stateless: a restart or a
 * settings save cannot cause a burst or reset a timer (mesh-impact §3).
 * Like `coverageRetentionService`, the constructor does not start a timer, so
 * importing this module from a test never spins one up.
 */
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import { setTranslationCache } from './translationCache.js';
import { DbTranslationCache } from './dbTranslationCache.js';

export const TRANSLATION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const TRANSLATION_CACHE_MAX_UNPINNED = 10_000;

class TranslationCacheService {
  private intervalId: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private readonly PRUNE_INTERVAL_MS = 60 * 60 * 1000; // hourly
  private readonly INITIAL_DELAY_MS = 30 * 1000;

  /** Install the DB cache and schedule pruning. Idempotent. */
  start(): void {
    if (this.intervalId || this.initialTimer) return;

    setTranslationCache(new DbTranslationCache());
    logger.debug('🌐 Translation cache enabled (prune runs hourly)');

    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.runPrune();
    }, this.INITIAL_DELAY_MS);

    this.intervalId = setInterval(() => {
      void this.runPrune();
    }, this.PRUNE_INTERVAL_MS);
  }

  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** One prune pass. Never throws. */
  async runPrune(now: number = Date.now()): Promise<void> {
    try {
      const result = await databaseService.translations.pruneCache({
        now,
        ttlMs: TRANSLATION_CACHE_TTL_MS,
        maxUnpinned: TRANSLATION_CACHE_MAX_UNPINNED,
      });
      if (result.orphanedLinksRemoved || result.expired || result.evicted) {
        logger.debug(
          `🌐 Translation cache prune: ${result.orphanedLinksRemoved} orphaned link(s), ` +
            `${result.expired} expired, ${result.evicted} evicted`,
        );
      }
    } catch (error) {
      logger.error('❌ Translation cache prune failed:', error);
    }
  }
}

export const translationCacheService = new TranslationCacheService();
