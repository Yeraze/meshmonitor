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
        provider.translate('Hello', 'en', 'nb', { apiKey: '' })
      ).rejects.toThrow('DeepL API key is required');
    });

    it('should automatically route to Free endpoint for :fx keys when deeplUrl is omitted/blank', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [{ text: 'Hallo verden', detected_source_language: 'EN' }],
        }),
      } as unknown as Response);

      await provider.translate('Hello world', 'auto', 'nb', { apiKey: 'test-key:fx' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api-free.deepl.com/v2/translate',
        expect.any(Object)
      );
    });

    it('should automatically route to Pro endpoint for non-:fx keys when deeplUrl is omitted/blank', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [{ text: 'Hallo verden', detected_source_language: 'EN' }],
        }),
      } as unknown as Response);

      await provider.translate('Hello world', 'auto', 'nb', { apiKey: 'pro-key' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.deepl.com/v2/translate',
        expect.any(Object)
      );
    });

    it('should use custom deeplUrl when provided (bare origin appends /v2/translate, /v1 and /v2 append /translate, custom path preserved)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translations: [{ text: 'Hallo verden', detected_source_language: 'EN' }],
        }),
      } as unknown as Response);

      // Bare origin (appends /v2/translate)
      await provider.translate('Hello world', 'auto', 'nb', {
        apiKey: 'pro-key',
        deeplUrl: 'https://custom-proxy.internal',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom-proxy.internal/v2/translate',
        expect.any(Object)
      );

      // /v1 base (appends /translate)
      await provider.translate('Hello world', 'auto', 'nb', {
        apiKey: 'pro-key',
        deeplUrl: 'https://custom-proxy.internal/v1',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom-proxy.internal/v1/translate',
        expect.any(Object)
      );

      // /v2 base (appends /translate)
      await provider.translate('Hello world', 'auto', 'nb', {
        apiKey: 'pro-key',
        deeplUrl: 'https://custom-proxy.internal/v2',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom-proxy.internal/v2/translate',
        expect.any(Object)
      );

      // Full / custom path (preserved verbatim)
      await provider.translate('Hello world', 'auto', 'nb', {
        apiKey: 'pro-key',
        deeplUrl: 'https://custom-proxy.internal/v1/translate',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom-proxy.internal/v1/translate',
        expect.any(Object)
      );

      await provider.translate('Hello world', 'auto', 'nb', {
        apiKey: 'pro-key',
        deeplUrl: 'https://custom-proxy.internal/custom/endpoint',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom-proxy.internal/custom/endpoint',
        expect.any(Object)
      );
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

    it('should fall back to statusText on non-ok HTTP response when text() fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        statusText: 'Bad Gateway',
        text: vi.fn().mockRejectedValue(new Error('stream error')),
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'es', {
          apiKey: 'test-key:fx',
          deeplUrl: 'https://api-free.deepl.com/v2/translate',
        })
      ).rejects.toThrow('DeepL API error (502): Bad Gateway');
    });

    it('should throw error when translations array is empty', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ translations: [] }),
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'es', {
          apiKey: 'test-key:fx',
          deeplUrl: 'https://api-free.deepl.com/v2/translate',
        })
      ).rejects.toThrow('DeepL returned an empty translations array');
    });
  });

  describe('LibreTranslateProvider', () => {
    const provider = new LibreTranslateProvider();

    it('should translate using default URL when url config is omitted or empty', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Hei verden',
          detectedLanguage: { language: 'en', confidence: 99 },
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'auto', 'nb', {});

      expect(res.translatedText).toBe('Hei verden');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://libretranslate:5000/translate',
        expect.any(Object)
      );
    });

    it('should translate using custom URL (bare origin appends /translate, /v1, /v2, and custom paths preserved verbatim)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          translatedText: 'Hei verden',
          detectedLanguage: { language: 'en', confidence: 99 },
        }),
      } as unknown as Response);

      // Bare origin (appends /translate)
      const res = await provider.translate('Hello world', 'auto', 'nb', {
        url: 'http://custom-libre:5000',
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

      // /v1 base (verbatim for LibreTranslate)
      await provider.translate('Hello world', 'auto', 'nb', {
        url: 'http://custom-libre:5000/v1',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-libre:5000/v1',
        expect.any(Object)
      );

      // /v2 base (verbatim for LibreTranslate)
      await provider.translate('Hello world', 'auto', 'nb', {
        url: 'http://custom-libre:5000/v2',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-libre:5000/v2',
        expect.any(Object)
      );

      // Full / custom path (verbatim)
      await provider.translate('Hello world', 'auto', 'nb', {
        url: 'http://custom-libre:5000/translate',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-libre:5000/translate',
        expect.any(Object)
      );

      await provider.translate('Hello world', 'auto', 'nb', {
        url: 'http://custom-libre:5000/custom/api',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'http://custom-libre:5000/custom/api',
        expect.any(Object)
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

    it('should fall back to statusText on non-ok HTTP response when text() fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        text: vi.fn().mockRejectedValue(new Error('stream error')),
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { url: 'http://libretranslate:5000/translate' })
      ).rejects.toThrow('LibreTranslate error (503): Service Unavailable');
    });

    it('should throw error when translatedText is missing from response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: 'Invalid input' }),
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { url: 'http://libretranslate:5000/translate' })
      ).rejects.toThrow('LibreTranslate returned empty or invalid response');
    });
  });

  describe('OpenAIProvider', () => {
    const provider = new OpenAIProvider();

    it('should format request with default endpoint when openAiBaseUrl is omitted or empty', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hei verden' } }],
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'en', 'nb', {});

      expect(res.translatedText).toBe('Hei verden');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://host.docker.internal:11434/v1/chat/completions',
        expect.any(Object)
      );
    });

    it('should format request and return translation content with custom base URL (/v1 appends /chat/completions)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hei verden' } }],
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'en', 'nb', {
        openAiBaseUrl: 'http://host.docker.internal:11434/v1',
        model: 'llama3',
        apiKey: 'ollama-key',
      });

      expect(res.translatedText).toBe('Hei verden');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://host.docker.internal:11434/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer ollama-key',
          }),
        })
      );
    });

    it('should format request and return translation content with bare origin (appends /v1/chat/completions)', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hei verden' } }],
        }),
      } as unknown as Response);

      const res = await provider.translate('Hello world', 'en', 'nb', {
        openAiBaseUrl: 'http://localhost:11434',
        model: 'llama3',
      });

      expect(res.translatedText).toBe('Hei verden');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/v1/chat/completions',
        expect.any(Object)
      );
    });

    it('should append /chat/completions for /v2 base URL', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hei verden' } }],
        }),
      } as unknown as Response);

      await provider.translate('Hello world', 'en', 'nb', {
        openAiBaseUrl: 'http://localhost:11434/v2',
        model: 'llama3',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:11434/v2/chat/completions',
        expect.any(Object)
      );
    });

    it('should preserve full or custom endpoint paths verbatim', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: 'Hei verden' } }],
        }),
      } as unknown as Response);

      await provider.translate('Hello world', 'en', 'nb', {
        openAiBaseUrl: 'https://api.openai.com/v1/chat/completions',
        model: 'gpt-4o',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.any(Object)
      );

      await provider.translate('Hello world', 'en', 'nb', {
        openAiBaseUrl: 'https://custom.proxy/api/v1',
        model: 'custom-model',
      });
      expect(global.fetch).toHaveBeenCalledWith(
        'https://custom.proxy/api/v1',
        expect.any(Object)
      );
    });

    it('should throw descriptive error on non-ok HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => 'Incorrect API key',
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { openAiBaseUrl: 'http://host:11434/v1/chat/completions' })
      ).rejects.toThrow('OpenAI-compatible endpoint error (401): Incorrect API key');
    });

    it('should fall back to statusText on non-ok HTTP response when text() fails', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        text: vi.fn().mockRejectedValue(new Error('stream error')),
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { openAiBaseUrl: 'http://host:11434/v1/chat/completions' })
      ).rejects.toThrow('OpenAI-compatible endpoint error (500): Internal Error');
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

    it('should throw error when message content is not a string', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: {} }] }),
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

    it('should translate using Google Cloud Translation API with auto source detection (omitting source parameter)', async () => {
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
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: 'Hello world',
            target: 'nb',
            format: 'text',
          }),
        })
      );
    });

    it('should include source parameter when explicit source language is provided', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: {
            translations: [{ translatedText: 'Hello world' }],
          },
        }),
      } as unknown as Response);

      const res = await provider.translate('Hola mundo', 'es', 'en', { apiKey: 'google-key' });

      expect(res.translatedText).toBe('Hello world');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://translation.googleapis.com/language/translate/v2?key=google-key',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            q: 'Hola mundo',
            target: 'en',
            format: 'text',
            source: 'es',
          }),
        })
      );
    });

    it('should throw descriptive error on non-ok HTTP response', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => 'API key not valid',
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { apiKey: 'google-key' })
      ).rejects.toThrow('Google Translation API error (403): API key not valid');
    });

    it('should throw error when data.translations is empty', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { translations: [] } }),
      } as unknown as Response);

      await expect(
        provider.translate('Hello', 'auto', 'nb', { apiKey: 'google-key' })
      ).rejects.toThrow('Google Translation API returned an empty response');
    });
  });
});
