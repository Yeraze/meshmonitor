/**
 * Translation Cache Abstraction
 *
 * Provides an interface for caching translations, with a default
 * NoOpTranslationCache implementation that can be swapped out later
 * (e.g. for an in-memory LRU, SQLite, or Redis cache) without changing
 * the translation service or route layer.
 */

export interface TranslationCacheKey {
  text: string;
  targetLanguage: string;
  sourceLanguage?: string;
}

export interface CachedTranslation {
  translatedText: string;
  detectedSourceLanguage?: string;
  sourceText: string;
  targetLanguage: string;
  provider?: string;
  cachedAt: number;
}

export interface ITranslationCache {
  get(key: TranslationCacheKey): Promise<CachedTranslation | null>;
  set(key: TranslationCacheKey, translation: CachedTranslation): Promise<void>;
  has(key: TranslationCacheKey): Promise<boolean>;
  clear?(): Promise<void>;
}

/**
 * Default No-Op cache implementation.
 * Always misses on get and silently accepts set.
 */
export class NoOpTranslationCache implements ITranslationCache {
  async get(_key: TranslationCacheKey): Promise<CachedTranslation | null> {
    return null;
  }

  async set(_key: TranslationCacheKey, _translation: CachedTranslation): Promise<void> {
    // No-op
  }

  async has(_key: TranslationCacheKey): Promise<boolean> {
    return false;
  }

  async clear(): Promise<void> {
    // No-op
  }
}

let activeTranslationCache: ITranslationCache = new NoOpTranslationCache();

export function getTranslationCache(): ITranslationCache {
  return activeTranslationCache;
}

export function setTranslationCache(cache: ITranslationCache): void {
  activeTranslationCache = cache;
}
