import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getTranslationProvider,
  buildServiceEndpoint,
  LibreTranslateProvider,
  DeepLProvider,
  OpenAIProvider,
  GoogleProvider,
} from './index.js';

describe('Translation Providers', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('getTranslationProvider', () => {
    it('should return the corresponding provider instance for valid identifiers', () => {
      expect(getTranslationProvider('libretranslate')).toBeInstanceOf(LibreTranslateProvider);
      expect(getTranslationProvider('deepl')).toBeInstanceOf(DeepLProvider);
      expect(getTranslationProvider('openai')).toBeInstanceOf(OpenAIProvider);
      expect(getTranslationProvider('google')).toBeInstanceOf(GoogleProvider);
    });

    it('should throw an error for unsupported provider identifiers', () => {
      expect(() => getTranslationProvider('unsupported' as unknown as any)).toThrow('Unsupported translation provider');
    });
  });

  describe('buildServiceEndpoint', () => {
    it('should return default fallback when url is empty or whitespace', () => {
      expect(buildServiceEndpoint('', 'http://default/v1', '/v1')).toBe('http://default/v1');
      expect(buildServiceEndpoint('   ', 'http://default/v1', '/v1')).toBe('http://default/v1');
    });

    it('should append path when not present on baseUrl', () => {
      expect(buildServiceEndpoint('http://localhost:5000', 'default', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('http://localhost:5000/', 'default', '/translate')).toBe('http://localhost:5000/translate');
    });

    it('should not double append path when already present', () => {
      expect(buildServiceEndpoint('http://localhost:5000/translate', 'default', '/translate')).toBe('http://localhost:5000/translate');
      expect(buildServiceEndpoint('http://localhost:5000/translate/', 'default', '/translate')).toBe('http://localhost:5000/translate');
    });
  });

  describe('DeepLProvider', () => {
    const provider = new DeepLProvider();

    it('should throw error when API key is missing', async () => {
      await expect(
        provider.translate('Hello', 'en', 'nb', { apiKey: '', deeplUrl: 'https://api-free.deepl.com/v2/translate' })
      ).rejects.toThrow('DeepL API key is required');
    });

    it('should throw error when endpoint URL is missing', async () => {
      await expect(
        provider.translate('Hello', 'en', 'nb', { apiKey: 'test-key', deeplUrl: '' })
      ).rejects.toThrow('DeepL endpoint URL is required');
    });

    it('should resolve endpoint automatically based on key or custom URL', () => {
      expect(provider.resolveEndpoint('', 'test-key:fx')).toBe('https://api-free.deepl.com/v2/translate');
      expect(provider.resolveEndpoint('', 'pro-key')).toBe('https://api.deepl.com/v2/translate');
      expect(provider.resolveEndpoint('https://custom-proxy.internal', 'pro-key')).toBe('https://custom-proxy.internal/translate');
      expect(provider.resolveEndpoint('https://custom-proxy.internal/v1/translate', 'pro-key')).toBe('https://custom-proxy.internal/v1/translate');
    });

    it('should map Norwegian nb and no to NB for target_lang', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [{ text: 'Hallo verden', detected_source_language: 'EN' }],
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'auto', 'nb', {
        apiKey: 'test-key:fx',
        deeplUrl: 'https://api-free.deepl.com/v2/translate',
      });

      expect(res.translatedText).toBe('Hallo verden');
      expect(res.detectedSourceLanguage).toBe('en');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api-free.deepl.com/v2/translate',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'DeepL-Auth-Key test-key:fx',
          }),
          body: JSON.stringify({
            text: ['Hello world'],
            target_lang: 'NB',
          }),
        })
      );
    });

    it('should map regional dialects for en (EN-US) and pt (PT-PT) target languages', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [{ text: 'Hello', detected_source_language: 'ES' }],
        }),
      } as unknown as Response);

      await provider.translate('Hola', 'es', 'en', {
        apiKey: 'test-key:fx',
        deeplUrl: 'https://api-free.deepl.com/v2/translate',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api-free.deepl.com/v2/translate',
        expect.objectContaining({
          body: JSON.stringify({
            text: ['Hola'],
            target_lang: 'EN-US',
            source_lang: 'ES',
          }),
        })
      );

      await provider.translate('Hola', 'es', 'pt', {
        apiKey: 'test-key:fx',
        deeplUrl: 'https://api-free.deepl.com/v2/translate',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api-free.deepl.com/v2/translate',
        expect.objectContaining({
          body: JSON.stringify({
            text: ['Hola'],
            target_lang: 'PT-PT',
            source_lang: 'ES',
          }),
        })
      );
    });

    it('should throw descriptive error on non-ok HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => '{"message":"Value for target_lang not supported"}',
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'invalid', {
          apiKey: 'test-key:fx',
          deeplUrl: 'https://api-free.deepl.com/v2/translate',
        })
      ).rejects.toThrow('DeepL API error (400): {"message":"Value for target_lang not supported"}');
    });
  });

  describe('LibreTranslateProvider', () => {
    const provider = new LibreTranslateProvider();

    it('should throw error when URL is missing', async () => {
      await expect(
        provider.translate('Hello', 'en', 'nb', { url: '' })
      ).rejects.toThrow('LibreTranslate URL is required');
    });

    it('should resolve endpoint with defaults and custom URLs', () => {
      expect(provider.resolveEndpoint('')).toBe('http://libretranslate:5000/translate');
      expect(provider.resolveEndpoint('http://custom-libre:5000')).toBe('http://custom-libre:5000/translate');
      expect(provider.resolveEndpoint('https://custom.internal/api/v1')).toBe('https://custom.internal/api/v1');
    });

    it('should translate using provided url and lowercase codes', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Hei verden',
          detectedLanguage: { language: 'en', confidence: 99 },
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'auto', 'nb', {
        url: 'http://custom-libre:5000/translate',
        apiKey: 'libre-key',
      });

      expect(res.translatedText).toBe('Hei verden');
      expect(res.detectedSourceLanguage).toBe('en');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-libre:5000/translate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            q: 'Hello world',
            source: 'auto',
            target: 'nb',
            format: 'text',
            api_key: 'libre-key',
          }),
        })
      );
    });

    it('should throw descriptive error on non-ok HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { url: 'http://libretranslate:5000/translate' })
      ).rejects.toThrow('LibreTranslate error (500): Server error');
    });
  });

  describe('OpenAIProvider', () => {
    const provider = new OpenAIProvider();

    it('should throw error when endpoint URL is missing', async () => {
      await expect(
        provider.translate('Hello', 'en', 'nb', { openAiBaseUrl: '' })
      ).rejects.toThrow('OpenAI endpoint URL is required');
    });

    it('should resolve endpoint with defaults and custom URLs', () => {
      expect(provider.resolveEndpoint('')).toBe('http://host.docker.internal:11434/v1/chat/completions');
      expect(provider.resolveEndpoint('http://host:11434')).toBe('http://host:11434/chat/completions');
      expect(provider.resolveEndpoint('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/chat/completions');
    });

    it('should format request and return translation content', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hei verden' } }],
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'en', 'nb', {
        openAiBaseUrl: 'http://ollama:11434/v1/chat/completions',
        model: 'llama3',
        apiKey: 'ollama-key',
      });

      expect(res.translatedText).toBe('Hei verden');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://ollama:11434/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer ollama-key',
          }),
        })
      );
    });

    it('should throw error when choices array is missing or invalid', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [] }),
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { openAiBaseUrl: 'http://host:11434/v1/chat/completions' })
      ).rejects.toThrow('OpenAI endpoint returned an invalid response structure');
    });
  });

  describe('GoogleProvider', () => {
    const provider = new GoogleProvider();

    it('should throw error when API key is missing', async () => {
      await expect(
        provider.translate('Hello', 'en', 'nb', { apiKey: '' })
      ).rejects.toThrow('Google Cloud Translation API key is required');
    });

    it('should translate using Google Cloud Translation API', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            translations: [{ translatedText: 'Hei verden', detectedSourceLanguage: 'en' }],
          },
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'auto', 'nb', { apiKey: 'google-key' });

      expect(res.translatedText).toBe('Hei verden');
      expect(res.detectedSourceLanguage).toBe('en');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://translation.googleapis.com/language/translate/v2?key=google-key',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            q: 'Hello world',
            target: 'nb',
            format: 'text',
          }),
        })
      );
    });
  });
});
