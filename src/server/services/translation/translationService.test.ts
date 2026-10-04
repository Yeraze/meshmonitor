import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isNonConversational,
  buildServiceEndpoint,
  translationService,
} from './translationService.js';
import {
  NoOpTranslationCache,
  setTranslationCache,
  type ITranslationCache,
  type CachedTranslation,
  type TranslationCacheKey,
} from './translationCache.js';
import { computeTranslationCacheKey } from './cacheKey.js';

vi.mock('../../../services/database.js', () => ({
  default: {
    getSettingAsync: vi.fn(),
    translations: {
      linkMessage: vi.fn().mockResolvedValue(true),
    },
    settings: {
      getSettingAsync: vi.fn(),
    },
  },
}));

import databaseService from '../../../services/database.js';

describe('translationService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    setTranslationCache(new NoOpTranslationCache());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('buildServiceEndpoint', () => {
    it('should return default endpoint when baseUrl is empty or whitespace', () => {
      expect(buildServiceEndpoint('', 'https://api.deepl.com/v2/translate', '/translate')).toBe('https://api.deepl.com/v2/translate');
      expect(buildServiceEndpoint('   ', 'https://api.deepl.com/v2/translate', '/translate')).toBe('https://api.deepl.com/v2/translate');
    });

    it('should append path when bare origin is provided', () => {
      expect(buildServiceEndpoint('https://api.deepl.com', 'default', '/translate')).toBe('https://api.deepl.com/translate');
      expect(buildServiceEndpoint('https://api.deepl.com/', 'default', '/translate')).toBe('https://api.deepl.com/translate');
    });

    it('should preserve URL verbatim when path is provided', () => {
      expect(buildServiceEndpoint('https://api.deepl.com/v2/translate', 'default', '/translate')).toBe('https://api.deepl.com/v2/translate');
      expect(buildServiceEndpoint('https://api.deepl.com/v2/translate/', 'default', '/translate')).toBe('https://api.deepl.com/v2/translate');
      expect(buildServiceEndpoint('https://custom.proxy/api/v1', 'default', '/translate')).toBe('https://custom.proxy/api/v1');
    });
  });

  describe('isNonConversational', () => {
    it('should filter out empty, whitespace, and null/undefined strings', () => {
      expect(isNonConversational('')).toBe(true);
      expect(isNonConversational('   ')).toBe(true);
      expect(isNonConversational(null as unknown as string)).toBe(true);
      expect(isNonConversational(undefined as unknown as string)).toBe(true);
    });

    it('should filter out JSON and telemetry data strings', () => {
      expect(isNonConversational('{"temp": 21.5, "humidity": 60}')).toBe(true);
      expect(isNonConversational('[12, 34, 56]')).toBe(true);
      expect(isNonConversational('{"type": "telemetry"}')).toBe(true);
    });

    it('should filter out ping, pong, ack, test, 73, and short status pings', () => {
      expect(isNonConversational('ack')).toBe(true);
      expect(isNonConversational('ACK')).toBe(true);
      expect(isNonConversational('ping')).toBe(true);
      expect(isNonConversational('Ping!')).toBe(true);
      expect(isNonConversational('pong')).toBe(true);
      expect(isNonConversational('test')).toBe(true);
      expect(isNonConversational('73')).toBe(true);
      expect(isNonConversational('73s')).toBe(true);
      expect(isNonConversational('ok')).toBe(true);
      expect(isNonConversational('roger')).toBe(true);
      expect(isNonConversational('qsl')).toBe(true);
    });

    it('should filter out pure emoji strings', () => {
      expect(isNonConversational('👍')).toBe(true);
      expect(isNonConversational('🔥')).toBe(true);
      expect(isNonConversational('😀')).toBe(true);
    });

    it('should accept real conversational messages', () => {
      expect(isNonConversational('Hello from the mountaintop node!')).toBe(false);
      expect(isNonConversational('Anyone on channel 0 near downtown?')).toBe(false);
      expect(isNonConversational('こんにちは、お元気ですか？')).toBe(false);
      expect(isNonConversational('¿Alguien puede escucharme en el repetidor?')).toBe(false);
    });
  });

  describe('getSettings', () => {
    it('should read settings from databaseService', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        const map: Record<string, string> = {
          translationEnabled: 'true',
          translationProvider: 'libretranslate',
          translationUrl: 'http://libretranslate:5000',
          translationApiKey: 'secret-key',
          translationModel: '',
          translationOpenAiBaseUrl: '',
          translationDefaultLanguage: 'ja',
        };
        return map[key] ?? null;
      });

      const config = await translationService.getSettings();
      expect(config.enabled).toBe(true);
      expect(config.provider).toBe('libretranslate');
      expect(config.url).toBe('http://libretranslate:5000');
      expect(config.apiKey).toBe('secret-key');
      expect(config.targetLanguage).toBe('ja');
    });
  });

  describe('translate', () => {
    it('should skip non-conversational messages', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        if (key === 'translationUrl') return 'http://libretranslate:5000/translate';
        return null;
      });

      const result = await translationService.translate({
        text: 'ping',
        targetLang: 'es',
      });

      expect(result.skipped).toBe(true);
      expect(result.translatedText).toBe('ping');
    });

    it('should translate using LibreTranslate provider with bare origin URL', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        if (key === 'translationUrl') return 'http://libretranslate:5000';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Hola mundo',
          detectedLanguage: { language: 'en', confidence: 99 },
        }),
      } as unknown as Response);

      const result = await translationService.translate({
        text: 'Hello world',
        targetLang: 'es',
      });

      expect(result.translatedText).toBe('Hola mundo');
      expect(result.targetLanguage).toBe('es');
      expect(result.provider).toBe('libretranslate');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://libretranslate:5000/translate',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should translate using LibreTranslate provider with blank URL (using default endpoint)', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        if (key === 'translationUrl') return '';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Hola mundo',
          detectedLanguage: { language: 'en', confidence: 99 },
        }),
      } as unknown as Response);

      const result = await translationService.translate({
        text: 'Hello world',
        targetLang: 'es',
      });

      expect(result.translatedText).toBe('Hola mundo');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://libretranslate:5000/translate',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should translate using OpenAI-compatible provider', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'openai';
        if (key === 'translationOpenAiBaseUrl') return 'http://localhost:11434/v1';
        if (key === 'translationModel') return 'llama3';
        if (key === 'translationApiKey') return 'sk-test';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: 'こんにちは世界',
              },
            },
          ],
        }),
      } as unknown as Response);

      const result = await translationService.translate({
        text: 'Hello world',
        targetLang: 'ja',
      });

      expect(result.translatedText).toBe('こんにちは世界');
      expect(result.provider).toBe('openai');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer sk-test',
          }),
        })
      );
    });

    it('should translate using DeepL provider and auto-route to free endpoint when URL is blank', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'deepl';
        if (key === 'translationApiKey') return 'deepl-api-key:fx';
        if (key === 'translationDeeplUrl') return '';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [
            {
              detected_source_language: 'EN',
              text: 'Bonjour le monde',
            },
          ],
        }),
      } as unknown as Response);

      const result = await translationService.translate({
        text: 'Hello world',
        targetLang: 'fr',
      });

      expect(result.translatedText).toBe('Bonjour le monde');
      expect(result.provider).toBe('deepl');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api-free.deepl.com/v2/translate',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should use custom DeepL URL when provided', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'deepl';
        if (key === 'translationApiKey') return 'deepl-api-key';
        if (key === 'translationDeeplUrl') return 'https://my-proxy.internal/v2';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [{ text: 'Bonjour', detected_source_language: 'EN' }],
        }),
      } as unknown as Response);

      await translationService.translate({
        text: 'Hello',
        targetLang: 'fr',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://my-proxy.internal/v2/translate',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should use Pro DeepL endpoint for non-:fx keys when URL is blank', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'deepl';
        if (key === 'translationApiKey') return 'deepl-pro-api-key';
        if (key === 'translationDeeplUrl') return null;
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [{ text: 'Bonjour', detected_source_language: 'EN' }],
        }),
      } as unknown as Response);

      await translationService.translate({
        text: 'Hello',
        targetLang: 'fr',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.deepl.com/v2/translate',
        expect.objectContaining({
          method: 'POST',
        })
      );
    });

    it('should translate using Google Cloud Translation API', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'google';
        if (key === 'translationApiKey') return 'google-api-key';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            translations: [
              {
                translatedText: 'Hallo Welt',
                detectedSourceLanguage: 'en',
              },
            ],
          },
        }),
      } as unknown as Response);

      const result = await translationService.translate({
        text: 'Hello world',
        targetLang: 'de',
      });

      expect(result.translatedText).toBe('Hallo Welt');
      expect(result.provider).toBe('google');
    });

    it('should throw error when translation is not enabled and no explicit override provided', async () => {
      vi.mocked(databaseService.getSettingAsync).mockResolvedValue('false');

      await expect(
        translationService.translate({
          text: 'Hello world',
          targetLang: 'es',
        })
      ).rejects.toThrow('Translation is not enabled');
    });
  });

  describe('caching behavior', () => {
    class InMemoryTranslationCache implements ITranslationCache {
      private store = new Map<string, CachedTranslation>();

      private keyToString(key: TranslationCacheKey): string {
        return `${key.sourceLanguage || 'auto'}:${key.targetLanguage}:${key.text}`;
      }

      async get(key: TranslationCacheKey): Promise<CachedTranslation | null> {
        return this.store.get(this.keyToString(key)) || null;
      }

      async set(key: TranslationCacheKey, translation: CachedTranslation): Promise<void> {
        this.store.set(this.keyToString(key), translation);
      }

      async has(key: TranslationCacheKey): Promise<boolean> {
        return this.store.has(this.keyToString(key));
      }

      async clear(): Promise<void> {
        this.store.clear();
      }
    }

    let memoryCache: InMemoryTranslationCache;

    beforeEach(() => {
      memoryCache = new InMemoryTranslationCache();
      setTranslationCache(memoryCache);
    });

    it('should short-circuit and throw when translation is globally disabled even if cached entry exists', async () => {
      // Pre-seed cache with an existing translation
      await memoryCache.set(
        { text: 'Hello', targetLanguage: 'es', sourceLanguage: 'auto' },
        {
          translatedText: 'Hola',
          sourceText: 'Hello',
          targetLanguage: 'es',
          provider: 'libretranslate',
          cachedAt: Date.now(),
        }
      );

      // Translation is disabled globally
      vi.mocked(databaseService.getSettingAsync).mockResolvedValue('false');

      await expect(
        translationService.translate({
          text: 'Hello',
          targetLang: 'es',
        })
      ).rejects.toThrow('Translation is not enabled');
    });

    it('should bypass cache on read and write during testConfig calls', async () => {
      // Pre-seed cache with stale translation
      await memoryCache.set(
        { text: 'Hello', targetLanguage: 'es', sourceLanguage: 'en' },
        {
          translatedText: 'Stale Cached Hola',
          sourceText: 'Hello',
          targetLanguage: 'es',
          provider: 'libretranslate',
          cachedAt: Date.now(),
        }
      );

      // Mock live fetch to return fresh translation
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Fresh Live Hola',
        }),
      } as unknown as Response);

      const result = await translationService.testConfig({
        provider: 'libretranslate',
        url: 'http://libretranslate:5000',
        sourceLanguage: 'en',
        targetLanguage: 'es',
      });

      // Test calls must return fresh live data, not cached
      expect(result.translatedText).toBe('Fresh Live Hola');
      expect(result.provider).toBe('libretranslate');
      expect(global.fetch).toHaveBeenCalled();

    });

    it('should return cached translation on cache hit without making provider network call', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        return null;
      });

      await memoryCache.set(
        { text: 'Hello world', targetLanguage: 'es', sourceLanguage: 'auto' },
        {
          translatedText: 'Hola mundo (cached)',
          sourceText: 'Hello world',
          targetLanguage: 'es',
          detectedSourceLanguage: 'en',
          provider: 'libretranslate',
          cachedAt: Date.now(),
        }
      );

      global.fetch = vi.fn();

      const result = await translationService.translate({
        text: 'Hello world',
        targetLang: 'es',
      }, { useCache: true });

      expect(result.cached).toBe(true);
      expect(result.translatedText).toBe('Hola mundo (cached)');
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('should store translated result in cache on cache miss', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        if (key === 'translationUrl') return 'http://libretranslate:5000/translate';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Bonjour le monde',
          detectedLanguage: { language: 'en', confidence: 99 },
        }),
      } as unknown as Response);

      const result = await translationService.translate({
        text: 'Hello world',
        targetLang: 'fr',
      }, { useCache: true });

      expect(result.translatedText).toBe('Bonjour le monde');

      const cached = await memoryCache.get({
        text: 'Hello world',
        targetLanguage: 'fr',
        sourceLanguage: 'auto',
      });
      expect(cached?.translatedText).toBe('Bonjour le monde');
      expect(cached?.provider).toBe('libretranslate');
    });

    it('should complete a full roundtrip: miss fetches from network and caches, subsequent request hits cache', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        if (key === 'translationUrl') return 'http://libretranslate:5000/translate';
        return null;
      });

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Ciao mondo',
          detectedLanguage: { language: 'en', confidence: 99 },
        }),
      } as unknown as Response);

      // 1. First call: Cache miss -> executes live fetch and caches
      const firstResult = await translationService.translate({
        text: 'Hello world',
        targetLang: 'it',
      }, { useCache: true });

      expect(firstResult.cached).toBe(false);
      expect(firstResult.translatedText).toBe('Ciao mondo');
      expect(global.fetch).toHaveBeenCalledTimes(1);

      // 2. Second call: Cache hit -> returns cached without additional fetch
      const secondResult = await translationService.translate({
        text: 'Hello world',
        targetLang: 'it',
      }, { useCache: true });

      expect(secondResult.cached).toBe(true);
      expect(secondResult.translatedText).toBe('Ciao mondo');
      expect(global.fetch).toHaveBeenCalledTimes(1); // Still only 1 call
    });
  
    it('free-text translations (no useCache) neither read nor write the shared cache (#5520)', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        if (key === 'translationUrl') return 'http://libretranslate:5000/translate';
        return null;
      });
      await memoryCache.set(
        { text: 'Hello world', targetLanguage: 'es', sourceLanguage: 'auto' },
        { translatedText: 'cached', sourceText: 'Hello world', targetLanguage: 'es', provider: 'libretranslate', cachedAt: 1 }
      );
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ translatedText: 'Hola mundo' }),
      } as unknown as Response);

      const res = await translationService.translate({ text: 'Hello world', targetLang: 'es' });
      expect(res.cached).toBe(false);
      expect(res.translatedText).toBe('Hola mundo');
      expect(global.fetch).toHaveBeenCalledTimes(1);

      await translationService.translate({ text: 'Draft text', targetLang: 'fr' });
      expect(await memoryCache.has({ text: 'Draft text', targetLanguage: 'fr', sourceLanguage: 'auto' })).toBe(false);
    });

    it('translateMessage caches and links the stored text; skipped results are not linked (#5520)', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'libretranslate';
        if (key === 'translationUrl') return 'http://libretranslate:5000/translate';
        return null;
      });
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ translatedText: 'Good morning' }),
      } as unknown as Response);

      const res = await translationService.translateMessage({
        sourceId: 'src-a', messageId: 'm1', text: 'Guten Morgen', targetLang: 'EN',
      });
      expect(res.translatedText).toBe('Good morning');
      expect(await memoryCache.has({ text: 'Guten Morgen', targetLanguage: 'EN', sourceLanguage: 'auto' })).toBe(true);
      expect((databaseService as any).translations.linkMessage).toHaveBeenCalledWith(
        'src-a', 'm1', 'en', computeTranslationCacheKey('Guten Morgen', 'en'),
      );

      vi.mocked((databaseService as any).translations.linkMessage).mockClear();
      const skipped = await translationService.translateMessage({ sourceId: 'src-a', messageId: 'm2', text: 'ping' });
      expect(skipped.skipped).toBe(true);
      expect((databaseService as any).translations.linkMessage).not.toHaveBeenCalled();
    });
  });



  describe('testConfig', () => {
    it('should test LibreTranslate successfully', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Hola',
        }),
      } as unknown as Response);

      const result = await translationService.testConfig({
        provider: 'libretranslate',
        url: 'http://libretranslate:5000',
        targetLanguage: 'es',
        sourceLanguage: 'en',
      });

      expect(result.translatedText).toBe('Hola');
      expect(result.provider).toBe('libretranslate');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://libretranslate:5000/translate',
        expect.objectContaining({
          body: expect.stringContaining('MeshMonitor test message for radio translation.'),
        })
      );
    });

    it('should swap in default sample text if custom test text exceeds 5000 characters', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Hola',
        }),
      } as unknown as Response);

      const longText = 'a'.repeat(6000);
      const result = await translationService.testConfig({
        provider: 'libretranslate',
        url: 'http://libretranslate:5000',
        targetLanguage: 'es',
        sourceLanguage: 'en',
        text: longText,
      });

      expect(result.translatedText).toBe('Hola');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://libretranslate:5000/translate',
        expect.objectContaining({
          body: expect.stringContaining('MeshMonitor test message for radio translation.'),
        })
      );
    });
  });

  describe('getLanguages', () => {
    it('should return standard languages', async () => {
      const languages = await translationService.getLanguages();
      expect(languages.length).toBeGreaterThan(10);
      expect(languages.some((l) => l.code === 'en')).toBe(true);
      expect(languages.some((l) => l.code === 'ja')).toBe(true);
    });
  });
});


