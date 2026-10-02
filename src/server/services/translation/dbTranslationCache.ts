/**
 * Database-backed translation cache (#5520).
 *
 * Implements the `ITranslationCache` seam over the global `translation_cache`
 * table. Keys are hashed (`computeTranslationCacheKey`); the text itself is
 * never written. A hit refreshes `lastUsedAt` and bumps `hitCount` (the TTL
 * runs from last use). Installed by `translationCacheService.start()`.
 */
import databaseService from '../../../services/database.js';
import { logger } from '../../../utils/logger.js';
import type { CachedTranslation, ITranslationCache, TranslationCacheKey } from './translationCache.js';
import { computeTranslationCacheKey, normalizeSourceLang, normalizeTargetLang } from './cacheKey.js';

export function cacheKeyFor(key: TranslationCacheKey): string {
  return computeTranslationCacheKey(key.text, key.targetLanguage, key.sourceLanguage);
}

export class DbTranslationCache implements ITranslationCache {
  async get(key: TranslationCacheKey): Promise<CachedTranslation | null> {
    const cacheKey = cacheKeyFor(key);
    const row = await databaseService.translations.getCacheEntry(cacheKey);
    if (!row) return null;
    try {
      await databaseService.translations.touchCacheEntry(cacheKey);
    } catch (err) {
      // A failed touch only shortens the entry's life; still serve the hit.
      logger.warn('Failed to refresh translation cache entry:', err);
    }
    return {
      translatedText: row.translatedText,
      detectedSourceLanguage: row.detectedSourceLanguage ?? undefined,
      sourceText: key.text,
      targetLanguage: row.targetLang,
      provider: row.provider,
      cachedAt: row.createdAt,
    };
  }

  async set(key: TranslationCacheKey, translation: CachedTranslation): Promise<void> {
    await databaseService.translations.insertCacheEntry({
      cacheKey: cacheKeyFor(key),
      targetLang: normalizeTargetLang(key.targetLanguage),
      sourceLang: normalizeSourceLang(key.sourceLanguage),
      translatedText: translation.translatedText,
      detectedSourceLanguage: translation.detectedSourceLanguage ?? null,
      provider: translation.provider || 'unknown',
    });
  }

  async has(key: TranslationCacheKey): Promise<boolean> {
    return (await databaseService.translations.getCacheEntry(cacheKeyFor(key))) !== null;
  }
}
