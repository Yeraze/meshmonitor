import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  isNonConversational,
  buildServiceEndpoint,
  translationService,
} from './translationService.js';
import { NoOpTranslationCache, setTranslationCache } from './translationCache.js';

vi.mock('../../../services/database.js', () => ({
  default: {
    getSettingAsync: vi.fn(),
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

    it('should append path when not present on baseUrl', () => {
      expect(buildServiceEndpoint('https://api.deepl.com/v2', 'default', '/translate')).toBe('https://api.deepl.com/v2/translate');
      expect(buildServiceEndpoint('https://api.deepl.com/v2/', 'default', '/translate')).toBe('https://api.deepl.com/v2/translate');
    });

    it('should not double-append path when already present on baseUrl', () => {
      expect(buildServiceEndpoint('https://api.deepl.com/v2/translate', 'default', '/translate')).toBe('https://api.deepl.com/v2/translate');
      expect(buildServiceEndpoint('https://api.deepl.com/v2/translate/', 'default', '/translate')).toBe('https://api.deepl.com/v2/translate');
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
        if (key === 'translationUrl') return 'http://libretranslate:5000';
        return null;
      });

      const result = await translationService.translate({
        text: 'ping',
        targetLang: 'es',
      });

      expect(result.skipped).toBe(true);
      expect(result.translatedText).toBe('ping');
    });

    it('should translate using LibreTranslate provider', async () => {
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

    it('should translate using DeepL provider', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'deepl';
        if (key === 'translationApiKey') return 'deepl-api-key:fx';
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

    it('should use custom DeepL base URL and append /translate when provided', async () => {
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

    it('should use Pro DeepL endpoint for non-:fx keys when no URL is provided', async () => {
      vi.mocked(databaseService.getSettingAsync).mockImplementation(async (key: string) => {
        if (key === 'translationEnabled') return 'true';
        if (key === 'translationProvider') return 'deepl';
        if (key === 'translationApiKey') return 'deepl-pro-api-key';
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

      expect(result.success).toBe(true);
      expect(result.translatedText).toBe('Hola');
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
