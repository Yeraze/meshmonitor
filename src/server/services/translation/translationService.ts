/**
 * Translation Service
 *
 * Handles chat message translation using configurable providers:
 * - LibreTranslate (Self-hosted or hosted)
 * - OpenAI-Compatible Endpoints (Ollama, OpenRouter, OpenAI, etc.)
 * - DeepL (Free / Pro API)
 * - Google Cloud Translation API
 *
 * Integrates with ITranslationCache abstraction (NoOpTranslationCache by default).
 */

import databaseService from '../../../services/database.js';
import { isEmoji } from '../../../utils/text.js';
import { getTranslationCache, type TranslationCacheKey } from './translationCache.js';
import { STANDARD_LANGUAGES, type TranslationLanguageOption } from '../../../types/translation.js';

export type TranslationProvider = 'libretranslate' | 'openai' | 'deepl' | 'google';

export interface TranslationOptions {
  text: string;
  targetLang?: string;
  sourceLang?: string;
  provider?: TranslationProvider;
  url?: string;
  apiKey?: string;
  model?: string;
  openAiBaseUrl?: string;
}

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
  sourceText: string;
  targetLanguage: string;
  cached?: boolean;
  provider: string;
  skipped?: boolean;
  skipReason?: string;
}

export type LanguageOption = TranslationLanguageOption;
export { STANDARD_LANGUAGES };

/**
 * Filter out raw telemetry packets, standard radio tests, and emoji-only messages
 * to avoid unnecessary API calls and weird translation artifacts.
 */
export function isNonConversational(text: string): boolean {
  if (!text || !text.trim()) {
    return true;
  }

  const trimmed = text.trim();

  // Emoji only
  if (isEmoji(trimmed)) {
    return true;
  }

  // Standard radio / LoRa test words (case-insensitive, with optional trailing punctuation)
  const cleaned = trimmed.replace(/[!?.#]+$/, '');
  const radioPings = /^(?:ack|ping|pong|73|73s|test|testing|k|ok|cq|sos|rgr|roger|qsl)$/i;
  if (radioPings.test(cleaned)) {
    return true;
  }

  // JSON or raw telemetry structure (or arrays)
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return true;
  }

  // Common raw telemetry prefixes
  const telemetryPrefix = /^(?:bat:|seq:|temp:|hum:|baro:|lat:|lon:|pos:|gps:|snr:|rssi:)/i;
  if (telemetryPrefix.test(trimmed)) {
    return true;
  }

  return false;
}

export class TranslationService {
  /**
   * Retrieves current translation configuration from database settings.
   */
  async getSettings() {
    const enabledRaw = await databaseService.getSettingAsync('translationEnabled');
    const enabled = enabledRaw === 'true' || enabledRaw === '1';
    const provider = ((await databaseService.getSettingAsync('translationProvider')) as TranslationProvider) || 'libretranslate';
    const url = (await databaseService.getSettingAsync('translationUrl')) || '';
    const apiKey = (await databaseService.getSettingAsync('translationApiKey')) || '';
    const model = (await databaseService.getSettingAsync('translationModel')) || '';
    const openAiBaseUrl = (await databaseService.getSettingAsync('translationOpenAiBaseUrl')) || '';
    const defaultLanguage = (await databaseService.getSettingAsync('translationDefaultLanguage')) || 'en';
    const defaultOutgoingLanguage = (await databaseService.getSettingAsync('translationDefaultOutgoingLanguage')) || 'ja';

    return {
      enabled,
      provider,
      url,
      apiKey,
      model,
      openAiBaseUrl,
      targetLanguage: defaultLanguage,
      defaultOutgoingLanguage,
      sourceLanguage: 'auto',
      autoIncoming: false,
    };
  }

  /**
   * Returns list of supported standard languages.
   */
  async getLanguages() {
    return STANDARD_LANGUAGES;
  }

  /**
   * Tests a specific translation provider configuration.
   */
  async testConfig(config: {
    provider: TranslationProvider;
    url?: string;
    apiKey?: string;
    model?: string;
    openAiBaseUrl?: string;
    targetLanguage?: string;
    sourceLanguage?: string;
  }): Promise<{ success: boolean; message: string; translatedText?: string; detectedSourceLanguage?: string }> {
    const testText = 'Hello';
    try {
      const res = await this.translate({
        text: testText,
        sourceLang: config.sourceLanguage || 'en',
        targetLang: config.targetLanguage || 'es',
        provider: config.provider,
        url: config.url,
        apiKey: config.apiKey,
        model: config.model,
        openAiBaseUrl: config.openAiBaseUrl,
      });

      if (res.translatedText) {
        return {
          success: true,
          message: `Connection successful (${config.provider})`,
          translatedText: res.translatedText,
          detectedSourceLanguage: res.detectedSourceLanguage,
        };
      }
      return {
        success: false,
        message: res.skipReason || 'No translation returned',
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: msg || 'Connection failed',
      };
    }
  }

  /**
   * Translates a message using configured provider or explicit options.
   */
  async translate(options: TranslationOptions): Promise<TranslationResult> {
    const { text } = options;

    if (!text || !text.trim()) {
      return {
        translatedText: '',
        sourceText: text || '',
        targetLanguage: options.targetLang || 'en',
        provider: 'none',
        skipped: true,
        skipReason: 'empty_text',
      };
    }

    if (text.length > 5000) {
      throw new Error('Message text exceeds maximum length of 5000 characters');
    }

    // Check if message is non-conversational (ping, telemetry, emoji)
    if (isNonConversational(text)) {
      return {
        translatedText: text,
        sourceText: text,
        targetLanguage: options.targetLang || 'en',
        provider: 'passthrough',
        skipped: true,
        skipReason: 'non_conversational',
      };
    }

    // Resolve settings
    const settings = await this.getSettings();
    const isGlobalEnabled = settings.enabled;

    // Determine target language and provider
    let targetLang = (options.targetLang || settings.targetLanguage || 'en').trim();
    const sourceLang = (options.sourceLang || 'auto').trim();
    const provider = (options.provider || settings.provider || 'libretranslate') as TranslationProvider;

    const cacheKey: TranslationCacheKey = {
      text,
      targetLanguage: targetLang,
      sourceLanguage: sourceLang,
    };

    // Check cache
    const cache = getTranslationCache();
    const cached = await cache.get(cacheKey);
    if (cached) {
      return {
        translatedText: cached.translatedText,
        detectedSourceLanguage: cached.detectedSourceLanguage,
        sourceText: text,
        targetLanguage: targetLang,
        cached: true,
        provider: cached.provider || provider,
      };
    }

    // If translation is globally disabled and no explicit provider config passed (not a test call)
    if (!isGlobalEnabled && !options.provider && !options.url && !options.apiKey) {
      throw new Error('Translation is not enabled');
    }

    // Execute translation based on provider
    let result: { translatedText: string; detectedSourceLanguage?: string };

    const executeProvider = async (tLang: string, sLang: string) => {
      switch (provider) {
        case 'libretranslate':
          return this.translateWithLibreTranslate(text, sLang, tLang, {
            url: options.url || settings.url || 'http://libretranslate:5000',
            apiKey: options.apiKey || settings.apiKey || '',
          });
        case 'openai':
          return this.translateWithOpenAI(text, sLang, tLang, {
            baseUrl: options.openAiBaseUrl || settings.openAiBaseUrl || 'http://host.docker.internal:11434/v1',
            apiKey: options.apiKey || settings.apiKey || '',
            model: options.model || settings.model || 'gpt-4o-mini',
          });
        case 'deepl':
          return this.translateWithDeepL(text, sLang, tLang, {
            apiKey: options.apiKey || settings.apiKey || '',
            url: options.url || settings.url || '',
          });
        case 'google':
          return this.translateWithGoogle(text, sLang, tLang, {
            apiKey: options.apiKey || settings.apiKey || '',
          });
        default:
          throw new Error(`Unsupported translation provider: ${provider}`);
      }
    };

    result = await executeProvider(targetLang, sourceLang);

    // If no explicit target was requested and detected source matches the primary target language,
    // automatically flip to the default outgoing/foreign language (e.g. English -> Japanese).
    if (
      !options.targetLang &&
      result.detectedSourceLanguage &&
      result.detectedSourceLanguage.toLowerCase() === targetLang.toLowerCase() &&
      settings.defaultOutgoingLanguage &&
      settings.defaultOutgoingLanguage.toLowerCase() !== targetLang.toLowerCase()
    ) {
      const altTarget = settings.defaultOutgoingLanguage.toLowerCase();
      const altResult = await executeProvider(altTarget, result.detectedSourceLanguage);
      if (altResult.translatedText) {
        result = altResult;
        targetLang = altTarget;
      }
    }

    // Store in cache
    await cache.set(cacheKey, {
      translatedText: result.translatedText,
      detectedSourceLanguage: result.detectedSourceLanguage,
      sourceText: text,
      targetLanguage: targetLang,
      provider,
      cachedAt: Date.now(),
    });

    return {
      translatedText: result.translatedText,
      detectedSourceLanguage: result.detectedSourceLanguage,
      sourceText: text,
      targetLanguage: targetLang,
      cached: false,
      provider,
    };
  }

  /**
   * LibreTranslate backend
   */
  private async translateWithLibreTranslate(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: { url: string; apiKey?: string }
  ): Promise<{ translatedText: string; detectedSourceLanguage?: string }> {
    const baseUrl = (config.url || 'http://libretranslate:5000').replace(/\/+$/, '');
    const endpoint = `${baseUrl}/translate`;

    const body: Record<string, unknown> = {
      q: text,
      source: !sourceLang || sourceLang === 'auto' ? 'auto' : sourceLang,
      target: targetLang,
      format: 'text',
    };

    if (config.apiKey && config.apiKey.trim()) {
      body.api_key = config.apiKey.trim();
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`LibreTranslate error (${response.status}): ${errText || response.statusText}`);
    }

    const data = await response.json() as {
      translatedText?: string;
      detectedLanguage?: { confidence?: number; language?: string };
    };

    if (!data.translatedText && data.translatedText !== '') {
      throw new Error('LibreTranslate returned empty or invalid response');
    }

    return {
      translatedText: data.translatedText,
      detectedSourceLanguage: data.detectedLanguage?.language,
    };
  }

  /**
   * OpenAI-compatible endpoint (Ollama, OpenRouter, OpenAI, vLLM, etc.)
   */
  private async translateWithOpenAI(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: { baseUrl: string; apiKey?: string; model?: string }
  ): Promise<{ translatedText: string; detectedSourceLanguage?: string }> {
    const baseUrl = (config.baseUrl || 'http://host.docker.internal:11434/v1').replace(/\/+$/, '');
    const endpoint = `${baseUrl}/chat/completions`;
    const model = config.model || 'gpt-4o-mini';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey && config.apiKey.trim()) {
      headers.Authorization = `Bearer ${config.apiKey.trim()}`;
    }

    const systemPrompt = `You are an expert translator for LoRa mesh and radio chat messages.
Translate the user's message accurately${sourceLang && sourceLang !== 'auto' ? ` from "${sourceLang}"` : ''} into the target language: "${targetLang}".
Guidelines:
1. Preserve callsigns, node tags (e.g. !1234abcd), numbers, radio abbreviations, and emoji.
2. Keep the output as concise as possible to respect LoRa packet constraints.
3. Return ONLY the translated text with NO quotation marks, markdown wrappers, introductory notes, or commentary.`;

    const body = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      temperature: 0.1,
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`OpenAI-compatible endpoint error (${response.status}): ${errText || response.statusText}`);
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error('OpenAI endpoint returned an invalid response structure');
    }

    return {
      translatedText: content.trim(),
    };
  }

  /**
   * DeepL API
   */
  private async translateWithDeepL(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: { apiKey: string; url?: string }
  ): Promise<{ translatedText: string; detectedSourceLanguage?: string }> {
    if (!config.apiKey || !config.apiKey.trim()) {
      throw new Error('DeepL API key is required');
    }

    const key = config.apiKey.trim();
    let endpoint = config.url?.trim();
    if (!endpoint) {
      endpoint = key.endsWith(':fx')
        ? 'https://api-free.deepl.com/v2/translate'
        : 'https://api.deepl.com/v2/translate';
    }

    const body: Record<string, unknown> = {
      text: [text],
      target_lang: targetLang.toUpperCase(),
    };

    if (sourceLang && sourceLang !== 'auto') {
      body.source_lang = sourceLang.toUpperCase();
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`DeepL API error (${response.status}): ${errText || response.statusText}`);
    }

    const data = await response.json() as {
      translations?: Array<{ text: string; detected_source_language?: string }>;
    };

    const first = data.translations?.[0];
    if (!first) {
      throw new Error('DeepL returned an empty translations array');
    }

    return {
      translatedText: first.text,
      detectedSourceLanguage: first.detected_source_language?.toLowerCase(),
    };
  }

  /**
   * Google Cloud Translation API
   */
  private async translateWithGoogle(
    text: string,
    sourceLang: string,
    targetLang: string,
    config: { apiKey: string }
  ): Promise<{ translatedText: string; detectedSourceLanguage?: string }> {
    if (!config.apiKey || !config.apiKey.trim()) {
      throw new Error('Google Cloud Translation API key is required');
    }

    const key = encodeURIComponent(config.apiKey.trim());
    const endpoint = `https://translation.googleapis.com/language/translate/v2?key=${key}`;

    const body: Record<string, unknown> = {
      q: text,
      target: targetLang,
      format: 'text',
    };

    if (sourceLang && sourceLang !== 'auto') {
      body.source = sourceLang;
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Google Translation API error (${response.status}): ${errText || response.statusText}`);
    }

    const data = await response.json() as {
      data?: {
        translations?: Array<{ translatedText: string; detectedSourceLanguage?: string }>;
      };
    };

    const first = data.data?.translations?.[0];
    if (!first) {
      throw new Error('Google Translation API returned an empty response');
    }

    return {
      translatedText: first.translatedText,
      detectedSourceLanguage: first.detectedSourceLanguage?.toLowerCase(),
    };
  }
}

export const translationService = new TranslationService();
export default translationService;
